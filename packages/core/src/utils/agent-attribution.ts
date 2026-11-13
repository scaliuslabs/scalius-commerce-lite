// Which agent connection a dashboard write runs for, so the records staff read
// name it as well as the staff member it runs as (an agent's request runs as
// its grant's owner). The API sets it around an agent's request (admin-auth's
// agent lane, both the MCP and the direct REST lane); the order timeline
// writes it into each line's `data.via`. The agent audit row (one per agent
// call, apps/api/src/agent-access/audit.ts) is the complete record: grant,
// connection, client, approval and the ids the write touched.
//
// AsyncLocalStorage (nodejs_compat), as for the store time zone: each request
// has its own scope, promises created inside it (waitUntil work included)
// keep it, and a queue or cron invocation starts with none.
import { AsyncLocalStorage } from "node:async_hooks";

export interface AgentAttribution {
  grantId: string;
  /** The connection's name as the owner gave it ("Claude on my laptop"). */
  connection: string;
  /** The client it runs in ("Scalius CLI", an OAuth app's name), or null for an access key. */
  client: string | null;
  /** The dashboard approval this write ran on, when it needed one. */
  approvalId: string | null;
  /** The staff member who approved it (the grant's owner), when it needed approval. */
  approvedBy: string | null;
}

const context = new AsyncLocalStorage<AgentAttribution>();

/** Runs `callback` with the agent connection this request writes for. */
export function withAgentAttribution<T>(attribution: AgentAttribution, callback: () => T): T {
  return context.run(attribution, callback);
}

/** The agent connection the current request writes for, or null (staff, apps, the system). */
export function currentAgentAttribution(): AgentAttribution | null {
  return context.getStore() ?? null;
}

/** Records a dashboard approval for the rest of this request (the REST lane redeems it inside the scope). */
export function noteAgentApproval(approvalId: string, approvedBy: string): void {
  const attribution = context.getStore();
  if (!attribution) return;
  attribution.approvalId = approvalId;
  attribution.approvedBy = approvedBy;
}

/** What an order timeline line stores about the agent behind it (`data.via`). */
export interface TimelineAgentVia {
  kind: "agent";
  grantId: string;
  connection: string;
  client: string | null;
  approved: boolean;
}

/**
 * An order timeline line's `data` as stored: the facts it was given, plus
 * `via` when an agent's request wrote it. Every order-event insert stores its
 * data through this (timeline-attribution.test.ts holds each one to it).
 */
export function orderEventData(data: Record<string, unknown> | null | undefined): string | null {
  const attribution = currentAgentAttribution();
  if (!attribution) return data ? JSON.stringify(data) : null;
  const via: TimelineAgentVia = {
    kind: "agent",
    grantId: attribution.grantId,
    connection: attribution.connection,
    client: attribution.client,
    approved: attribution.approvalId !== null,
  };
  return JSON.stringify({ ...(data ?? {}), via });
}
