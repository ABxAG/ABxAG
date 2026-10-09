import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ActionExecutor } from "../agent/actions/executor";
import { assessRisk } from "../agent/actions/risk";
import { AuditLog } from "../agent/audit";
import { DownloadManager } from "../agent/downloads";
import { TaskManager } from "../agent/loop";
import { PerceptionEngine } from "../agent/perception/engine";
import { extractRecipient, extractReferences } from "../agent/references";
import { InputArbiter, ResourceScheduler } from "../agent/scheduler";
import { TaskStore, TERMINAL_STATES } from "../agent/taskSession";
import { ContactBook } from "../memory/contacts";
import { WorkingMemory } from "../memory/workingMemory";
import { ConfirmationBroker } from "../permissions/confirmations";
import { PermissionEngine } from "../permissions/engine";
import { appEvents } from "../shared/appEvents";
import { FakeDesktop, ScriptedPlanner } from "./sim/fakeDesktop";

async function harness(options: { trusted?: boolean; conflictWaitMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abxag-loop-"));
  const desktop = new FakeDesktop();
  const planner = new ScriptedPlanner();
  const store = new TaskStore({ dataDir: dir });
  await store.initialize();
  const permissions = new PermissionEngine(dir, {});
  await permissions.initialize();
  const contacts = new ContactBook(dir);
  await contacts.initialize();
  const papa = await contacts.upsert({ displayName: "Papa", aliases: ["dad"], appNames: { whatsapp: "Papa" } });
  if (options.trusted) {
    await permissions.setMessageConfirmation("trusted_without_confirmation");
    await permissions.setTrustedContact(papa.id, true);
  }
  const confirmations = new ConfirmationBroker();
  const scheduler = new ResourceScheduler();
  const arbiter = new InputArbiter();
  const perception = new PerceptionEngine(desktop.call, null);
  const audit = new AuditLog(dir);
  const working = new WorkingMemory();
  const spoken: Array<{ kind: string; line: string }> = [];
  const executor = new ActionExecutor({
    call: desktop.call, perception, permissions, confirmations, scheduler, arbiter,
    downloads: new DownloadManager(dir, async () => dir), contacts, audit,
    remember: async () => {}, notify: () => {}, conflictWaitMs: options.conflictWaitMs ?? 300,
  });
  const router = { generate: planner.generate, registry: { getSelection: () => ({ brain: "scripted" }) } };
  const manager = new TaskManager({
    store, executor, perception, router: router as never, call: desktop.call, scheduler, arbiter, confirmations,
    permissions, contacts, working, audit,
    recall: async () => [], rememberEpisode: async () => {},
    speak: (kind, line) => spoken.push({ kind, line }),
    maxSteps: 14,
  });
  return { dir, desktop, planner, store, permissions, contacts, confirmations, scheduler, arbiter, manager, spoken, audit, papa };
}

function waitFor<T>(predicate: () => T | undefined | null | false, timeoutMs = 8_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 15);
    };
    tick();
  });
}

test("references: Hinglish recipients and demonstratives are extracted", () => {
  assert.equal(extractRecipient("Ye wali photo Papa ko WhatsApp kar do"), "Papa");
  assert.equal(extractRecipient("IMG_1032.png mummy ko bhejo"), "mummy");
  assert.equal(extractRecipient("send this screenshot to Rahul Sharma on WhatsApp"), "Rahul Sharma");
  assert.equal(extractRecipient("mere bhai ko bhej de"), "bhai");
  assert.equal(extractRecipient("open my downloads"), null);
  const refs = extractReferences("woh photo jo kal download ki thi Papa ko bhej");
  assert.equal(refs[0].kind, "image");
  assert.equal(refs[0].temporal, "yesterday");
  assert.equal(refs[0].demonstrative, "that");
  assert.ok(refs.some((ref) => ref.kind === "person" && ref.name === "Papa"));
  assert.equal(extractReferences("mera Altrex folder open kar")[0].name, "Altrex");
  assert.equal(extractReferences("second image dikhao")[0].ordinal, 2);
});

test("risk: a Send button in a messaging app needs SEND_MESSAGE; injected deletes are flagged", () => {
  const state = { activeWindow: { hwnd: 1, title: "Papa - WhatsApp", process: "WhatsApp.exe", rect: { left: 0, top: 0, right: 10, bottom: 10 } }, browser: null, elements: [], dialogs: [] } as never;
  const send = assessRisk({ tool: "ui.click", args: {}, baseCapability: "CONTROL_INPUT", state, goal: "photo papa ko bhejo", targetLabel: "Send" });
  assert.ok(send.capabilities.some((c) => c.capability === "SEND_MESSAGE"));
  assert.deepEqual(send.goalMismatch, []);
  const injected = assessRisk({ tool: "ui.click", args: {}, baseCapability: "CONTROL_INPUT", state, goal: "open youtube", targetLabel: "Delete account" });
  assert.ok(injected.goalMismatch.includes("ACCOUNT_CHANGE"), "an account change the user never asked for is flagged");
  const web = { ...(state as object), activeWindow: { hwnd: 2, title: "Store", process: "chrome.exe", rect: { left: 0, top: 0, right: 1, bottom: 1 } }, browser: { browser: "chrome", url: "https://shop.example/cart", title: "", loading: false } } as never;
  assert.ok(assessRisk({ tool: "ui.click", args: {}, baseCapability: "CONTROL_INPUT", state: web, goal: "check price", targetLabel: "Place your order" }).goalMismatch.includes("PURCHASE"));
});

test("SCENARIO 2 (mock): send an image to Papa — references, attach, verify, confirm, send", async () => {
  const h = await harness();
  const requests: Array<Record<string, unknown>> = [];
  const unsubscribe = appEvents.subscribe((event) => {
    if (event.type !== "confirmation.requested") return;
    const request = event.payload as Record<string, unknown>;
    requests.push(request);
    // The confirmation must name the resolved recipient before anything is sent.
    assert.equal(h.desktop.sent.length, 0);
    h.confirmations.resolve(String(request.id), { approved: true, via: "ui" });
  });
  const session = h.manager.start("Ye wali photo IMG_1032.png Papa ko WhatsApp kar do", "voice");
  const finished = await waitFor(() => { const s = h.store.get(session.id)!; return TERMINAL_STATES.has(s.state) ? s : null; }, 15_000);
  unsubscribe();
  assert.equal(finished.state, "completed", finished.error || finished.currentStatus);
  assert.deepEqual(h.desktop.sent, [{ to: "Papa", file: "C:\\Users\\Test\\Pictures\\IMG_1032.png", text: "" }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].capability, "SEND_MESSAGE");
  assert.equal((requests[0].details as Record<string, unknown>).recipient, "Papa");
  assert.ok(finished.references.some((r) => r.resolvedTo === "Papa"));
  assert.ok(finished.actions.some((a) => a.tool === "clipboard.copy_files" && a.status === "ok"));
  assert.ok(finished.permissions.some((p) => p.capability === "SEND_MESSAGE" && p.outcome === "approved"));
  assert.ok(h.spoken.some((s) => s.kind === "done"));
  const audit = await h.audit.recent(50, session.id);
  assert.ok(audit.some((entry) => /Approved/.test(entry.summary)));
});

test("declining the send confirmation means nothing is sent", async () => {
  const h = await harness();
  const unsubscribe = appEvents.subscribe((event) => {
    if (event.type === "confirmation.requested") h.confirmations.resolve(String((event.payload as { id: string }).id), { approved: false, via: "ui" });
  });
  const session = h.manager.start("IMG_1032.png Papa ko WhatsApp kar do", "text");
  await waitFor(() => h.store.get(session.id)!.actions.some((a) => a.status === "denied"), 15_000);
  h.manager.stop(session.id);
  unsubscribe();
  assert.equal(h.desktop.sent.length, 0);
});

test("trusted contact policy sends without a prompt", async () => {
  const h = await harness({ trusted: true });
  let prompted = false;
  const unsubscribe = appEvents.subscribe((event) => { if (event.type === "confirmation.requested") prompted = true; });
  const session = h.manager.start("IMG_1032.png Papa ko WhatsApp kar do", "text");
  const finished = await waitFor(() => { const s = h.store.get(session.id)!; return TERMINAL_STATES.has(s.state) ? s : null; }, 15_000);
  unsubscribe();
  assert.equal(finished.state, "completed");
  assert.equal(prompted, false);
  assert.equal(h.desktop.sent.length, 1);
});

test("SCENARIO 6: a vanished control causes re-observation and a new plan, not a stale click", async () => {
  const h = await harness({ trusted: true });
  h.desktop.vanishOnce = "chat:Papa";
  const session = h.manager.start("IMG_1032.png Papa ko WhatsApp kar do", "text");
  const finished = await waitFor(() => { const s = h.store.get(session.id)!; return TERMINAL_STATES.has(s.state) ? s : null; }, 15_000);
  assert.equal(finished.state, "completed");
  const failed = finished.actions.find((a) => a.status === "failed");
  assert.equal(failed?.failureCategory, "ELEMENT_NOT_FOUND");
  // After the failure the agent observed again (new snapshot) before clicking.
  const inspectsAfterFailure = h.desktop.calls.filter((c) => c.tool === "inspectUi").length;
  assert.ok(inspectsAfterFailure >= 4);
  assert.equal(h.desktop.sent.length, 1);
});

test("SCENARIO 12: ABxAG yields while the user is actively using the mouse, then resumes", async () => {
  const h = await harness({ trusted: true, conflictWaitMs: 200 });
  let userBusyUntil = Date.now() + 1_200;
  const pump = setInterval(() => {
    if (Date.now() < userBusyUntil) h.arbiter.recordPhysicalInput({ kind: "mouse", at: Date.now(), distance: 200 });
  }, 50);
  const session = h.manager.start("IMG_1032.png Papa ko WhatsApp kar do", "text");
  const finished = await waitFor(() => { const s = h.store.get(session.id)!; return TERMINAL_STATES.has(s.state) ? s : null; }, 20_000);
  clearInterval(pump);
  userBusyUntil = 0;
  assert.equal(finished.state, "completed");
  assert.ok(finished.actions.some((a) => a.failureCategory === "USER_INTERRUPTED"), "the conflict was detected instead of fighting for the pointer");
  assert.ok(finished.statusHistory.some((s) => /using the (mouse|PC)/i.test(s.text)));
});

test("SCENARIO 15: emergency stop halts planning, leases and confirmations immediately", async () => {
  const h = await harness();
  let confirmationSeen = false;
  const unsubscribe = appEvents.subscribe((event) => { if (event.type === "confirmation.requested") confirmationSeen = true; });
  const session = h.manager.start("IMG_1032.png Papa ko WhatsApp kar do", "voice");
  await waitFor(() => confirmationSeen, 15_000);
  const stopped = h.manager.stopAll("test_emergency");
  unsubscribe();
  assert.ok(stopped >= 1);
  await waitFor(() => TERMINAL_STATES.has(h.store.get(session.id)!.state));
  assert.equal(h.store.get(session.id)!.state, "cancelled");
  assert.equal(h.confirmations.list().length, 0);
  assert.equal(h.scheduler.status().length, 0);
  assert.equal(h.desktop.sent.length, 0, "nothing was sent after stop");
  const callsAtStop = h.desktop.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(h.desktop.calls.length, callsAtStop, "no further desktop actions after stop");
});

test("pause and take-over hold the loop until control is returned", async () => {
  const h = await harness({ trusted: true });
  // Keep the Send button hidden so the task is still running when the user takes over.
  h.desktop.hideSendFor = 10_000;
  const session = h.manager.start("IMG_1032.png Papa ko WhatsApp kar do", "text");
  await waitFor(() => h.desktop.attachment);
  h.manager.takeOver(session.id);
  await waitFor(() => h.store.get(session.id)!.state === "user_takeover");
  const calls = h.desktop.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(h.desktop.calls.length, calls, "no actions while the user has control");
  h.desktop.hideSendFor = 0;
  h.manager.returnControl(session.id);
  const finished = await waitFor(() => { const s = h.store.get(session.id)!; return TERMINAL_STATES.has(s.state) ? s : null; }, 15_000);
  assert.equal(finished.state, "completed");
});

test("invalid planner output is rejected by validation, never executed", async () => {
  const h = await harness();
  const executor = (h.manager as unknown as { deps: { executor: ActionExecutor } }).deps.executor;
  const scope = (await import("../agent/cancellation")).rootScope.child("t");
  const bad = await executor.execute({ tool: "ui.click", args: { element: 12 } }, { taskId: "t", goal: "x", state: null, scope });
  assert.equal(bad.category, "INVALID_ACTION");
  const unknown = await executor.execute({ tool: "system.format_disk", args: {} }, { taskId: "t", goal: "x", state: null, scope });
  assert.equal(unknown.category, "INVALID_ACTION");
  const stale = await executor.execute({ tool: "ui.click", args: { element: "e99" } }, { taskId: "t", goal: "x", state: { elements: [], snapshotId: "s1" } as never, scope });
  assert.equal(stale.category, "ELEMENT_NOT_FOUND");
  const forbidden = await executor.execute({ tool: "shell.run", args: { command: "powershell Set-MpPreference -DisableRealtimeMonitoring $true" } }, { taskId: "t", goal: "run a command", state: null, scope });
  assert.equal(forbidden.category, "PERMISSION_DENIED");
  scope.dispose();
});

test("grounding: a final answer cannot name files that were never observed", async () => {
  const { ungroundedClaims } = await import("../agent/loop");
  const evidence = ['{"files":[{"path":"C:\\Users\\MSI\\ABxAG-agent-test\\thumbnail_final.png"}]}'];
  assert.deepEqual(ungroundedClaims("The latest is thumbnail_final.png.", evidence, [], "x"), []);
  assert.deepEqual(ungroundedClaims("The latest thumbnail is thumbnail (41).jpeg.", evidence, [], "x"), ["thumbnail (41).jpeg"]);
  assert.deepEqual(ungroundedClaims("Saved Screenshot 2026-10-02 131204.png", ["e1 listitem 'Screenshot 2026-10-02 131204.png'"], [], "x"), []);
  assert.equal(ungroundedClaims("See https://evil.example/x", [], [], "x").length, 1);
});

test("references: an explicit folder in the request scopes file candidates", async () => {
  const { explicitFolderIn } = await import("../agent/references");
  const folder = String.raw`C:\Users\MSI\ABxAG-agent-test`;
  const call = async (_tool: string, args: Record<string, unknown>) => ({ ok: true, result: { exists: String(args.path) === folder, is_dir: true } });
  assert.equal(await explicitFolderIn(`${folder} folder pe jao aur latest thumbnail batao`, { call }), folder);
  assert.equal(await explicitFolderIn("latest thumbnail batao", { call }), null);
});

test("a message typed and sent with Enter is never sent a second time in the same task", async () => {
  const h = await harness({ trusted: true });
  const executor = (h.manager as unknown as { deps: { executor: ActionExecutor } }).deps.executor;
  const scope = (await import("../agent/cancellation")).rootScope.child("dup");
  const context = { taskId: "dup", goal: "type hello and press enter", state: null, scope };
  const first = await executor.execute({ tool: "ui.type", args: { text: "Hi, main Myra bol rahi hun.", submit: true } }, context);
  assert.equal(first.ok, true, first.error);
  assert.equal((first.data as { sent?: boolean }).sent, true);
  // The chat had not shown it yet, so the planner tries again: refused.
  const again = await executor.execute({ tool: "ui.type", args: { text: "hi, main myra bol rahi hun", submit: true } }, context);
  assert.equal(again.ok, false);
  assert.match(String(again.error), /DUPLICATE_SEND/);
  // Typing it and pressing Enter separately is caught too.
  const typed = await executor.execute({ tool: "ui.type", args: { text: "Hi, main Myra bol rahi hun." } }, context);
  assert.equal(typed.ok, true, typed.error);
  const enter = await executor.execute({ tool: "keyboard.press", args: { key: "enter" } }, context);
  assert.equal(enter.ok, false);
  assert.match(String(enter.error), /DUPLICATE_SEND/);
  // A different message is fine.
  const other = await executor.execute({ tool: "ui.type", args: { text: "Kaisi ho?", submit: true } }, context);
  assert.equal(other.ok, true, other.error);
  scope.dispose();
});

