import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AttentionEngine } from "../attentionEngine";
import { loadCognitionConfig } from "../config";
import { DesktopPerception, type DesktopSnapshot } from "../desktopPerception";
import { ModelRouter } from "../modelRouter";
import { GoalPlanner } from "../planner";
import { SkillManager } from "../skillManager";
import { TaskCritic } from "../critic";
import { CognitiveEventBus } from "../eventBus";
import { GoalManager } from "../goalManager";
import { InitiativeEngine } from "../initiativeEngine";
import { SituationModel } from "../situationModel";
import { StructuredMemoryStore } from "../structuredMemory";
import { ToolExecutor } from "../toolExecutor";
import { ToolRegistry } from "../toolRegistry";

test("important deletion warns while a trivial window event is ignored", async () => {
  const config = loadCognitionConfig({} as NodeJS.ProcessEnv);
  const bus = new CognitiveEventBus();
  const situationModel = new SituationModel();
  const attention = new AttentionEngine();
  const initiative = new InitiativeEngine(config);

  const deletion = bus.normalize({
    type: "filesystem.file_delete_requested",
    source: "filesystem",
    importance: 0.98,
    confidence: 0.96,
    metadata: { path: "F:/ABxAG/abxag-ai-assistant", risk: 0.99, urgency: 0.96 },
  });
  const deletionSituation = situationModel.apply(deletion);
  const deletionAttention = attention.assess(deletion, deletionSituation);
  const deletionDecision = initiative.decide(deletion, deletionAttention, deletionSituation);
  assert.equal(deletionDecision.action, "WARN");
  assert.equal(deletionDecision.shouldGenerateSpeech, true);

  const trivial = bus.normalize({
    type: "desktop.active_window_changed",
    source: "desktop",
    importance: 0.05,
    metadata: { title: "Untitled - Notepad" },
  });
  const trivialSituation = situationModel.apply(trivial);
  const trivialDecision = initiative.decide(trivial, attention.assess(trivial, trivialSituation), trivialSituation);
  assert.equal(trivialDecision.action, "IGNORE");
});

test("recent equivalent warnings are suppressed unless urgency increases", () => {
  const bus = new CognitiveEventBus();
  const situation = new SituationModel().getSnapshot();
  const engine = new AttentionEngine(60_000);
  const make = (urgency: number) => bus.normalize({
    type: "system.disk_space_low",
    source: "system",
    importance: 0.78,
    dedupeKey: "disk-space-c",
    metadata: { urgency, risk: urgency },
  });
  const first = engine.assess(make(0.7), situation, 1_000);
  engine.record(first, 1_000);
  const repeated = engine.assess(make(0.7), situation, 2_000);
  const escalated = engine.assess(make(0.95), situation, 3_000);
  assert.ok(repeated.factors.repetitionPenalty >= 0.55);
  assert.ok(repeated.score < first.score);
  assert.equal(escalated.factors.repetitionPenalty, 0);
  assert.ok(escalated.score > repeated.score);
});

test("situation model retains interruption and contextual silence state", () => {
  const bus = new CognitiveEventBus();
  const situation = new SituationModel();
  situation.apply(bus.normalize({ type: "conversation.abxag_started_speaking", source: "conversation" }));
  situation.apply(bus.normalize({ type: "conversation.user_started_speaking", source: "conversation" }));
  assert.equal(situation.getSnapshot().abxagWasInterrupted, true);
  situation.apply(bus.normalize({
    type: "conversation.user_stopped_speaking",
    source: "conversation",
    timestamp: new Date(Date.now() - 5_000).toISOString(),
  }));
  assert.ok(situation.getSnapshot().silenceSeconds >= 4);
});

test("structured memory retrieves by project and gives explicit correction priority", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abxag-memory-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new StructuredMemoryStore(path.join(dir, "memory.json"));
  await store.initialize();
  const wrong = await store.add({
    kind: "semantic",
    content: "ALTREX is inside ABxAG.",
    projectId: "ALTREX",
    source: "conversation",
    confidence: 0.6,
  });
  const correction = await store.correct(wrong.id, "ALTREX is not inside ABxAG.", { projectId: "ALTREX" });
  await store.add({
    kind: "project",
    content: "NEXTRON uses a separate repository.",
    projectId: "NEXTRON",
    source: "conversation",
  });
  const results = await store.retrieve({ text: "Where is ALTREX?", projectId: "ALTREX", limit: 5 });
  assert.equal(results.some((item) => item.id === wrong.id), false);
  assert.equal(results[0].id, correction.id);
  assert.equal(results.some((item) => item.projectId === "NEXTRON"), false);
});

test("goal manager respects dependencies, completion, and cancellation", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abxag-goal-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manager = new GoalManager(path.join(dir, "goals.json"));
  await manager.initialize();
  const goal = await manager.create({
    objective: "Ship the cognitive runtime",
    tasks: [
      { id: "build", title: "Build" },
      { id: "verify", title: "Verify", dependsOn: ["build"] },
    ],
  });
  const first = goal.tasks[0];
  const second = goal.tasks[1];
  const dependentGoal = await manager.create({
    objective: "Build then verify",
    tasks: [{ title: "Build" }, { title: "Verify", dependsOn: [] }],
  });
  assert.equal(manager.nextRunnableTask(goal.id)?.id, first.id);
  assert.notEqual(manager.nextRunnableTask(goal.id)?.id, second.id);
  await manager.updateTask(goal.id, first.id, { status: "completed", progress: 1 });
  assert.equal(manager.nextRunnableTask(goal.id)?.id, second.id);
  await manager.updateTask(goal.id, second.id, { status: "completed", progress: 1 });
  assert.equal(manager.get(goal.id)?.status, "completed");
  await manager.cancel(dependentGoal.id);
  assert.equal(manager.get(dependentGoal.id)?.status, "cancelled");
});

test("tool executor allows reads, confirms destructive actions, and can cancel work", async () => {
  const config = loadCognitionConfig({} as NodeJS.ProcessEnv);
  const registry = new ToolRegistry();
  registry.registerDesktopTools(["readFile", "deleteFile", "systemInfo"]);
  let calls = 0;
  const executor = new ToolExecutor({
    config,
    registry,
    handler: async (_tool, _args, signal) => {
      calls += 1;
      if (signal.aborted) return { ok: false, error: "cancelled" };
      return { ok: true, result: { value: "ok" } };
    },
  });

  const read = await executor.execute("readFile", { path: "notes.txt" });
  assert.equal(read.success, true);
  const deletion = await executor.execute("deleteFile", { path: "F:/ABxAG", permanent: true });
  assert.equal(deletion.status, "confirmation_required");
  assert.equal(calls, 1);
  const confirmed = await executor.confirm(deletion.confirmationId!);
  assert.equal(confirmed.success, true);
  assert.equal(calls, 2);
});

test("user cancellation aborts an in-flight tool and never reports success", async () => {
  const registry = new ToolRegistry();
  registry.registerDesktopTools(["systemInfo"]);
  const executor = new ToolExecutor({
    config: loadCognitionConfig({} as NodeJS.ProcessEnv),
    registry,
    handler: async (_tool, _args, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ ok: false, error: "cancelled" }), { once: true });
    }),
  });
  const pending = executor.execute("systemInfo", {}, { correlationId: "operation-1" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(executor.cancel("operation-1"), true);
  const outcome = await pending;
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.success, false);
});

test("desktop perception emits only meaningful snapshot changes", async () => {
  const base: DesktopSnapshot = {
    timestamp: new Date().toISOString(),
    activeWindow: { title: "Editor", application: "code.exe", pid: 1 },
    applications: ["code.exe"],
    disk: { path: "C:\\", freeBytes: 100 * 1024 ** 3, totalBytes: 500 * 1024 ** 3, percentUsed: 80 },
    downloads: [],
    userIdleSeconds: 0,
  };
  const next: DesktopSnapshot = {
    ...base,
    activeWindow: { title: "Downloads", application: "explorer.exe", pid: 2 },
    applications: ["code.exe", "explorer.exe"],
    downloads: [{
      name: "render.mp4",
      path: "C:/Users/TECH/Downloads/render.mp4",
      size: 10,
      modifiedAt: new Date().toISOString(),
      status: "complete",
    }],
  };
  const snapshots = [base, next];
  const events: string[] = [];
  const perception = new DesktopPerception({
    fetchSnapshot: async () => snapshots.shift() || next,
    emit: (event) => { events.push(event.type); },
  });
  await perception.poll();
  assert.deepEqual(events, []);
  await perception.poll();
  assert.ok(events.includes("desktop.active_window_changed"));
  assert.ok(events.includes("desktop.application_opened"));
  assert.ok(events.includes("desktop.download_completed"));
});

test("model router deduplicates, caches, and uses one bounded fallback", async () => {
  const calls: string[] = [];
  const router = new ModelRouter({
    routes: { reasoning: ["primary", "fallback"] },
    provider: {
      generate: async ({ model }) => {
        calls.push(model);
        if (model === "primary") throw new Error("temporarily unavailable");
        return '{"tasks":[]}';
      },
    },
  });
  const first = await router.generate({ capability: "reasoning", prompt: "plan this", cacheKey: "same" });
  const cached = await router.generate({ capability: "reasoning", prompt: "plan this", cacheKey: "same" });
  assert.equal(first.model, "fallback");
  assert.equal(first.attempts, 2);
  assert.equal(cached.cached, true);
  assert.deepEqual(calls, ["primary", "fallback"]);
});

test("skills require verification and improve only from recorded outcomes", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abxag-skill-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const skills = new SkillManager(path.join(dir, "skills.json"));
  await skills.initialize();
  await assert.rejects(() => skills.learn({
    name: "export video",
    description: "Export current edit",
    steps: [{ id: "one", action: "Export" }],
    expectedOutcome: "Video file exists",
    verified: false,
  }));
  const learned = await skills.learn({
    name: "export video",
    description: "Export current edit",
    steps: [{ id: "one", action: "Export with the chosen preset", tool: "clickText" }],
    expectedOutcome: "Video file exists",
    verified: true,
  });
  const improved = await skills.recordOutcome(learned.id, true);
  assert.equal(improved.uses, 1);
  assert.equal(improved.successRate, 1);
  assert.ok(improved.confidence > learned.confidence);
});

test("critic never treats confirmation or structured failure as success", () => {
  const critic = new TaskCritic();
  const pending = critic.verifyToolResult({
    success: false,
    status: "confirmation_required",
    tool: "deleteFile",
    result: null,
    error: "confirmation needed",
    riskLevel: 4,
    durationMs: 1,
    attempts: 0,
  });
  assert.equal(pending.passed, false);
  assert.equal(pending.retryRecommended, false);
});

test("planner validates a bounded dependency-ordered model plan", async () => {
  const router = new ModelRouter({
    routes: { reasoning: ["reasoner"] },
    provider: {
      generate: async () => JSON.stringify({
        tasks: [
          { id: "audit", title: "Audit current code", priority: 0.9, dependsOn: [] },
          { id: "build", title: "Implement the change", priority: 0.8, dependsOn: ["audit"] },
        ],
      }),
    },
  });
  const planner = new GoalPlanner(router, 5);
  const tasks = await planner.plan({
    id: "goal",
    objective: "Upgrade ABxAG safely",
    constraints: ["Preserve the UI"],
    successCriteria: ["Tests pass"],
    priority: 0.9,
    status: "planning",
    projectId: "ABxAG",
    tasks: [],
    blockers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[1].dependsOn, ["audit"]);
});

