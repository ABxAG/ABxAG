import assert from "node:assert/strict";
import test from "node:test";
import { ConversationPresenceEngine } from "../presence/conversationPresence";
import { SocialState } from "../presence/socialState";
import { UserPresenceEngine, type PresenceChange } from "../presence/userPresence";

function rig(level: "quiet" | "balanced" | "lively" = "balanced") {
  let now = 1_000_000;
  const clock = () => now;
  const presence = new UserPresenceEngine(undefined, clock);
  const conversation = new ConversationPresenceEngine({ level, awayCheckinEnabled: true, returnGreetingEnabled: true, returnGreetingAfterMin: 15 }, clock);
  const changes: PresenceChange[] = [];
  presence.onChange((change) => {
    changes.push(change);
    conversation.updatePresence(presence.snapshot(), change);
  });
  const advance = (ms: number) => {
    now += ms;
    conversation.updatePresence(presence.tick());
  };
  return { presence, conversation, changes, advance, at: () => now };
}

test("user speaks then pauses 5 seconds: ABxAG stays quiet", () => {
  const { presence, conversation, advance } = rig();
  conversation.userStartedSpeaking();
  presence.recordVoice();
  conversation.userStoppedSpeaking();
  advance(5_000);
  for (const reason of ["casual", "away_checkin", "conversation_continuation", "visual_event"] as const) {
    const verdict = conversation.evaluate({ reason, priority: "low" });
    assert.equal(verdict.allowed, false, `${reason}: ${verdict.why}`);
  }
  assert.equal(conversation.evaluate({ reason: "casual", priority: "low" }).allowed, false);
  assert.equal(conversation.evaluate({ reason: "away_checkin", priority: "low" }).allowed, false);
});

test("user stops speaking but keeps using the mouse: treated as present", () => {
  const { presence, conversation, advance } = rig();
  conversation.userTurn();
  for (let i = 0; i < 20; i += 1) {
    advance(30_000);
    presence.recordInput();
  }
  assert.equal(presence.snapshot().state, "ACTIVE");
  assert.equal(conversation.evaluate({ reason: "away_checkin", priority: "low" }).allowed, false);
});

test("silence + no input → likely away → ONE check-in → no repeats → sleep → return detected", () => {
  const { presence, conversation, advance, changes } = rig();
  conversation.userTurn();
  presence.recordVoice();
  advance(4 * 60_000);
  assert.equal(presence.snapshot().state, "PASSIVE");
  assert.equal(conversation.evaluate({ reason: "away_checkin", priority: "low" }).allowed, false, "not yet away");
  advance(2 * 60_000);
  assert.equal(presence.snapshot().state, "LIKELY_AWAY");
  const first = conversation.request({ reason: "away_checkin", priority: "low", text: "Kaha gaye yaar?" });
  assert.equal(first.allowed, true, first.why);
  // No response: never repeated, no matter how many times it is asked.
  for (let i = 0; i < 10; i += 1) {
    advance(30_000);
    assert.equal(conversation.request({ reason: "away_checkin", priority: "low", text: "Hello? Awaaz nahi aa rahi" }).allowed, false);
    assert.equal(conversation.request({ reason: "casual", priority: "low" }).allowed, false);
  }
  assert.equal(conversation.state(), "SLEEPING");
  // The user comes back and moves the mouse.
  presence.recordInput();
  const returned = changes.at(-1)!;
  assert.equal(returned.returned, true);
  assert.notEqual(conversation.state(), "SLEEPING");
});

test("a return greeting needs a real absence and happens once", () => {
  const { presence, conversation, advance, changes } = rig();
  conversation.userTurn();
  presence.recordInput();
  advance(20 * 60_000);
  presence.recordInput();
  const change = changes.at(-1)!;
  assert.equal(conversation.shouldGreetReturn(change), true);
  assert.equal(conversation.request({ reason: "user_returned", priority: "normal" }).allowed, true);
  assert.equal(conversation.request({ reason: "user_returned", priority: "normal" }).allowed, false);
});

test("QUIET only speaks for things the user asked for", () => {
  const { presence, conversation, advance } = rig("quiet");
  conversation.userTurn();
  advance(7 * 60_000);
  void presence;
  assert.equal(conversation.request({ reason: "away_checkin", priority: "low" }).allowed, false);
  assert.equal(conversation.request({ reason: "download_finished", priority: "normal" }).allowed, false);
  assert.equal(conversation.request({ reason: "task_completed", priority: "normal" }).allowed, true);
});

test("DND silences discretionary speech and turns task results into visual notices", () => {
  const { conversation } = rig("lively");
  conversation.setDnd(true);
  assert.equal(conversation.request({ reason: "casual", priority: "low" }).allowed, false);
  const result = conversation.request({ reason: "task_completed", priority: "normal" });
  assert.equal(result.allowed, true);
  assert.equal(result.channel, "visual");
  assert.equal(conversation.request({ reason: "alarm", priority: "critical" }).channel, "voice");
  conversation.setDnd(false);
  conversation.setAutoDnd("fullscreen game");
  assert.equal(conversation.state(), "DO_NOT_DISTURB");
});

test("cooldowns, hourly caps and no-repeat apply in every mode", () => {
  const { conversation, advance, presence } = rig("lively");
  presence.recordInput();
  conversation.setWatchingScreen(true);
  assert.equal(conversation.request({ reason: "visual_event", priority: "low", key: "a", text: "Nice render" }).allowed, true);
  assert.equal(conversation.request({ reason: "visual_event", priority: "low", key: "b", text: "Another" }).allowed, false, "global gap");
  advance(2 * 60_000);
  presence.recordInput();
  assert.equal(conversation.request({ reason: "visual_event", priority: "low", key: "c", text: "Nice render" }).allowed, false, "same line never repeated");
  let allowed = 0;
  for (let i = 0; i < 40; i += 1) {
    advance(80_000);
    presence.recordInput();
    if (conversation.request({ reason: "casual", priority: "low", key: `k${i}`, text: `line ${i}` }).allowed) allowed += 1;
  }
  assert.ok(allowed <= 14 * 2 + 1, `hourly cap respected (${allowed})`);
});

test("never speaks over the user; task focus suppresses idle chatter", () => {
  const { conversation } = rig("lively");
  conversation.userStartedSpeaking();
  assert.equal(conversation.request({ reason: "task_completed", priority: "high" }).allowed, false);
  conversation.userStoppedSpeaking();
  conversation.setTaskRunning(true);
  assert.equal(conversation.request({ reason: "casual", priority: "low" }).allowed, false);
  assert.equal(conversation.request({ reason: "task_needs_user", priority: "high" }).allowed, true);
});

test("social state: away + low energy → sleepy; return → surprised then engaged", () => {
  let now = 0;
  const social = new SocialState(() => now);
  social.setContext("AWAY", "USER_TEMPORARILY_AWAY");
  for (let i = 0; i < 20; i += 1) {
    now += 60_000;
    social.tick();
  }
  assert.equal(social.snapshot().emotion, "sleepy");
  social.event("user_returned");
  social.setContext("ACTIVE", "USER_ACTIVE_PC");
  assert.equal(social.snapshot().emotion, "surprised");
  now += 5_000;
  social.tick();
  assert.notEqual(social.snapshot().emotion, "surprised");
  social.setContext("ACTIVE", "TASK_RUNNING");
  assert.equal(social.snapshot().attention, "task");
});

