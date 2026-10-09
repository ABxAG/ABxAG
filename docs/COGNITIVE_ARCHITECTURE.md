# ABxAG cognitive runtime

This upgrade extends ABxAG's existing application. It does not replace the
React UI, Electron shell, 3D character, voice session, real-PC control, memory
dashboard, settings panel, or Python desktop tools.

## Existing architecture retained

```text
Electron main process
  -> Node/TypeScript Express + WebSocket backend
     -> Gemini Live voice session
     -> local Python/FastAPI desktop tool agent
  -> existing React/Vite renderer
     -> existing 3D character and animation system
     -> existing microphone, PCM playback, screen share, settings and memories
```

The new `cognition/` modules live behind the Node backend. The renderer receives
the same audio, transcription, memory-sync, tool-call and status messages it did
before the upgrade.

## Event pipeline

```text
structured event
  -> bounded event bus
  -> compact situation model
  -> project-aware memory retrieval
  -> attention + novelty + risk + interruption scoring
  -> initiative decision
  -> ignore / remember / observe / wait / speak / ask / warn
  -> tool execution when explicitly requested and permitted
  -> structured critic verdict
  -> episodic/correction/skill memory update
```

Routine perception uses local heuristics only. It never schedules recurring LLM
calls. Model routing is invoked on demand for a goal plan or an existing live
conversation turn.

## Implemented modules

- `eventBus.ts`: typed events, bounded history and subscribers.
- `situationModel.ts`: conversation, app, project, task, silence, interruption,
  success/failure and pending-risk state.
- `attentionEngine.ts`: relevance, novelty, urgency, risk, impact, confidence,
  repetition suppression and contextual interruption cost.
- `initiativeEngine.ts`: conservative speech/attention decisions with a reason
  object and autonomy/proactive-speech feature gates.
- `desktopPerception.ts` + `desktop_agent/perception.py`: local metadata-only
  observation of the active application, visible apps, user idle state,
  downloads and disk capacity.
- `structuredMemory.ts`: local typed memory, legacy migration, confidence,
  confirmations, correction supersession, project filtering, retrieval, expiry
  and decay. The old `memories.json` remains compatible with the UI.
- `goalManager.ts` + `planner.ts`: persistent goals, bounded dependency plans,
  restart-safe blocking, progress, retry budgets and cancellation.
- `skillManager.ts`: verified workflow persistence and confidence/success-rate
  updates from actual outcomes.
- `modelRouter.ts`: capability routes, one bounded fallback, request
  deduplication, caching, input/rate budgets and call logging.
- `toolRegistry.ts` + `toolExecutor.ts` + `safety.ts`: explicit permissions,
  risk levels, confirmation tokens, timeouts, bounded retries and cancellation.
- `critic.ts`: structured verification that does not treat pending confirmation
  or tool failure as success.
- `api_hub/`: validated public-apis import, provider readiness/health, bounded
  capability search, and verified declarative adapters with no downloaded code.
- `desktop_agent/tools_input.py`: application-independent mouse, keyboard,
  cursor, visible-window and wait/observe primitives that return post-action
  state for verification.

## Voice and turn-taking

The existing Gemini Live voice pipeline remains in place. The microphone
processor now performs lightweight local RMS voice-activity detection. When the
user starts speaking over ABxAG, queued PCM playback stops immediately and the
backend receives explicit start/stop/interruption events. The interrupted text
fragment is retained in cognitive state so the next turn can supersede it.

Silence is state, not a timer-driven prompt. No rule asks the user why they are
quiet after a fixed interval.

## Persistence

Packaged builds store data below Electron's per-user `ABxAG_DATA_DIR`. Development
keeps mutable cognition data under `.abxag-data` so Vite never treats a memory
write as a source-code change. Cognitive files are:

- `.abxag-data/cognition/memories.v1.json` (development)
- `.abxag-data/cognition/goals.v1.json` (development)
- `.abxag-data/cognition/skills.v1.json` (development)
- `.abxag-data/cognition/last-session.json` (development)
- `logs/cognition.log`
- `logs/model_history.log`

Writes use temporary files followed by atomic rename. Pending confirmations and
in-flight state-changing actions are deliberately not restored after restart.

## Safety behavior

- Risk 0 read operations execute automatically when their permission is on.
- Risk 1 reversible operations normally execute automatically.
- Risk 2 moderate actions execute only within the configured permission.
- Risk 3/4 actions return `confirmation_required` and a short-lived ID. They do
  not execute until the user explicitly confirms and the model calls
  `confirmPendingAction` with that ID.
- Existing power actions retain their separate single-use Python confirmation
  token as defense in depth.
- "Stop", "cancel", and "don't do that" cancel active and pending execution.
- `PAUSE_AUTONOMY` and `/api/cognition/pause` stop autonomous speaking/planning/
  acting while leaving the normal app recoverable.
- The Node backend binds to loopback. Web proxy destinations block loopback,
  private, link-local and credential-bearing URLs.
- Tool logs record argument names, not values.

## Developer APIs

- `GET /api/cognition/status`
- `POST /api/cognition/pause`
- `POST /api/cognition/resume`
- `POST /api/cognition/simulate` (development/debug only)
- `POST /api/cognition/confirm`
- `GET|POST /api/goals`
- `POST /api/goals/:goalId/plan`
- `PATCH /api/goals/:goalId/tasks/:taskId`
- `POST /api/goals/:goalId/cancel`
- `GET|POST /api/skills`
- `POST /api/skills/:skillId/outcome`
- `GET /api/api-hub/status`
- `GET /api/api-hub/search`
- `POST /api/api-hub/sync`
- `GET /api/api-hub/adapters`

## Phased status

1. Audit and compatibility baseline: complete.
2. Event bus, situation model and observability: complete.
3. Attention, novelty suppression and initiative: complete.
4. Local barge-in, interruption and contextual silence state: complete.
5. Structured memory, correction, retrieval, decay and legacy migration:
   complete for local lexical retrieval; optional embeddings remain future work.
6. Goals, bounded model planning, cancellation and critic: implemented; a
   general autonomous task runner remains intentionally disabled until each
   tool has sufficient precondition/outcome schemas.
7. Verified skill persistence and outcome learning: implemented; automatic UI
   demonstration capture/generalization remains future work.
8. Desktop awareness: active app, visible apps, idle state, downloads and disk
   are implemented. OS-wide pre-delete interception and crash attribution need
   platform-specific hooks and are not claimed as complete.
9. Performance: local polling is bounded, unchanged screen-share frames are
   suppressed with a tiny local luminance diff plus sparse heartbeat, and model
   calls are deduplicated, cached and rate-limited. Production telemetry tuning
   remains ongoing.
10. Integration: automated cognition and Python tests plus TypeScript and
    production builds are available; live Gemini/microphone/Electron smoke tests
    still require the installed desktop runtime and user devices.
11. Public API hub: automatic upstream import, duplicate detection, readiness
    states, capability retrieval, bounded health checks, safe adapter execution,
    and initial weather/rocket adapters are implemented. Broad automatic
    documentation-to-adapter generation remains verification-gated by design.



