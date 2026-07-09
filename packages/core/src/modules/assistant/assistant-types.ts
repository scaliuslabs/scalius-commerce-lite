import type {
  AssistantActionResult,
  AssistantActorType,
  AssistantMessagePart,
  AssistantRiskClass,
  AssistantSurface,
  AssistantWorkflowStatus,
} from "@scalius/shared/assistant-contracts";

export interface AssistantAuthorizationAssertion {
  granted: boolean;
  permissionSnapshotHash: string | null;
}

export interface AssistantSessionView {
  id: string;
  surface: AssistantSurface;
  actorType: AssistantActorType;
  actorId: string | null;
  conversationKey: string;
  status: "active" | "revoked" | "expired";
  permissionSnapshotHash: string | null;
  safeMetadata: unknown | null;
  lastEventSequence: number;
  expiresAt: number;
  lastSeenAt: number;
}

export interface AssistantWorkflowView {
  id: string;
  sessionId: string;
  clientRequestId: string;
  intent: string;
  status: AssistantWorkflowStatus;
  riskClass: AssistantRiskClass;
  currentStep: number;
  permissionSnapshotHash: string | null;
  safePlan: AssistantMessagePart[];
  createdAt: number;
  updatedAt: number;
}

export interface AssistantArgumentsParser<TArguments extends Record<string, unknown>> {
  parse(value: unknown): TArguments;
}

export interface AssistantConfirmationDisplay {
  title: string;
  summary: string;
  consequences?: string[];
  confirmLabel: string;
}

export interface ClaimedAssistantExecution<TArguments extends Record<string, unknown>> {
  actionId: string;
  workflowId: string;
  sessionId: string;
  executionId: string;
  leaseId: string;
  executorId: string;
  capability: string;
  argumentsHash: string;
  arguments: TArguments;
  expectedVersions: unknown[];
  permission: string | null;
  riskClass: AssistantRiskClass;
  leaseExpiresAt: number;
}

export type ClaimAssistantExecutionResult<TArguments extends Record<string, unknown>> =
  | { status: "claimed"; claim: ClaimedAssistantExecution<TArguments> }
  | { status: "processing"; actionId: string; workflowId: string; leaseExpiresAt: number }
  | { status: "replay"; result: AssistantActionResult };

export interface AssistantEventView {
  eventId: string;
  sessionId: string;
  workflowId: string | null;
  actionId: string | null;
  sequence: number;
  type: string;
  status: string | null;
  occurredAt: number;
  parts: AssistantMessagePart[];
}

export interface ListAssistantEventsResult {
  session: AssistantSessionView;
  events: AssistantEventView[];
  cursor: {
    afterSequence: number;
    nextSequence: number;
    latestSequence: number;
    hasMore: boolean;
  };
}

export interface AssistantRateLimitResult {
  allowed: true;
  count: number;
  remaining: number;
  resetAt: number;
}

export interface CleanupAssistantRateLimitsResult {
  scanned: number;
  deleted: number;
  limit: number;
  hasMore: boolean;
}
