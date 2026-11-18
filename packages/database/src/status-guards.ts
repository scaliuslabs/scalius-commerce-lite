// The stored guard on each queue table's `status`
// (rules/data/status-checks-match-declared-states.md): it refuses any status
// its declared list does not name. On SQLite it is two guard triggers per
// table, one on insert and one on a status change, because adding a CHECK
// there means rebuilding the table (every row written again, and on
// event_outbox every event trigger reinstalled). The guard is the trigger's
// WHEN; the body only raises and writes no row (remote D1 refuses a CASE in a
// trigger body). On PostgreSQL it is a CHECK, added in place. When the schema
// baseline is squashed the SQLite guard becomes a CHECK too.
//
// Migration 0221 installs both forms (generated here; its test keeps them
// equal), and the PostgreSQL schema compiler turns the SQLite triggers into
// the same CHECKs, so a fresh schema equals an upgraded one.
import { EVENT_OUTBOX_STATUSES, WEBHOOK_DELIVERY_STATUSES } from "./schema/events";
import { NOTIFICATION_OUTBOX_STATUSES, NOTIFICATION_RECEIPT_STATUSES } from "./schema/notifications";
import { WEBHOOK_EVENT_STATUSES } from "./schema/orders";
import { PLUGIN_EVENT_DELIVERY_STATUSES } from "./schema/plugins";

export interface StatusGuard {
  table: string;
  statuses: readonly string[];
  /** States an older release stored that no writer writes any more, and the declared state each maps to. */
  retired?: { from: readonly string[]; to: string; releasesClaim: boolean };
}

/** Retired by 0148 (queue retirement); a row the old Worker wrote after 0148 ran is mapped again. */
const RETIRED_QUEUE_STATES = { from: ["enqueueing", "queued"], to: "pending", releasesClaim: true } as const;

export const STATUS_GUARDS: readonly StatusGuard[] = [
  { table: "event_outbox", statuses: EVENT_OUTBOX_STATUSES, retired: RETIRED_QUEUE_STATES },
  { table: "webhook_event_deliveries", statuses: WEBHOOK_DELIVERY_STATUSES, retired: RETIRED_QUEUE_STATES },
  { table: "plugin_event_deliveries", statuses: PLUGIN_EVENT_DELIVERY_STATUSES, retired: RETIRED_QUEUE_STATES },
  { table: "notification_outbox", statuses: NOTIFICATION_OUTBOX_STATUSES, retired: RETIRED_QUEUE_STATES },
  { table: "notification_delivery_receipts", statuses: NOTIFICATION_RECEIPT_STATUSES },
  // `queued` was written until the queue retirement (markWebhookEventQueued); 0148 failed such events.
  { table: "webhook_events", statuses: WEBHOOK_EVENT_STATUSES, retired: { from: ["queued"], to: "failed", releasesClaim: false } },
];

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");

/** The name the guard's refusal carries: the constraint's name on PostgreSQL. */
export const statusCheckName = (table: string) => `${table}_status_check`;

export interface StatusGuardTrigger {
  name: string;
  table: string;
  event: "insert" | "update";
  sqlite: string;
}

/** The two SQLite guard triggers of a table (no trailing semicolon). */
export function statusGuardTriggers(guard: StatusGuard): StatusGuardTrigger[] {
  return (["insert", "update"] as const).map((event) => ({
    name: `${guard.table}_status_${event}_guard`,
    table: guard.table,
    event,
    sqlite: `CREATE TRIGGER \`${guard.table}_status_${event}_guard\`
BEFORE ${event === "insert" ? "INSERT" : "UPDATE OF `status`"} ON \`${guard.table}\`
WHEN NEW.\`status\` NOT IN (${list(guard.statuses)})
BEGIN
  SELECT RAISE(ABORT, '${statusCheckName(guard.table)}');
END`,
  }));
}

/** The PostgreSQL CHECK of a table, replacing any older one of the same name. */
export function statusGuardPostgresCheck(guard: StatusGuard): string {
  const name = statusCheckName(guard.table);
  return `ALTER TABLE "${guard.table}" DROP CONSTRAINT IF EXISTS "${name}", ADD CONSTRAINT "${name}" CHECK("${guard.table}"."status" IN (${list(guard.statuses)}))`;
}

/** The idempotent mapping of a table's retired states (written only to rows that hold one), or null. */
export function retiredStatusUpdate(guard: StatusGuard, dialect: "sqlite" | "postgres"): string | null {
  if (!guard.retired) return null;
  const q = (identifier: string) => (dialect === "sqlite" ? `\`${identifier}\`` : `"${identifier}"`);
  const release = guard.retired.releasesClaim
    ? `, ${q("claim_id")} = NULL, ${q("claim_expires_at")} = NULL, ${q("next_attempt_at")} = unixepoch()`
    : "";
  return `UPDATE ${q(guard.table)} SET ${q("status")} = '${guard.retired.to}'${release} WHERE ${q("status")} IN (${list(guard.retired.from)})`;
}

/** The SQLite trigger a guard compiles from, by trigger name: the PostgreSQL schema compiler's lookup. */
export function statusGuardByTrigger(name: string): { guard: StatusGuard; event: "insert" | "update" } | null {
  for (const guard of STATUS_GUARDS) {
    for (const trigger of statusGuardTriggers(guard)) if (trigger.name === name) return { guard, event: trigger.event };
  }
  return null;
}

/** Migration 0221's guard statements, in order: the retired states mapped first, then the guards. */
export function statusGuardMigrationStatements(): { sqlite: string[]; postgres: string[] } {
  return {
    sqlite: [
      ...STATUS_GUARDS.map((guard) => retiredStatusUpdate(guard, "sqlite")).filter((statement) => statement !== null),
      ...STATUS_GUARDS.flatMap((guard) => statusGuardTriggers(guard).map((trigger) => trigger.sqlite)),
    ],
    postgres: [
      ...STATUS_GUARDS.map((guard) => retiredStatusUpdate(guard, "postgres")).filter((statement) => statement !== null),
      ...STATUS_GUARDS.map(statusGuardPostgresCheck),
    ],
  };
}
