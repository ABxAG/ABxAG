export type CognitiveState =
  | "IDLE"
  | "OBSERVING"
  | "LISTENING"
  | "THINKING"
  | "SPEAKING"
  | "ACTING"
  | "WAITING"
  | "LEARNING"
  | "PLANNING"
  | "VERIFYING"
  | "INTERRUPTED"
  | "PAUSED";

export type EventSource =
  | "conversation"
  | "desktop"
  | "filesystem"
  | "screen"
  | "task"
  | "tool"
  | "memory"
  | "goal"
  | "internal"
  | "system"
  | "simulation";

export interface CognitiveEventInput {
  type: string;
  source: EventSource;
  timestamp?: string;
  importance?: number;
  confidence?: number;
  projectId?: string;
  correlationId?: string;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
}

export interface CognitiveEvent extends CognitiveEventInput {
  id: string;
  timestamp: string;
  importance: number;
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface SituationEventSummary {
  id: string;
  type: string;
  timestamp: string;
  importance: number;
  source: EventSource;
}

export interface PendingRisk {
  eventId: string;
  description: string;
  level: RiskLevel;
  confirmationId?: string;
}

export interface SituationSnapshot {
  state: CognitiveState;
  currentActivity: string | null;
  activeApp: string | null;
  activeWindow: string | null;
  currentProject: string | null;
  conversationTopic: string | null;
  currentGoalId: string | null;
  currentTaskId: string | null;
  userActivity: "active" | "idle" | "away";
  userSpeaking: boolean;
  abxagSpeaking: boolean;
  abxagWasInterrupted: boolean;
  silenceStartedAt: string | null;
  silenceSeconds: number;
  openApplications: string[];
  relevantFiles: string[];
  recentImportantEvents: SituationEventSummary[];
  recentFailures: SituationEventSummary[];
  recentSuccesses: SituationEventSummary[];
  pendingRisk: PendingRisk | null;
  autonomyPaused: boolean;
  updatedAt: string;
}

export interface AttentionFactors {
  relevance: number;
  novelty: number;
  urgency: number;
  risk: number;
  userImpact: number;
  taskRelevance: number;
  confidence: number;
  repetitionPenalty: number;
  interruptionCost: number;
}

export interface AttentionAssessment {
  eventId: string;
  score: number;
  factors: AttentionFactors;
  semanticKey: string;
  explanation: string[];
}

export type InitiativeAction =
  | "IGNORE"
  | "REMEMBER"
  | "OBSERVE"
  | "WAIT"
  | "SPEAK"
  | "ASK"
  | "WARN"
  | "ACT";

export interface InitiativeReason {
  reason: string;
  urgency: number;
  novelty: number;
  confidence: number;
  interruptionAllowed: boolean;
  suggestedTone: string;
}

export interface InitiativeDecision {
  eventId: string;
  action: InitiativeAction;
  attentionScore: number;
  reason: InitiativeReason;
  shouldGenerateSpeech: boolean;
  createdAt: string;
}

export type ThoughtOrigin =
  | "external"
  | "memory"
  | "curiosity"
  | "unfinished_thread"
  | "goal"
  | "observation"
  | "reflection"
  | "social"
  | "task";

export interface ThoughtCandidate {
  id: string;
  createdAt: number;
  origin: ThoughtOrigin;
  content: string;
  relevance: number;
  novelty: number;
  urgency: number;
  socialValue: number;
  confidence: number;
  relatedTopic?: string;
  relatedMemoryIds?: string[];
  expiresAt?: number;
  suggestedAction?: "REMEMBER" | "WAIT" | "SPEAK" | "ASK" | "SUGGEST" | "ACT" | "REVISIT_LATER";
}

export type ConversationThreadStatus =
  | "ACTIVE"
  | "PAUSED"
  | "RESOLVED"
  | "ABANDONED"
  | "INTERRUPTED"
  | "WAITING_FOR_USER"
  | "OPEN_ENDED";

export interface ConversationThread {
  id: string;
  topic: string;
  status: ConversationThreadStatus;
  importance: number;
  unresolvedPoints: string[];
  openQuestions: string[];
  lastUserStatement: string | null;
  lastABxAGStatement: string | null;
  interruptedThoughts: string[];
  possibleFollowups: string[];
  lastUserAt: number | null;
  lastABxAGAt: number | null;
  activeUntil: number;
  autonomousTurnsSinceUser: number;
}

export type SocialSilenceType =
  | "THINKING_SILENCE"
  | "WORKING_SILENCE"
  | "CONVERSATIONAL_PAUSE"
  | "USER_AWAY"
  | "AWKWARD_UNRESOLVED_SILENCE"
  | "NATURAL_END";

export interface SocialOpportunity {
  score: number;
  reason: string;
  userAvailability: number;
  topicRelevance: number;
  novelty: number;
  interruptionCost: number;
  continuationValue: number;
}

export interface CognitionCounters {
  cognitiveTicks: number;
  deepCognitiveMoments: number;
  internalThoughtsGenerated: number;
  internalThoughtsDropped: number;
  autonomousSpeechAttempts: number;
  autonomousSpeechCompleted: number;
  autonomousSpeechInterrupted: number;
  repetitionSuppressed: number;
}

export type CognitiveTurn =
  | { type: "user_speech"; text: string }
  | { type: "external_event"; event: CognitiveEvent }
  | { type: "internal_reflection"; thought: ThoughtCandidate }
  | { type: "curiosity"; thought: ThoughtCandidate }
  | { type: "memory_recall"; thought: ThoughtCandidate }
  | { type: "conversation_continuation"; thought: ThoughtCandidate }
  | { type: "goal_review"; thought: ThoughtCandidate };

export type RiskLevel = 0 | 1 | 2 | 3 | 4;

export type PermissionName =
  | "microphone"
  | "screen_awareness"
  | "filesystem_read"
  | "filesystem_write"
  | "desktop_control"
  | "browser"
  | "network"
  | "automation"
  | "code_execution"
  | "system_control";

export interface ToolDescriptor {
  name: string;
  purpose: string;
  permission: PermissionName;
  riskLevel: RiskLevel;
  timeoutMs: number;
  maxRetries: number;
}

export interface ToolExecutionContext {
  correlationId?: string;
  projectRoot?: string;
  confirmed?: boolean;
}

export type ToolExecutionStatus =
  | "succeeded"
  | "failed"
  | "denied"
  | "confirmation_required"
  | "cancelled"
  | "timed_out";

export interface ToolExecutionResult<T = unknown> {
  success: boolean;
  status: ToolExecutionStatus;
  tool: string;
  result: T | null;
  error: string | null;
  riskLevel: RiskLevel;
  confirmationId?: string;
  durationMs: number;
  attempts: number;
}

export type MemoryKind =
  | "working"
  | "episodic"
  | "semantic"
  | "preference"
  | "project"
  | "correction"
  | "skill";

export interface StructuredMemory {
  id: string;
  kind: MemoryKind;
  content: string;
  projectId: string | null;
  entities: string[];
  tags: string[];
  confidence: number;
  confirmations: number;
  importance: number;
  source: string;
  sourceId?: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  accessCount: number;
  expiresAt: string | null;
  supersedesId?: string;
  active: boolean;
}

export interface MemoryQuery {
  text?: string;
  projectId?: string | null;
  kinds?: MemoryKind[];
  entities?: string[];
  limit?: number;
  minConfidence?: number;
}

export interface GoalTask {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "blocked";
  priority: number;
  dependsOn: string[];
  attempts: number;
  maxRetries: number;
  timeoutMs: number;
  progress: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Goal {
  id: string;
  objective: string;
  constraints: string[];
  successCriteria: string[];
  priority: number;
  status: "pending" | "planning" | "active" | "completed" | "failed" | "cancelled" | "blocked";
  projectId: string | null;
  tasks: GoalTask[];
  blockers: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LearnedSkill {
  id: string;
  name: string;
  description: string;
  preconditions: string[];
  steps: Array<{
    id: string;
    action: string;
    tool?: string;
    arguments?: Record<string, unknown>;
  }>;
  expectedOutcome: string;
  projectId: string | null;
  confidence: number;
  uses: number;
  successes: number;
  failures: number;
  successRate: number;
  verified: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export type ModelCapability =
  | "fast"
  | "reasoning"
  | "coding"
  | "vision"
  | "research"
  | "embedding"
  | "speech";

export interface ModelCallResult {
  text: string;
  model: string;
  capability: ModelCapability;
  durationMs: number;
  cached: boolean;
  attempts: number;
}

export interface CriticVerdict {
  passed: boolean;
  retryRecommended: boolean;
  reason: string;
  missing: string[];
}


