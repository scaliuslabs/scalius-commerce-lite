// The scripted agent: the tool calls a careful model makes for a task
// (search, describe, dry run, confirm, write, verify), each one a recorded
// MCP call. A failing step throws with the tool's own error, which becomes
// the task's evidence.

import type { McpEvalSession, ToolResult } from "./session";

export class TaskStepError extends Error {
  constructor(readonly step: string, readonly detail: unknown) {
    super(`${step}: ${JSON.stringify(detail).slice(0, 700)}`);
  }
}

export interface RoutingNote {
  query: string;
  expected: string[];
  /** 0-based rank of the first hit covering the expected operations, -1 when none of the hits does. */
  rank: number;
  top: string[];
}

type Input = { path?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown };

export class ScriptedAgent {
  readonly routing: RoutingNote[] = [];

  constructor(private readonly session: McpEvalSession) {}

  private structured(result: ToolResult, step: string): Record<string, unknown> {
    const value = result.structuredContent ?? {};
    if (result.isError || value.ok !== true) throw new TaskStepError(step, value.error ?? value);
    return value;
  }

  /** scalius_search; records where the expected operation set ranks. */
  async search(query: string, expected: string[]): Promise<void> {
    const value = this.structured(await this.session.call("scalius_search", { query }), "scalius_search");
    const hits = (value.hits ?? []) as Array<{ id: string; kind: string; operationIds?: string[] }>;
    const covers = (hit: (typeof hits)[number]) => {
      const ids = hit.kind === "operation" ? [hit.id] : hit.operationIds ?? [];
      return expected.every((id) => ids.includes(id));
    };
    let rank = hits.findIndex(covers);
    if (rank < 0) {
      // A model can also combine single-operation hits.
      const ids = new Set(hits.flatMap((hit) => (hit.kind === "operation" ? [hit.id] : hit.operationIds ?? [])));
      if (expected.every((id) => ids.has(id))) rank = hits.length;
    }
    this.routing.push({ query, expected, rank, top: hits.slice(0, 3).map((hit) => hit.id) });
  }

  async describe(ids: string[], detail?: "compact" | "full"): Promise<Array<Record<string, unknown>>> {
    const value = this.structured(
      await this.session.call("scalius_describe", { ids, ...(detail ? { detail } : {}) }),
      "scalius_describe",
    );
    const operations = (value.operations ?? []) as Array<Record<string, unknown>>;
    const missing = operations.filter((operation) => operation.error);
    if (missing.length > 0) throw new TaskStepError("scalius_describe", missing);
    return operations;
  }

  async answer(question: string): Promise<Record<string, unknown>> {
    return this.structured(await this.session.call("scalius_answer", { question }), "scalius_answer");
  }

  async read(operationId: string, input: Input = {}, options: { select?: string[]; limit?: number; maxBytes?: number } = {}) {
    const value = this.structured(
      await this.session.call("scalius_read", { operationId, input, ...options }),
      operationId,
    );
    // An artifact (export, large document) comes back as {artifact, meta}, not data.
    return (value.data ?? value) as Record<string, unknown>;
  }

  async readSteps(steps: Array<{ id: string; operationId: string; input?: Input }>) {
    const value = this.structured(await this.session.call("scalius_read", { steps }), "scalius_read steps");
    return Object.fromEntries(((value.steps ?? []) as Array<{ id: string; data: unknown }>).map((step) => [step.id, step.data])) as Record<string, Record<string, unknown>>;
  }

  /**
   * A change the way the instructions ask for it: dry run first, then the
   * write, carrying the confirm token when the dry run returned one (a
   * destructive or financial step the merchant approved).
   */
  async change(operationId: string, input: Input): Promise<{ data: Record<string, unknown>; preview: Record<string, unknown> }> {
    const preview = this.structured(
      await this.session.call("scalius_write", { operationId, input, dryRun: true }),
      `${operationId} dryRun`,
    );
    const token = (preview.confirmation as { confirmToken?: string } | undefined)?.confirmToken;
    const value = this.structured(
      await this.session.call("scalius_write", { operationId, input, ...(token ? { confirmToken: token } : {}) }),
      operationId,
    );
    return { data: (value.data ?? value) as Record<string, unknown>, preview };
  }

  /** Several changes in order (later steps may reference earlier results): one dry run, then one write. */
  async changeSteps(steps: Array<{ id: string; operationId: string; input?: Record<string, unknown> }>) {
    const preview = this.structured(await this.session.call("scalius_write", { steps, dryRun: true }), "scalius_write steps dryRun");
    const token = (preview.confirmation as { confirmToken?: string } | undefined)?.confirmToken;
    const value = this.structured(
      await this.session.call("scalius_write", { steps, ...(token ? { confirmToken: token } : {}) }),
      "scalius_write steps",
    );
    return Object.fromEntries(((value.steps ?? []) as Array<{ id: string; data: unknown }>).map((step) => [step.id, step.data])) as Record<string, Record<string, unknown>>;
  }

  /** The required client action a direct-transport operation hands back (CLI lane). */
  async clientAction(operationId: string, input: Input): Promise<Record<string, unknown>> {
    return this.structured(await this.session.call("scalius_write", { operationId, input }), operationId);
  }
}

/** The first array of objects in a route payload (items, orders, variants...). */
export function rowsOf(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === "object") {
    for (const value of Object.values(data)) {
      if (Array.isArray(value) && (value.length === 0 || typeof value[0] === "object")) return value as Array<Record<string, unknown>>;
    }
  }
  return [];
}
