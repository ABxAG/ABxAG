import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CognitiveRuntime } from "../runtime";
import { SocialInitiativeEngine } from "../socialInitiativeEngine";
import { SpeechOrchestrator } from "../speechOrchestrator";
import { SituationModel } from "../situationModel";
import type { DeepThoughtGenerator } from "../autonomousMind";
import type { ThoughtCandidate } from "../types";

interface RuntimeHarness {
  runtime: CognitiveRuntime;
  now: { value: number };
}

async function createHarness(
  t: { after(fn: () => void | Promise<void>): void },
  generator?: DeepThoughtGenerator,
): Promise<RuntimeHarness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abxag-autonomous-test-"));
  const now = { value: Date.now() };
  const runtime = new CognitiveRuntime({
    dataDir: dir,
    projectRoot: "F:/ABxAG",
    autoStartMind: false,
    mind: {
      minimumFollowupDelayMs: 1_000,
      activeConversationWindowMs: 180_000,
      now: () => now.value,
      random: () => 0.5,
    },
  });
  await runtime.initialize();
  if (generator) runtime.setDeepThoughtGenerator(generator);
  t.after(async () => {
    await runtime.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { runtime, now };
}

async function conversation(
  harness: RuntimeHarness,
  user = "I think we'll add vision later, after memory is stable.",
  abxag = "Haan, pehle memory stable kar lete hain.",
): Promise<void> {
  await harness.runtime.process({
    type: "conversation.user_input",
    source: "conversation",
    timestamp: new Date(harness.now.value).toISOString(),
    importance: 0.7,
    metadata: { text: user },
  });
  harness.now.value += 100;
  await harness.runtime.process({
    type: "conversation.turn_completed",
    source: "conversation",
    timestamp: new Date(harness.now.value).toISOString(),
    importance: 0.5,
    metadata: { text: abxag },
  });
}

function usefulThought(origin: ThoughtCandidate["origin"] = "unfinished_thread"): ThoughtCandidate {
  return {
    id: "thought-1",
    createdAt: Date.now(),
    origin,
    content: origin === "curiosity"
      ? "Clarify whether learned workflows should run automatically or ask first."
      : "Vision affects learning from demonstrations, so postponing it completely may block skill learning.",
    relevance: 0.95,
    novelty: 0.9,
    urgency: 0.3,
    socialValue: 0.92,
    confidence: 0.9,
    suggestedAction: origin === "curiosity" ? "ASK" : "SPEAK",
    relatedTopic: "ABxAG architecture",
    expiresAt: Date.now() + 180_000,
  };
}

test("required #1: idle startup keeps lightweight cognition alive without continuous model calls", async (t) => {
  let deepCalls = 0;
  const harness = await createHarness(t, async () => {
    deepCalls += 1;
    return usefulThought();
  });
  for (let i = 0; i < 240; i += 1) {
    harness.now.value += 5_000;
    await harness.runtime.mind.tick(harness.now.value);
  }
  assert.equal(harness.runtime.mind.status().counters.cognitiveTicks, 240);
  assert.equal(deepCalls, 0);
});

test("required #2: unresolved conversation creates an endogenous thought after silence", async (t) => {
  const harness = await createHarness(t, async () => usefulThought());
  harness.runtime.setSpeechAvailable(true);
  const internalEvents: string[] = [];
  harness.runtime.onDecision((outcome) => {
    if (outcome.event.type.startsWith("internal.") && outcome.decision.shouldGenerateSpeech) {
      internalEvents.push(outcome.event.type);
    }
  });
  await conversation(harness);
  harness.now.value += 1_500;
  await harness.runtime.mind.tick(harness.now.value);
  assert.deepEqual(internalEvents, ["internal.unfinished_topic"]);
  assert.equal(harness.runtime.mind.status().counters.internalThoughtsGenerated, 1);
});

test("required #3: ABxAG response is followed by autonomous speech with no new user input", async (t) => {
  const harness = await createHarness(t, async () => usefulThought());
  const speech = new SpeechOrchestrator();
  const spoken: string[] = ["ABxAG response #1"];
  const userEventsBefore: string[] = [];
  harness.runtime.setSpeechAvailable(true);
  harness.runtime.onDecision((outcome) => {
    if (!outcome.decision.shouldGenerateSpeech || !outcome.event.type.startsWith("internal.")) return;
    speech.request({
      id: outcome.event.id,
      source: "conversation_continuation",
      thoughtId: String(outcome.event.metadata.thoughtId || ""),
      deliver: () => spoken.push("ABxAG autonomous speech #2"),
    });
  });
  await conversation(harness);
  userEventsBefore.push(...harness.runtime.events.recent(50)
    .filter((event) => event.type.startsWith("conversation.user_"))
    .map((event) => event.id));
  harness.now.value += 1_500;
  await harness.runtime.mind.tick(harness.now.value);
  const userEventsAfter = harness.runtime.events.recent(50)
    .filter((event) => event.type.startsWith("conversation.user_"))
    .map((event) => event.id);
  assert.deepEqual(spoken, ["ABxAG response #1", "ABxAG autonomous speech #2"]);
  assert.deepEqual(userEventsAfter, userEventsBefore);
});

test("required #4: no meaningful thought leaves ABxAG quiet", async (t) => {
  const harness = await createHarness(t, async () => null);
  harness.runtime.setSpeechAvailable(true);
  let speech = 0;
  harness.runtime.onDecision((outcome) => {
    if (outcome.decision.shouldGenerateSpeech && outcome.event.type.startsWith("internal.")) speech += 1;
  });
  await conversation(harness, "Memory work is done for now.", "Theek hai, this part is resolved.");
  harness.now.value += 1_500;
  await harness.runtime.mind.tick(harness.now.value);
  assert.equal(speech, 0);
});

test("required #5: repetition engine suppresses the same conceptual thought", () => {
  const social = new SocialInitiativeEngine();
  const situation = new SituationModel().getSnapshot();
  const first = social.evaluate(usefulThought(), situation, 10_000);
  assert.equal(first.decision, "SPEAK");
  social.recordSpeech(first.semanticKey, 10_000);
  const repeated = social.evaluate({ ...usefulThought(), id: "thought-2" }, situation, 11_000);
  assert.equal(repeated.decision, "DROP");
  assert.equal(repeated.opportunity.reason, "recently expressed");
});

test("required #6: user interruption stops autonomous speech and preserves its identity", () => {
  const speech = new SpeechOrchestrator();
  let delivered = 0;
  speech.request({
    id: "autonomous-1",
    source: "conversation_continuation",
    thoughtId: "thought-preserve-me",
    deliver: () => { delivered += 1; },
  });
  const signal = speech.onUserSpeechStarted();
  const interrupted = speech.onInterrupted();
  assert.equal(delivered, 1);
  assert.equal(signal.interruptedThoughtId, "thought-preserve-me");
  assert.equal(interrupted?.thoughtId, "thought-preserve-me");
});

test("required #7: curiosity produces a specific autonomous question", async (t) => {
  let curiosityObserved = false;
  const harness = await createHarness(t, async (context) => {
    curiosityObserved = context.curiosity !== null;
    return usefulThought("curiosity");
  });
  harness.runtime.setSpeechAvailable(true);
  const decisions: string[] = [];
  harness.runtime.onDecision((outcome) => {
    if (outcome.event.type === "internal.curiosity_detected") decisions.push(outcome.decision.action);
  });
  await conversation(
    harness,
    "Maybe later decide whether learned workflows run automatically or ask first.",
    "Haan, skill learning pehle stable karte hain.",
  );
  harness.now.value += 1_500;
  await harness.runtime.mind.tick(harness.now.value);
  assert.equal(curiosityObserved, true);
  assert.deepEqual(decisions, ["ASK"]);
});

test("required #8: twenty simulated minutes keep cognition alive without speech spam", async (t) => {
  const harness = await createHarness(t, async () => usefulThought());
  harness.runtime.setSpeechAvailable(true);
  let autonomousSpeech = 0;
  harness.runtime.onDecision(async (outcome) => {
    if (!outcome.decision.shouldGenerateSpeech || !outcome.event.type.startsWith("internal.")) return;
    autonomousSpeech += 1;
    harness.runtime.markAutonomousSpeechStarted(String(outcome.event.metadata.thoughtId || ""));
    harness.runtime.markAutonomousSpeechCompleted();
    await harness.runtime.process({
      type: "internal.autonomous_speech_completed",
      source: "internal",
      timestamp: new Date(harness.now.value).toISOString(),
      metadata: { internalOnly: true, thoughtId: outcome.event.metadata.thoughtId },
    });
  });
  await conversation(harness);
  for (let i = 0; i < 400; i += 1) {
    harness.now.value += 3_000;
    await harness.runtime.mind.tick(harness.now.value);
  }
  assert.equal(harness.runtime.mind.status().counters.cognitiveTicks, 400);
  assert.ok(autonomousSpeech <= 1, `expected at most one autonomous follow-up, got ${autonomousSpeech}`);
  assert.equal(harness.runtime.mind.status().counters.autonomousSpeechCompleted, autonomousSpeech);
});

