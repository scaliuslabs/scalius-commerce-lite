import type { Database } from "@scalius/database/client";
import {
  assistantActionExecutions,
  assistantActions,
  assistantEvents,
  assistantRateLimitWindows,
  assistantSessions,
  assistantWorkflows,
} from "@scalius/database/schema";

type SessionRow = typeof assistantSessions.$inferSelect;
type WorkflowRow = typeof assistantWorkflows.$inferSelect;
type ActionRow = typeof assistantActions.$inferSelect;
type ExecutionRow = typeof assistantActionExecutions.$inferSelect;
type EventRow = typeof assistantEvents.$inferSelect;
type RateLimitRow = typeof assistantRateLimitWindows.$inferSelect;
type Table =
  | typeof assistantSessions
  | typeof assistantWorkflows
  | typeof assistantActions
  | typeof assistantActionExecutions
  | typeof assistantEvents
  | typeof assistantRateLimitWindows;

interface LazyStatement<T> extends PromiseLike<T> {
  execute(): Promise<T>;
}

export interface FakeAssistantAuthorityState {
  sessions: SessionRow[];
  workflows: WorkflowRow[];
  actions: ActionRow[];
  executions: ExecutionRow[];
  events: EventRow[];
  rateLimits: RateLimitRow[];
  rateLimitCeiling: number;
  batches: number[];
  failNextBatchAt: number | null;
  sessionTouchUpdates: number;
}

export function createFakeAssistantAuthorityDb(
  options: { rateLimitCeiling?: number } = {},
): { db: Database; state: FakeAssistantAuthorityState } {
  const state: FakeAssistantAuthorityState = {
    sessions: [],
    workflows: [],
    actions: [],
    executions: [],
    events: [],
    rateLimits: [],
    rateLimitCeiling: options.rateLimitCeiling ?? 2,
    batches: [],
    failNextBatchAt: null,
    sessionTouchUpdates: 0,
  };
  let batchTail: Promise<void> = Promise.resolve();

  const db = {
    insert: (table: Table) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: () => statement(() => insertRow(state, table, values, true)),
        }),
        returning: () => statement(() => insertRow(state, table, values, false)),
      }),
      select: (query: unknown) => ({
        returning: () => statement(() => insertSelectedExecution(state, table, query)),
      }),
    }),
    select: () => ({
      from: (table: Table) => ({
        where: () => {
          const limitRows = async (limit: number) => rowsForTable(state, table)
            .slice(0, limit)
            .map((row) => clone(row));
          return {
            get: async () => clone(firstRow(state, table)),
            limit: limitRows,
            orderBy: () => ({ limit: limitRows }),
          };
        },
      }),
    }),
    update: (table: Table) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const build = () => statement(() => updateRow(state, table, values));
          const direct = build();
          return {
            returning: () => build(),
            then: direct.then.bind(direct),
          };
        },
      }),
    }),
    delete: (table: Table) => ({
      where: () => ({
        returning: () => statement(() => deleteRows(state, table)),
      }),
    }),
    batch: (statements: LazyStatement<unknown>[]) => {
      const run = async () => {
        state.batches.push(statements.length);
        const snapshot = snapshotRows(state);
        const failAt = state.failNextBatchAt;
        state.failNextBatchAt = null;
        const results: unknown[] = [];
        try {
          for (let index = 0; index < statements.length; index += 1) {
            if (index === failAt) throw new Error("Injected assistant batch failure.");
            results.push(await statements[index]!.execute());
          }
          return results;
        } catch (error) {
          restoreRows(state, snapshot);
          throw error;
        }
      };
      const result = batchTail.then(run, run);
      batchTail = result.then(() => undefined, () => undefined);
      return result;
    },
  } as unknown as Database;

  return { db, state };
}

function insertSelectedExecution(
  state: FakeAssistantAuthorityState,
  table: Table,
  query: unknown,
): Record<string, unknown>[] {
  if (table !== assistantActionExecutions) {
    throw new Error("Fake insert-select only supports assistant executions.");
  }
  const values = collectSqlInterpolations(query);
  const [
    id,
    actionId,
    clientRequestId,
    idempotencyKeyHash,
    executorId,
    startedAt,
    createdAt,
    guardedActionId,
    leaseId,
  ] = values;
  const action = state.actions.find((row) => row.id === guardedActionId);
  if (
    !action ||
    action.status !== "executing" ||
    action.executionLeaseId !== leaseId
  ) {
    return [];
  }
  return insertRow(state, table, {
    id,
    actionId,
    clientRequestId,
    idempotencyKeyHash,
    attempt: 1,
    status: "claimed",
    executorId,
    startedAt: new Date(Number(startedAt) * 1_000),
    completedAt: null,
    createdAt: new Date(Number(createdAt) * 1_000),
  }, false);
}

function collectSqlInterpolations(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(collectSqlInterpolations);
  if (value === null || value === undefined) return [];
  if (typeof value !== "object") return [value];
  const chunks = (value as { queryChunks?: unknown }).queryChunks;
  return Array.isArray(chunks) ? chunks.flatMap(collectSqlInterpolations) : [];
}

function statement<T>(operation: () => T | Promise<T>): LazyStatement<T> {
  let pending: Promise<T> | undefined;
  const execute = () => {
    pending ??= Promise.resolve().then(operation);
    return pending;
  };
  return {
    execute,
    then: (onfulfilled, onrejected) => execute().then(onfulfilled, onrejected),
  };
}

function insertRow(
  state: FakeAssistantAuthorityState,
  table: Table,
  values: Record<string, unknown>,
  ignoreConflict: boolean,
): Record<string, unknown>[] {
  const rows = rowsForTable(state, table);
  const conflict = hasInsertConflict(state, table, values);
  if (conflict) {
    if (ignoreConflict) return [];
    if (table === assistantActionExecutions) {
      throw new Error(
        "UNIQUE constraint failed: assistant_action_executions.idempotency_key_hash",
      );
    }
    if (table === assistantEvents) {
      throw new Error(
        "UNIQUE constraint failed: assistant_events.session_id, assistant_events.sequence",
      );
    }
    throw new Error("UNIQUE constraint failed");
  }

  const row = materializeInsertedRow(table, values);
  rows.push(row);
  return [clone(row) as Record<string, unknown>];
}

function updateRow(
  state: FakeAssistantAuthorityState,
  table: Table,
  values: Record<string, unknown>,
): Record<string, unknown>[] {
  const row = firstRow(state, table);
  if (!row || !canApplyUpdate(state, table, row, values)) return [];

  if (table === assistantSessions && values.lastSeenAt instanceof Date) {
    state.sessionTouchUpdates += 1;
  }

  for (const [key, value] of Object.entries(values)) {
    if (
      (key === "retryCount" || key === "attempt" || key === "requestCount") &&
      value !== null &&
      typeof value === "object"
    ) {
      row[key] = Number(row[key] ?? 0) + 1;
    } else {
      row[key] = value;
    }
  }
  return [clone(row) as Record<string, unknown>];
}

function canApplyUpdate(
  state: FakeAssistantAuthorityState,
  table: Table,
  row: Record<string, unknown>,
  values: Record<string, unknown>,
): boolean {
  const now = values.updatedAt instanceof Date ? values.updatedAt : new Date(0);
  if (table === assistantSessions) {
    if (typeof values.lastEventSequence === "number") {
      return values.lastEventSequence === Number(row.lastEventSequence) + 1;
    }
    if (values.status === "revoked") return row.status === "active";
    if (values.status === "expired") {
      return row.status === "active" && (row.expiresAt as Date) <= now;
    }
    if (values.lastSeenAt instanceof Date) {
      return row.status === "active" && (row.expiresAt as Date) > now;
    }
    return true;
  }

  if (table === assistantActions) {
    if (values.status === "approved" && values.approvalTokenHash) {
      return row.status === "approval_required" &&
        row.approvalTokenHash == null &&
        (row.expiresAt as Date) > now;
    }
    if (values.status === "executing") {
      return (row.status === "prepared" || row.status === "approved") &&
        (row.expiresAt as Date) > now;
    }
    if (values.status === "succeeded" || values.status === "failed") {
      const execution = state.executions[0];
      return row.status === "executing" &&
        row.executionLeaseId != null &&
        execution?.status === "claimed";
    }
    if (values.status === "expired") {
      return (row.status === "prepared" || row.status === "approval_required" || row.status === "approved") &&
        (row.expiresAt as Date) <= now;
    }
    if (values.status === "prepared" || values.status === "approved") {
      return row.status === "executing";
    }
    if (typeof values.executionLeaseId === "string") {
      const execution = state.executions[0];
      return row.status === "executing" &&
        execution?.status === "claimed" &&
        (!(row.executionLeaseExpiresAt instanceof Date) || row.executionLeaseExpiresAt <= now);
    }
    if (values.executionLeaseExpiresAt instanceof Date) return row.status === "executing";
    return true;
  }

  if (table === assistantActionExecutions) {
    if (values.status === "succeeded" || values.status === "failed") {
      return row.status === "claimed" && state.actions[0]?.status === values.status;
    }
    if (typeof values.executorId === "string") {
      return row.status === "claimed" &&
        state.actions[0]?.status === "executing" &&
        typeof state.actions[0]?.executionLeaseId === "string";
    }
    return true;
  }

  if (table === assistantWorkflows) {
    const action = state.actions[0];
    const execution = state.executions[0];
    if (values.status === "running") {
      return action?.status === "prepared" ||
        action?.status === "approved" ||
        action?.status === "executing" ||
        (action?.status === "succeeded" && execution?.status === "succeeded");
    }
    if (values.status === "succeeded" || values.status === "failed") {
      return action?.status === values.status && execution?.status === values.status;
    }
    return true;
  }

  if (table === assistantRateLimitWindows) {
    return Number(row.requestCount) < state.rateLimitCeiling &&
      (row.expiresAt as Date) > now;
  }
  return true;
}

function deleteRows(
  state: FakeAssistantAuthorityState,
  table: Table,
): Record<string, unknown>[] {
  const rows = rowsForTable(state, table);
  const removed = rows.splice(0, rows.length);
  return removed.map((row) => clone(row) as Record<string, unknown>);
}

function hasInsertConflict(
  state: FakeAssistantAuthorityState,
  table: Table,
  values: Record<string, unknown>,
): boolean {
  if (table === assistantSessions) {
    return state.sessions.some((row) => (
      row.conversationKey === values.conversationKey ||
      row.credentialHash === values.credentialHash
    ));
  }
  if (table === assistantWorkflows) {
    return state.workflows.some((row) => (
      row.sessionId === values.sessionId && row.clientRequestId === values.clientRequestId
    ));
  }
  if (table === assistantActions) {
    return state.actions.some((row) => (
      row.workflowId === values.workflowId && row.prepareRequestId === values.prepareRequestId
    ));
  }
  if (table === assistantActionExecutions) {
    return state.executions.some((row) => (
      row.idempotencyKeyHash === values.idempotencyKeyHash ||
      (row.actionId === values.actionId && row.clientRequestId === values.clientRequestId)
    ));
  }
  if (table === assistantEvents) {
    return state.events.some((row) => (
      row.sessionId === values.sessionId && row.sequence === values.sequence
    ));
  }
  if (table === assistantRateLimitWindows) {
    return state.rateLimits.some((row) => (
      row.bucketHash === values.bucketHash &&
      row.scope === values.scope &&
      row.windowStartedAt.getTime() === (values.windowStartedAt as Date).getTime()
    ));
  }
  return false;
}

function materializeInsertedRow(
  table: Table,
  values: Record<string, unknown>,
): Record<string, unknown> {
  if (table === assistantSessions) {
    return {
      agentInstanceId: null,
      revokedAt: null,
      ...values,
    };
  }
  if (table === assistantWorkflows) {
    return {
      planRevision: 1,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      ...values,
    };
  }
  if (table === assistantActions) {
    return {
      approvalTokenHash: null,
      approvedBy: null,
      approvedAt: null,
      approvalExpiresAt: null,
      executionLeaseId: null,
      executionLeaseExpiresAt: null,
      retryCount: 0,
      safeResult: null,
      errorCode: null,
      safeError: null,
      executedAt: null,
      ...values,
    };
  }
  if (table === assistantActionExecutions) {
    return { completedAt: null, ...values };
  }
  return { ...values };
}

function firstRow(
  state: FakeAssistantAuthorityState,
  table: Table,
): Record<string, unknown> | undefined {
  return rowsForTable(state, table)[0];
}

function rowsForTable(
  state: FakeAssistantAuthorityState,
  table: Table,
): Record<string, unknown>[] {
  if (table === assistantSessions) return state.sessions as unknown as Record<string, unknown>[];
  if (table === assistantWorkflows) return state.workflows as unknown as Record<string, unknown>[];
  if (table === assistantActions) return state.actions as unknown as Record<string, unknown>[];
  if (table === assistantActionExecutions) {
    return state.executions as unknown as Record<string, unknown>[];
  }
  if (table === assistantEvents) return state.events as unknown as Record<string, unknown>[];
  return state.rateLimits as unknown as Record<string, unknown>[];
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

type RowSnapshot = Pick<
  FakeAssistantAuthorityState,
  "sessions" | "workflows" | "actions" | "executions" | "events" | "rateLimits"
>;

function snapshotRows(state: FakeAssistantAuthorityState): RowSnapshot {
  return structuredClone({
    sessions: state.sessions,
    workflows: state.workflows,
    actions: state.actions,
    executions: state.executions,
    events: state.events,
    rateLimits: state.rateLimits,
  });
}

function restoreRows(state: FakeAssistantAuthorityState, snapshot: RowSnapshot): void {
  state.sessions.splice(0, state.sessions.length, ...snapshot.sessions);
  state.workflows.splice(0, state.workflows.length, ...snapshot.workflows);
  state.actions.splice(0, state.actions.length, ...snapshot.actions);
  state.executions.splice(0, state.executions.length, ...snapshot.executions);
  state.events.splice(0, state.events.length, ...snapshot.events);
  state.rateLimits.splice(0, state.rateLimits.length, ...snapshot.rateLimits);
}
