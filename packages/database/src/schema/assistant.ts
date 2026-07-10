// Durable assistant authority: sessions, workflows, prepared actions, execution attempts,
// append-only events, and atomic public rate-limit windows. Conversation transcripts live
// in the dedicated Agent Durable Objects; D1 remains authoritative for identity, approvals,
// idempotency, resource preconditions, and audit outcomes.

import type { InferSelectModel } from "drizzle-orm";
import {
  index,
  integer,
  real,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { UNIX_NOW } from "./shared";

export const assistantSessions = sqliteTable("assistant_sessions", {
  id: text("id").primaryKey(),
  surface: text("surface", { enum: ["admin", "storefront"] }).notNull(),
  actorType: text("actor_type", { enum: ["admin", "customer", "guest", "system"] }).notNull(),
  actorId: text("actor_id"),
  credentialHash: text("credential_hash").notNull(),
  conversationKey: text("conversation_key").notNull(),
  // Opaque Flue Durable Object instance selected by trusted API admission.
  // It is deliberately non-reversible and never acts as a browser credential.
  agentInstanceId: text("agent_instance_id"),
  status: text("status", { enum: ["active", "revoked", "expired"] }).notNull().default("active"),
  lastEventSequence: integer("last_event_sequence").notNull().default(0),
  permissionSnapshotHash: text("permission_snapshot_hash"),
  safeMetadata: text("safe_metadata"),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
  uniqueIndex("assistant_sessions_credential_hash_unique").on(table.credentialHash),
  uniqueIndex("assistant_sessions_conversation_key_unique").on(table.conversationKey),
  uniqueIndex("assistant_sessions_agent_instance_id_unique").on(table.agentInstanceId),
  index("assistant_sessions_actor_surface_idx").on(table.actorType, table.actorId, table.surface),
  index("assistant_sessions_status_expiry_idx").on(table.status, table.expiresAt),
]);

export const assistantWorkflows = sqliteTable("assistant_workflows", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => assistantSessions.id),
  clientRequestId: text("client_request_id").notNull(),
  intent: text("intent").notNull(),
  planRevision: integer("plan_revision").notNull().default(1),
  status: text("status", {
    enum: [
      "queued",
      "running",
      "input_required",
      "approval_required",
      "retrying",
      "succeeded",
      "failed",
      "compensating",
      "cancelled",
    ],
  }).notNull().default("queued"),
  riskClass: text("risk_class", {
    enum: ["read_only", "reversible", "consequential", "high_risk"],
  }).notNull().default("read_only"),
  currentStep: integer("current_step").notNull().default(0),
  parentWorkflowId: text("parent_workflow_id"),
  permissionSnapshotHash: text("permission_snapshot_hash"),
  safePlan: text("safe_plan").notNull().default("[]"),
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  cancelledAt: integer("cancelled_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
  uniqueIndex("assistant_workflows_session_request_unique").on(
    table.sessionId,
    table.clientRequestId,
  ),
  index("assistant_workflows_session_status_idx").on(table.sessionId, table.status, table.updatedAt),
  index("assistant_workflows_status_updated_idx").on(table.status, table.updatedAt),
]);

export const assistantActions = sqliteTable("assistant_actions", {
  id: text("id").primaryKey(),
  workflowId: text("workflow_id").notNull().references(() => assistantWorkflows.id),
  prepareRequestId: text("prepare_request_id").notNull(),
  stepIndex: integer("step_index").notNull().default(0),
  capability: text("capability").notNull(),
  permission: text("permission"),
  riskClass: text("risk_class", {
    enum: ["read_only", "reversible", "consequential", "high_risk"],
  }).notNull(),
  confirmationPolicy: text("confirmation_policy", {
    enum: ["none", "click", "explicit", "step_up"],
  }).notNull(),
  status: text("status", {
    enum: [
      "prepared",
      "approval_required",
      "approved",
      "executing",
      "succeeded",
      "failed",
      "expired",
      "cancelled",
      "superseded",
    ],
  }).notNull().default("prepared"),
  argumentsHash: text("arguments_hash").notNull(),
  encryptedArguments: text("encrypted_arguments").notNull(),
  expectedVersions: text("expected_versions").notNull().default("[]"),
  safeDisplay: text("safe_display").notNull(),
  permissionSnapshotHash: text("permission_snapshot_hash"),
  approvalTokenHash: text("approval_token_hash"),
  approvedBy: text("approved_by"),
  approvedAt: integer("approved_at", { mode: "timestamp" }),
  approvalExpiresAt: integer("approval_expires_at", { mode: "timestamp" }),
  affectedCount: integer("affected_count"),
  monetaryValue: real("monetary_value"),
  currency: text("currency"),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  executionLeaseId: text("execution_lease_id"),
  executionLeaseExpiresAt: integer("execution_lease_expires_at", { mode: "timestamp" }),
  retryCount: integer("retry_count").notNull().default(0),
  safeResult: text("safe_result"),
  errorCode: text("error_code"),
  safeError: text("safe_error"),
  executedAt: integer("executed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
  uniqueIndex("assistant_actions_workflow_prepare_request_unique").on(
    table.workflowId,
    table.prepareRequestId,
  ),
  uniqueIndex("assistant_actions_approval_token_hash_unique").on(table.approvalTokenHash),
  index("assistant_actions_workflow_step_idx").on(table.workflowId, table.stepIndex),
  index("assistant_actions_workflow_status_idx").on(table.workflowId, table.status, table.updatedAt),
  index("assistant_actions_status_expiry_idx").on(table.status, table.expiresAt),
  index("assistant_actions_execution_lease_idx").on(table.status, table.executionLeaseExpiresAt),
]);

export const assistantActionExecutions = sqliteTable("assistant_action_executions", {
  id: text("id").primaryKey(),
  actionId: text("action_id").notNull().references(() => assistantActions.id),
  clientRequestId: text("client_request_id").notNull(),
  idempotencyKeyHash: text("idempotency_key_hash").notNull(),
  attempt: integer("attempt").notNull().default(1),
  status: text("status", {
    enum: ["claimed", "succeeded", "failed", "abandoned"],
  }).notNull().default("claimed"),
  executorId: text("executor_id").notNull(),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
  uniqueIndex("assistant_action_executions_idempotency_unique").on(table.idempotencyKeyHash),
  uniqueIndex("assistant_action_executions_action_request_unique").on(
    table.actionId,
    table.clientRequestId,
  ),
  index("assistant_action_executions_action_status_idx").on(table.actionId, table.status),
  index("assistant_action_executions_status_started_idx").on(table.status, table.startedAt),
]);

export const assistantEvents = sqliteTable("assistant_events", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => assistantSessions.id),
  workflowId: text("workflow_id").references(() => assistantWorkflows.id),
  actionId: text("action_id").references(() => assistantActions.id),
  sequence: integer("sequence").notNull(),
  type: text("type").notNull(),
  status: text("status"),
  actorType: text("actor_type", { enum: ["admin", "customer", "guest", "system"] }).notNull(),
  actorId: text("actor_id"),
  traceId: text("trace_id"),
  safePayload: text("safe_payload").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
  uniqueIndex("assistant_events_session_sequence_unique").on(table.sessionId, table.sequence),
  index("assistant_events_workflow_sequence_idx").on(table.workflowId, table.sequence),
  index("assistant_events_action_idx").on(table.actionId, table.createdAt),
  index("assistant_events_created_idx").on(table.createdAt),
]);

export const assistantRateLimitWindows = sqliteTable("assistant_rate_limit_windows", {
  bucketHash: text("bucket_hash").notNull(),
  scope: text("scope").notNull(),
  windowStartedAt: integer("window_started_at", { mode: "timestamp" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  requestCount: integer("request_count").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
  primaryKey({
    name: "assistant_rate_limit_bucket_window_pk",
    columns: [table.bucketHash, table.scope, table.windowStartedAt],
  }),
  index("assistant_rate_limit_expiry_idx").on(table.expiresAt),
]);

export const assistantComputerHandoffs = sqliteTable("assistant_computer_handoffs", {
  sessionId: text("session_id").notNull().references(() => assistantSessions.id),
  agentInstanceId: text("agent_instance_id").notNull(),
  requestId: text("request_id").notNull(),
  programDigest: text("program_digest").notNull(),
  state: text("state", { enum: ["cancelled", "dispatched"] }).notNull(),
  ticketIssuedAtMs: integer("ticket_issued_at_ms").notNull(),
  ticketExpiresAt: integer("ticket_expires_at", { mode: "timestamp" }).notNull(),
  retentionExpiresAt: integer("retention_expires_at", { mode: "timestamp" }).notNull(),
  dispatchClaimHash: text("dispatch_claim_hash"),
  dispatchStatus: text("dispatch_status", {
    enum: ["claimed", "dispatching", "confirmed", "failed", "uncertain", "blocked"],
  }),
  dispatchConfirmedAt: integer("dispatch_confirmed_at", { mode: "timestamp" }),
  dispatchFailedAt: integer("dispatch_failed_at", { mode: "timestamp" }),
  dispatchUncertainAt: integer("dispatch_uncertain_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
  primaryKey({
    name: "assistant_computer_handoffs_instance_request_pk",
    columns: [table.agentInstanceId, table.requestId],
  }),
  index("assistant_computer_handoffs_retention_expiry_idx").on(table.retentionExpiresAt),
  index("assistant_computer_handoffs_instance_dispatch_idx").on(
    table.agentInstanceId,
    table.dispatchStatus,
    table.ticketIssuedAtMs,
  ),
]);

export const assistantComputerStopBarriers = sqliteTable("assistant_computer_stop_barriers", {
  sessionId: text("session_id").notNull().references(() => assistantSessions.id),
  agentInstanceId: text("agent_instance_id").primaryKey(),
  stoppedThroughIssuedAtMs: integer("stopped_through_issued_at_ms").notNull(),
  stopping: integer("stopping", { mode: "boolean" }).notNull().default(false),
  activeAdmissionId: text("active_admission_id"),
  activeAdmissionClaimHash: text("active_admission_claim_hash"),
  activeAdmissionExpiresAt: integer("active_admission_expires_at", { mode: "timestamp" }),
  lastStopCompletedAt: integer("last_stop_completed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
  index("assistant_computer_stop_barriers_session_idx").on(table.sessionId),
]);

export type AssistantSession = InferSelectModel<typeof assistantSessions>;
export type AssistantWorkflow = InferSelectModel<typeof assistantWorkflows>;
export type AssistantAction = InferSelectModel<typeof assistantActions>;
export type AssistantActionExecution = InferSelectModel<typeof assistantActionExecutions>;
export type AssistantEvent = InferSelectModel<typeof assistantEvents>;
export type AssistantRateLimitWindow = InferSelectModel<typeof assistantRateLimitWindows>;
export type AssistantComputerHandoff = InferSelectModel<typeof assistantComputerHandoffs>;
export type AssistantComputerStopBarrier = InferSelectModel<
  typeof assistantComputerStopBarriers
>;
