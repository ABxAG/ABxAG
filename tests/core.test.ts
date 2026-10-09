import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CancellationScope, CancelledError } from "../agent/cancellation";
import { TaskStore } from "../agent/taskSession";
import { InputArbiter, ResourceScheduler } from "../agent/scheduler";
import { PermissionEngine, migrateFromLegacyEnv } from "../permissions/engine";
import { ConfirmationBroker } from "../permissions/confirmations";
import { redact, redactText, summarizeArgs } from "../shared/redact";
import { SecretStore } from "../secrets/secretStore";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "abxag-core-"));
}

test("cancellation propagates to every descendant and aborts signals", async () => {
  const root = new CancellationScope("root");
  const task = root.child("task");
  const step = task.child("step");
  const model = step.child("model");
  let notified = "";
  model.onCancel((reason) => { notified = reason; });
  const sleeping = model.sleep(10_000);
  assert.equal(root.cancelChildren("user_stop"), 3);
  assert.equal(model.signal.aborted, true);
  assert.equal(notified, "user_stop");
  await assert.rejects(sleeping, CancelledError);
  // A child created from a cancelled scope is born cancelled.
  assert.equal(task.child("late").cancelled, true);
  assert.equal(root.cancelled, false);
});

test("task store enforces transitions and marks live sessions interrupted after a crash", async () => {
  const dir = tempDir();
  const store = new TaskStore({ dataDir: dir });
  await store.initialize();
  const session = store.create({ goal: "Download Blender", origin: "text" });
  store.transition(session.id, "planning", "Thinking…");
  store.transition(session.id, "running", "Opening browser…");
  assert.throws(() => store.transition(session.id, "queued"), /Invalid task transition/);
  const sensitive = store.create({ goal: "Send photo to Papa", origin: "voice", sensitive: true });
  store.transition(sensitive.id, "running");
  await store.flush();

  const restarted = new TaskStore({ dataDir: dir });
  await restarted.initialize();
  assert.equal(restarted.get(session.id)?.state, "interrupted");
  const recoverable = restarted.takeRecoverable();
  assert.deepEqual(recoverable.map((item) => item.id), [session.id], "sensitive sessions are never offered for resumption");
  assert.equal(restarted.takeRecoverable().length, 0);
});

test("resource scheduler grants exclusive leases in priority order and supports cancellation", async () => {
  const scheduler = new ResourceScheduler();
  const first = await scheduler.acquire("task:a", ["mouse", "keyboard"]);
  const order: string[] = [];
  const low = scheduler.acquire("task:low", ["mouse"], { priority: 1 }).then((lease) => { order.push("low"); lease.release(); });
  const high = scheduler.acquire("task:high", ["mouse"], { priority: 9 }).then((lease) => { order.push("high"); lease.release(); });
  const controller = new AbortController();
  const cancelled = scheduler.acquire("task:cancel", ["keyboard"], { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, CancelledError);
  first.release();
  await Promise.all([low, high]);
  assert.deepEqual(order, ["high", "low"]);
  assert.equal(scheduler.status().length, 0);
});

test("scheduler revokes everything owned by a stopped task", async () => {
  const scheduler = new ResourceScheduler();
  await scheduler.acquire("task:x:step", ["browser"]);
  const waiting = scheduler.acquire("task:x:next", ["browser"]);
  assert.equal(scheduler.revokeOwner("task:x"), 2);
  await assert.rejects(waiting, CancelledError);
  assert.equal(scheduler.status().length, 0);
});

test("input arbiter separates physical input from ABxAG's synthetic input", async () => {
  let now = 100_000;
  const arbiter = new InputArbiter(() => now);
  // Fallback mode: the OS idle timer reports input 200ms ago...
  arbiter.setOsIdleProbe(async () => 200);
  // ...which was ABxAG's own click.
  arbiter.markSynthetic(now - 400, now - 150);
  assert.equal((await arbiter.userActivity()).active, false);
  // Raw-input mode: deliberate pointer travel is strong activity.
  for (let i = 0; i < 6; i += 1) arbiter.recordPhysicalInput({ kind: "mouse", at: now - 100 * i, distance: 120 });
  const verdict = await arbiter.userActivity();
  assert.equal(verdict.active, true);
  assert.equal(verdict.strength, "strong");
  now += 5_000;
  assert.equal((await arbiter.userActivity()).active, false);
});

test("permission engine applies defaults, locks risky capabilities and scopes messages", async () => {
  const engine = new PermissionEngine(tempDir(), {});
  await engine.initialize();
  assert.equal(engine.check("READ_FILE").decision, "allow");
  assert.equal(engine.check("DELETE_FILE").decision, "ask");
  assert.equal(engine.check("ACCESS_CAMERA").decision, "deny");
  // Locked capabilities can never become silent.
  const install = await engine.setDecision("INSTALL_SOFTWARE", "allow");
  assert.equal(install.decision, "ask");
  assert.equal(install.locked, true);
  assert.equal(engine.grantForSession("PURCHASE"), false);
  // Permanent delete always asks even if deletes are allowed.
  await engine.setDecision("DELETE_FILE", "allow");
  assert.equal(engine.check("DELETE_FILE", { permanent: true }).decision, "ask");
  assert.equal(engine.check("DELETE_FILE", { permanent: false }).decision, "allow");

  // Messaging policy.
  assert.equal(engine.check("SEND_MESSAGE", { recipientContactId: "papa" }).decision, "ask");
  await engine.setMessageConfirmation("trusted_without_confirmation");
  await engine.setTrustedContact("papa", true);
  assert.equal(engine.check("SEND_MESSAGE", { recipientContactId: "papa" }).decision, "allow");
  assert.equal(engine.check("SEND_MESSAGE", { recipientContactId: "stranger" }).decision, "ask");
  assert.equal(engine.check("SEND_MESSAGE", { recipient: "unknown person" }).decision, "ask", "unresolved recipients always ask");
  await engine.setMessageConfirmation("confirm_new_recipients");
  assert.equal(engine.check("SEND_MESSAGE", { recipientContactId: "mummy" }).decision, "ask");
  await engine.rememberRecipient("mummy");
  assert.equal(engine.check("SEND_MESSAGE", { recipientContactId: "mummy" }).decision, "allow");

  // Denied capabilities stay denied.
  await engine.setDecision("SEND_MESSAGE", "deny");
  assert.equal(engine.check("SEND_MESSAGE", { recipientContactId: "papa" }).decision, "deny");
});

test("legacy permission flags migrate to capability denials", () => {
  const policy = migrateFromLegacyEnv({ ABxAG_PERMISSION_DESKTOP_CONTROL: "false", ABxAG_PERMISSION_CODE_EXECUTION: "off" });
  assert.equal(policy.capabilities.CONTROL_INPUT.decision, "deny");
  assert.equal(policy.capabilities.RUN_COMMAND.decision, "deny");
  assert.equal(policy.capabilities.READ_FILE.decision, "allow");
});

test("confirmation broker resolves once, expires and cancels with the task", async () => {
  const broker = new ConfirmationBroker();
  const { request, answer } = broker.request({
    taskId: "t1", capability: "SEND_MESSAGE", title: "Send?", description: "Send IMG_1.png to Papa", details: {}, allowRemember: false,
  });
  assert.equal(broker.list().length, 1);
  assert.equal(broker.resolve(request.id, { approved: true, via: "ui" }), true);
  assert.equal(broker.resolve(request.id, { approved: false, via: "ui" }), false);
  assert.equal((await answer).approved, true);

  const expiring = broker.request({ taskId: "t2", capability: "DELETE_FILE", title: "", description: "", details: {}, allowRemember: false }, { timeoutMs: 20 });
  assert.deepEqual(await expiring.answer, { approved: false, via: "timeout" });

  const controller = new AbortController();
  const cancelled = broker.request({ taskId: "t3", capability: "RUN_COMMAND", title: "", description: "", details: {}, allowRemember: false }, { signal: controller.signal });
  controller.abort();
  assert.equal((await cancelled.answer).via, "cancel");
});

test("redaction removes secrets from text and structured data", () => {
  assert.match(redactText("key AIzaSyA1234567890abcdefghijklmnop end"), /REDACTED_GOOGLE_KEY/);
  assert.match(redactText("Authorization: Bearer abcdefghijklmnopqrstuv"), /Bearer \[REDACTED\]/);
  const value = redact({ apiKey: "x", nested: { password: "p", note: "card 4111 1111 1111 1111" }, clipboard: "secret text" }) as any;
  assert.equal(value.apiKey, "[REDACTED]");
  assert.equal(value.nested.password, "[REDACTED]");
  assert.match(value.nested.note, /REDACTED_NUMBER/);
  assert.match(value.clipboard, /chars omitted/);
  assert.match(summarizeArgs({ text: "hello", execute_token: "abc", amount: 3 }), /execute_token=\[hidden\]/);
});

test("secret store round-trips through OS protection and migrates legacy plaintext", { skip: process.platform !== "win32" && "DPAPI is Windows-only" }, () => {
  const dir = tempDir();
  const legacy = path.join(dir, "secrets.json");
  fs.writeFileSync(legacy, JSON.stringify({ geminiApiKey: "test-key-123", ignoreEnvironmentApiKey: false }));
  const store = new SecretStore(dir);
  assert.equal(store.migrateLegacyPlaintext(legacy, "geminiApiKey", "provider:gemini"), true);
  const onDisk = fs.readFileSync(path.join(dir, "secrets.v2.json"), "utf-8");
  assert.equal(onDisk.includes("test-key-123"), false, "plaintext key must not be stored");
  assert.equal(JSON.parse(fs.readFileSync(legacy, "utf-8")).geminiApiKey, undefined);
  const reloaded = new SecretStore(dir);
  assert.equal(reloaded.get("provider:gemini"), "test-key-123");
  reloaded.delete("provider:gemini");
  assert.equal(new SecretStore(dir).get("provider:gemini"), undefined);
});



