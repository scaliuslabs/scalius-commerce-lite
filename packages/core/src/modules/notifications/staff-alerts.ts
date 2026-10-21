import { sql, type SQL } from "drizzle-orm";
import { safeBatch, buildBatchGuard, isBatchGuardError, type Database } from "@scalius/database/client";
import { staffAlerts, staffAlertInbox, staffAlertState, user } from "@scalius/database/schema";
import { staffPermissionSql } from "@scalius/core/auth/rbac/helpers";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { isOrderNotificationType, isStaffAlertNotificationType } from "./notification-types";
import { staffPushPermission } from "./staff-push-policy";
import {
  STAFF_ALERT_SCOPES, STAFF_ALERT_PAGE_SIZE, STAFF_ALERT_MAX_PAGE_SIZE, STAFF_ALERT_COUNT_CAP,
  type StaffAlertScope, type StaffAlertKind, type StaffAlertSummary, type StaffAlertPage,
  type StaffAlertMutation, type StaffAlertClearInput, type StaffAlertReadAllInput, type StaffAlertUndoInput,
} from "./staff-alerts.contract";

const permission = (scope: StaffAlertScope) => scope === "orders" ? "orders.view" as const : "conversations.view" as const;
const scopeForKind = (kind: string): StaffAlertScope | null => kind === "conversation_message" ? "conversations"
  : isOrderNotificationType(kind) || isStaffAlertNotificationType(kind) ? "orders" : null;
const headSql = (userId: string) => sql`coalesce((SELECT last_seq FROM staff_alert_state WHERE user_id = ${userId} AND scope = '*'), 0)`;

/** Called after existing staff rules resolve, before attempting staff channels. No subscription is required. */
export async function recordStaffAlert(db: Database, outboxId: string | undefined, enabled: boolean): Promise<void> {
  if (!outboxId || !enabled) return;
  const [event] = await db.all<{ kind: string; subject_id: string; occurred_at: number; order_number: string | null; complete: number | null }>(sql`
    SELECT n.notification_type AS kind, n.subject_id, n.created_at AS occurred_at,
      CAST(o.order_number AS TEXT) AS order_number, a.fanout_complete AS complete
    FROM notification_outbox n LEFT JOIN staff_alerts a ON a.id = n.id LEFT JOIN conversations c ON c.id = n.conversation_id
    LEFT JOIN orders o ON o.id = coalesce(n.order_id, c.order_id) WHERE n.id = ${outboxId}`);
  if (!event || Number(event.complete) === 1) return;
  const scope = scopeForKind(event.kind);
  const required = staffPushPermission(event.kind);
  if (!scope || !required) return;
  const pending = sql`EXISTS (SELECT 1 FROM staff_alerts WHERE id = ${outboxId} AND fanout_complete = 0)`;
  // Resolve assignment inside the transaction: a stale/deactivated assignee
  // must not swallow a new message. Null falls back to the authorized team.
  const assignedRecipient = (ownerId: SQL) => event.kind === "conversation_message"
    ? sql`${ownerId} = coalesce((SELECT c.assignee_user_id FROM conversations c
        INNER JOIN notification_outbox n ON n.conversation_id = c.id
        WHERE n.id = ${outboxId} AND ${staffPermissionSql(sql`c.assignee_user_id`, "conversations.reply")}), ${ownerId})`
    : sql`1 = 1`;
  // One transaction fixes the first recipient set, even when empty. Provider
  // retries cannot retroactively deliver old facts to newly granted staff.
  await safeBatch(db, [
    db.insert(staffAlerts).values({ id: outboxId, scope, kind: event.kind, subjectId: event.subject_id,
      occurredAt: Number(event.occurred_at), orderNumber: event.order_number }).onConflictDoNothing(),
    db.insert(staffAlertState).select(sql`
      SELECT ${user.id}, '*', 0, NULL, 0, 0, 0, 0, 0, NULL FROM ${user}
      WHERE ${pending} AND ${staffPermissionSql(user.id, required)} AND ${assignedRecipient(sql`${user.id}`)}`).onConflictDoNothing(),
    // Lock/update the sentinel before selecting its sequence. PostgreSQL retries
    // 40001/40P01, not a later inbox PK violation (23505).
    db.update(staffAlertState).set({ lastSeq: sql`last_seq + 1`, allocatedAlertId: outboxId })
      .where(sql`scope = '*' AND ${pending} AND ${staffPermissionSql(staffAlertState.userId, required)}
        AND ${assignedRecipient(sql`${staffAlertState.userId}`)}
        AND NOT EXISTS (SELECT 1 FROM staff_alert_inbox i WHERE i.user_id = staff_alert_state.user_id AND i.alert_id = ${outboxId})`),
    db.insert(staffAlertInbox).select(sql`
      SELECT user_id, last_seq, ${outboxId}, ${scope}, NULL FROM staff_alert_state
      WHERE scope = '*' AND allocated_alert_id = ${outboxId} AND ${pending}`)
      .onConflictDoNothing({ target: [staffAlertInbox.alertId, staffAlertInbox.userId] }),
    db.update(staffAlerts).set({ fanoutComplete: true }).where(sql`id = ${outboxId} AND fanout_complete = 0`),
  ]);
}

function allowedScopesSql(userId: string): SQL {
  return sql.join(STAFF_ALERT_SCOPES.map((scope) => sql`SELECT ${scope} AS scope,
    coalesce(s.revision, 0) AS revision, coalesce(s.read_through, 0) AS read_through,
    coalesce(s.cleared_through, 0) AS cleared_through
    FROM (SELECT 1) AS one_row LEFT JOIN staff_alert_state s ON s.user_id = ${userId} AND s.scope = ${scope}
    WHERE ${staffPermissionSql(sql`${userId}`, permission(scope))}`), sql` UNION ALL `);
}

interface ReadRow {
  entry_type: number; head: number; scope: StaffAlertScope; revision: number;
  read_through: number; cleared_through: number; unread: number;
  seq: number | null; id: string | null; kind: StaffAlertKind | null; subject_id: string | null;
  occurred_at: number | null; order_number: string | null; is_read: number | null;
}
function readSql(userId: string, page?: { beforeSeq?: number; limit: number }): SQL {
  const base = sql`WITH allowed AS MATERIALIZED (${allowedScopesSql(userId)})`;
  const summary = sql`SELECT 0 AS entry_type, ${headSql(userId)} AS head, a.scope, a.revision, a.read_through, a.cleared_through,
    (SELECT count(*) FROM (SELECT 1 FROM staff_alert_inbox i
      WHERE i.user_id = ${userId} AND i.scope = a.scope AND i.read_at IS NULL AND i.seq > a.read_through LIMIT 100) AS unread_candidates) AS unread,
    NULL AS seq, NULL AS id, NULL AS kind, NULL AS subject_id, NULL AS occurred_at, NULL AS order_number, NULL AS is_read
    FROM allowed a`;
  if (!page) return sql`${base} ${summary}`;
  // Seek within each scope even for sparse cursor pages; the scalar frontier
  // skips cleared history and remains NULL (fail-closed) for unauthorized scopes.
  const branches = STAFF_ALERT_SCOPES.map((scope) => sql`SELECT * FROM (
    SELECT i.seq, i.alert_id, i.scope, i.read_at FROM staff_alert_inbox AS i INDEXED BY staff_alert_inbox_scope_seq_idx
    WHERE i.user_id = ${userId} AND i.scope = ${scope}
      AND i.seq > (SELECT cleared_through FROM allowed WHERE scope = ${scope})
      AND ${page.beforeSeq === undefined ? sql`1 = 1` : sql`i.seq < ${page.beforeSeq}`}
    ORDER BY i.seq DESC LIMIT ${page.limit + 1}) AS scope_page`);
  return sql`${base}, page AS MATERIALIZED (
    SELECT * FROM (${sql.join(branches, sql` UNION ALL `)}) AS scope_pages ORDER BY seq DESC LIMIT ${page.limit + 1})
    ${summary} UNION ALL
    SELECT 1 AS entry_type, ${headSql(userId)} AS head, p.scope, a.revision, a.read_through, a.cleared_through,
      0 AS unread, p.seq, e.id, e.kind, e.subject_id, e.occurred_at, e.order_number,
      CASE WHEN p.seq <= a.read_through OR p.read_at IS NOT NULL THEN 1 ELSE 0 END AS is_read
    FROM page p INNER JOIN staff_alerts e ON e.id = p.alert_id INNER JOIN allowed a ON a.scope = p.scope`;
}
function summaryOf(rows: ReadRow[]): StaffAlertSummary {
  const states = rows.filter((row) => Number(row.entry_type) === 0);
  const unread = states.reduce((sum, row) => sum + Number(row.unread), 0);
  return { head: Number(states[0]?.head ?? 0), unreadCount: Math.min(unread, STAFF_ALERT_COUNT_CAP),
    unreadCountCapped: unread > STAFF_ALERT_COUNT_CAP, countCap: STAFF_ALERT_COUNT_CAP,
    scopes: states.map((row) => ({ scope: row.scope, revision: Number(row.revision),
      readThrough: Number(row.read_through), clearedThrough: Number(row.cleared_through) })) };
}
export async function readStaffAlertSummary(db: Database, userId: string): Promise<StaffAlertSummary> {
  return summaryOf(await db.all<ReadRow>(readSql(userId)));
}
export async function readStaffAlerts(db: Database, userId: string, input: { beforeSeq?: number; limit?: number } = {}): Promise<StaffAlertPage> {
  const limit = input.limit ?? STAFF_ALERT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > STAFF_ALERT_MAX_PAGE_SIZE) throw new ValidationError("Invalid notification page size.");
  const beforeSeq = input.beforeSeq;
  if (beforeSeq !== undefined) integer(beforeSeq, "cursor");
  const rows = await db.all<ReadRow>(readSql(userId, { beforeSeq, limit }));
  const entries = rows.filter((row) => Number(row.entry_type) === 1).sort((a, b) => Number(b.seq) - Number(a.seq));
  const items = entries.slice(0, limit).map((row) => ({ seq: Number(row.seq), id: row.id!, scope: row.scope,
    kind: row.kind!, subjectId: row.subject_id!, occurredAt: new Date(Number(row.occurred_at) * 1000).toISOString(),
    orderNumber: row.order_number, read: Number(row.is_read) === 1,
    href: `/admin/${row.scope === "orders" ? "orders" : "inbox"}/${encodeURIComponent(row.subject_id!)}` }));
  return { ...summaryOf(rows), items, nextBefore: entries.length > limit ? items.at(-1)!.seq : null };
}

function integer(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new ValidationError(`Invalid notification ${name}.`);
}
function validateScopes(scopes: readonly StaffAlertScope[]): void {
  if (!scopes.length || scopes.length > STAFF_ALERT_SCOPES.length || new Set(scopes).size !== scopes.length
    || scopes.some((scope) => !STAFF_ALERT_SCOPES.includes(scope))) throw new ValidationError("Invalid notification scopes.");
}
function stateSeeds(db: Database, userId: string, scopes: readonly StaffAlertScope[]) {
  return scopes.map((scope) => db.insert(staffAlertState).select(sql`
    SELECT ${userId}, ${scope}, 0, NULL, 0, 0, 0, 0, 0, NULL
    WHERE ${staffPermissionSql(sql`${userId}`, permission(scope))}`).onConflictDoNothing());
}
function currentAccess(userId: string, scopes: readonly StaffAlertScope[]): SQL {
  return sql.join(scopes.map((scope) => sql`(staff_alert_state.scope = ${scope} AND ${staffPermissionSql(sql`${userId}`, permission(scope))})`), sql` OR `);
}

export async function markStaffAlertRead(db: Database, userId: string, seq: number): Promise<StaffAlertMutation> {
  integer(seq, "sequence");
  const scopeAccess = sql.join(STAFF_ALERT_SCOPES.map((scope) => sql`(i.scope = ${scope} AND ${staffPermissionSql(sql`${userId}`, permission(scope))})`), sql` OR `);
  const exists = sql`EXISTS (SELECT 1 FROM staff_alert_inbox i WHERE i.user_id = ${userId} AND i.seq = ${seq} AND (${scopeAccess}))`;
  const marker = "staff_alert_not_found";
  try {
    await safeBatch(db, [
      buildBatchGuard(db, exists, marker),
      ...stateSeeds(db, userId, STAFF_ALERT_SCOPES),
      db.update(staffAlertState).set({ revision: sql`revision + 1` }).where(sql`user_id = ${userId}
        AND EXISTS (SELECT 1 FROM staff_alert_inbox i WHERE i.user_id = ${userId} AND i.seq = ${seq}
          AND i.scope = staff_alert_state.scope AND i.read_at IS NULL)`),
      db.update(staffAlertInbox).set({ readAt: sql`unixepoch()` })
        .where(sql`user_id = ${userId} AND seq = ${seq} AND read_at IS NULL`),
    ]);
  } catch (error) {
    if (isBatchGuardError(error, marker)) throw new NotFoundError("Notification not found.");
    throw error;
  }
  return { summary: await readStaffAlertSummary(db, userId) };
}

export async function markAllStaffAlertsRead(db: Database, userId: string, input: StaffAlertReadAllInput): Promise<StaffAlertMutation> {
  integer(input.through, "frontier"); validateScopes(input.scopes);
  const through = sql`min(${input.through}, ${headSql(userId)})`;
  await safeBatch(db, [...stateSeeds(db, userId, input.scopes),
    db.update(staffAlertState).set({ readThrough: through, revision: sql`revision + 1` })
      .where(sql`user_id = ${userId} AND (${currentAccess(userId, input.scopes)}) AND read_through < ${through}`),
  ]);
  return { summary: await readStaffAlertSummary(db, userId) };
}

/** Existing provider-neutral batch guard rolls back every scope on conflict. */
async function clearOrUndo(db: Database, userId: string, input: StaffAlertClearInput | StaffAlertUndoInput, undo: boolean): Promise<StaffAlertMutation> {
  const scopes = input.scopes.map((entry) => entry.scope);
  validateScopes(scopes);
  for (const entry of input.scopes) integer(entry.revision, "revision");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.operationId)) throw new ValidationError("Invalid notification operation.");
  const through = "through" in input ? input.through : 0;
  integer(through, "frontier");
  const conditions = input.scopes.map((entry) => sql`EXISTS (SELECT 1 FROM staff_alert_state s
    WHERE s.user_id = ${userId} AND s.scope = ${entry.scope}
      AND ${staffPermissionSql(sql`${userId}`, permission(entry.scope))}
      AND ${undo ? sql`s.revision = ${entry.revision} AND s.clear_operation_id = ${input.operationId}`
        : sql`((s.revision = ${entry.revision} AND coalesce(s.clear_operation_id, '') <> ${input.operationId}) OR (s.revision = ${entry.revision + 1} AND s.clear_operation_id = ${input.operationId}))`})`);
  const marker = "staff_alert_clear_conflict";
  const affected = sql.join(input.scopes.map((entry) => sql`(scope = ${entry.scope} AND revision = ${entry.revision})`), sql` OR `);
  try {
    await safeBatch(db, [
      ...stateSeeds(db, userId, scopes),
      buildBatchGuard(db, sql.join(conditions, sql` AND `), marker),
      db.update(staffAlertState).set(undo
        ? { readThrough: sql`previous_read_through`, clearedThrough: sql`previous_cleared_through`, revision: sql`revision + 1` }
        : { previousReadThrough: sql`read_through`, previousClearedThrough: sql`cleared_through`,
            readThrough: sql`max(read_through, min(${through}, ${headSql(userId)}))`,
            clearedThrough: sql`max(cleared_through, min(${through}, ${headSql(userId)}))`,
            clearOperationId: input.operationId, revision: sql`revision + 1` })
        .where(sql`user_id = ${userId} AND (${affected})`),
    ]);
  } catch (error) {
    if (isBatchGuardError(error, marker)) throw new ConflictError("Notifications changed. Refresh before trying again.");
    throw error;
  }
  return { summary: await readStaffAlertSummary(db, userId),
    ...(undo ? {} : { undo: { operationId: input.operationId, scopes: input.scopes.map((entry) => ({ ...entry, revision: entry.revision + 1 })) } }) };
}
/** Inbox rows kept per staff member: the bell pages back through at most these. */
export const STAFF_ALERT_INBOX_KEEP = 1_000;
/** An alert no inbox row shows is deleted after the notification retry window. */
export const STAFF_ALERT_RETENTION_SECONDS = 30 * 86_400;

/**
 * Bounded retention, `limit` rows per table: inbox rows cleared beyond undo
 * (at or below the scope's previous clear) or older than a staff member's
 * newest STAFF_ALERT_INBOX_KEEP, then alerts left without an inbox row.
 */
export async function pruneStaffAlerts(db: Database, now: number, limit = 500): Promise<{ inbox: number; alerts: number }> {
  const [inbox, alerts] = await safeBatch(db, [
    db.delete(staffAlertInbox).where(sql`(user_id, seq) IN (SELECT * FROM (
      SELECT i.user_id, i.seq FROM staff_alert_state s
      JOIN staff_alert_inbox i ON i.user_id = s.user_id AND i.scope = s.scope AND i.seq <= s.previous_cleared_through
      WHERE s.scope <> '*'
      UNION ALL
      SELECT i.user_id, i.seq FROM staff_alert_state s
      JOIN staff_alert_inbox i ON i.user_id = s.user_id AND i.seq <= s.last_seq - ${STAFF_ALERT_INBOX_KEEP}
      WHERE s.scope = '*') AS expired LIMIT ${limit})`).returning({ seq: staffAlertInbox.seq }),
    db.delete(staffAlerts).where(sql`id IN (SELECT a.id FROM staff_alerts a
      WHERE a.recorded_at < ${now - STAFF_ALERT_RETENTION_SECONDS}
        AND NOT EXISTS (SELECT 1 FROM staff_alert_inbox i WHERE i.alert_id = a.id)
      ORDER BY a.recorded_at LIMIT ${limit})`).returning({ id: staffAlerts.id }),
  ]);
  return { inbox: inbox?.length ?? 0, alerts: alerts?.length ?? 0 };
}

export const clearStaffAlerts = (db: Database, userId: string, input: StaffAlertClearInput) => clearOrUndo(db, userId, input, false);
export const undoStaffAlertsClear = (db: Database, userId: string, input: StaffAlertUndoInput) => clearOrUndo(db, userId, input, true);
