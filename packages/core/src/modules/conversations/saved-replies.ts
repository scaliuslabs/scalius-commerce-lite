import type { Database } from "@scalius/database/client";
import { conversationSavedReplies } from "@scalius/database/schema";
import { normalizeConversationBody, normalizeConversationSubject } from "@scalius/shared/conversation";
import { encodeListCursor } from "@scalius/shared/pagination";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";
import { invalidCursor, keysetCondition, readListCursor } from "../../utils/keyset";
import { containsText } from "../../utils/text-match";

type SavedReply = typeof conversationSavedReplies.$inferSelect;
type SavedReplyMode = SavedReply["mode"];
const PAGE_SIZE = 50;
const ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;
const CURSOR_SORT = "conversationSavedReplies";

function assertId(id: string): void {
  if (typeof id !== "string" || !ID_SHAPE.test(id)) throw new ValidationError("Invalid saved reply id.");
}

function normalizedTitle(title: string): string {
  const result = normalizeConversationSubject(title);
  if (!result.ok || Array.from(result.value).length > 80) {
    throw new ValidationError("Use a saved reply title of 1 to 80 characters on one line.");
  }
  return result.value;
}

function normalizedBody(body: string): string {
  const result = normalizeConversationBody(body);
  if (!result.ok) throw new ValidationError("Use a saved reply body of 1 to 5,000 characters without control characters.");
  return result.value;
}

function assertMode(mode: string): asserts mode is SavedReplyMode {
  if (mode !== "reply" && mode !== "note") throw new ValidationError("Choose reply or note.");
}

/** Archived replies remain addressable so an open composer can reject a stale choice. */
export async function getSavedReply(db: Database, id: string): Promise<SavedReply> {
  assertId(id);
  const row = await db.select().from(conversationSavedReplies).where(eq(conversationSavedReplies.id, id)).get();
  if (!row) throw new NotFoundError("Saved reply not found.");
  return row;
}

/** Active replies, newest edits first. Search deliberately matches titles only. */
export async function listSavedReplies(
  db: Database,
  input: { mode?: SavedReplyMode; q?: string; cursor?: string | null } = {},
): Promise<{ items: SavedReply[]; nextCursor: string | null }> {
  const conditions: SQL[] = [isNull(conversationSavedReplies.archivedAt)];
  if (input.mode !== undefined) {
    assertMode(input.mode);
    conditions.push(eq(conversationSavedReplies.mode, input.mode));
  }
  const q = input.q?.normalize("NFC").trim();
  if (q && Array.from(q).length > 100) throw new ValidationError("Search saved reply titles with up to 100 characters.");
  if (q) conditions.push(containsText(conversationSavedReplies.title, q));
  if (input.cursor) {
    const cursor = readListCursor(input.cursor, { sort: CURSOR_SORT, direction: "desc", kinds: ["number"] });
    const updatedAt = cursor.values[0];
    if (typeof updatedAt !== "number" || !Number.isSafeInteger(updatedAt) || updatedAt < 0 || !ID_SHAPE.test(cursor.id)) {
      throw invalidCursor("Invalid saved reply cursor.");
    }
    conditions.push(keysetCondition({ column: conversationSavedReplies.updatedAt, id: conversationSavedReplies.id, direction: "desc" }, cursor));
  }
  const rows = await db.select().from(conversationSavedReplies)
    .where(and(...conditions))
    .orderBy(desc(conversationSavedReplies.updatedAt), desc(conversationSavedReplies.id))
    .limit(PAGE_SIZE + 1).all();
  const items = rows.slice(0, PAGE_SIZE);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > PAGE_SIZE && last
      ? encodeListCursor({ sort: CURSOR_SORT, direction: "desc", values: [last.updatedAt], id: last.id })
      : null,
  };
}

/** A client-generated id makes a retried create safe without overwriting another reply. */
export async function createSavedReply(
  db: Database,
  userId: string,
  input: { id: string; title: string; body: string; mode: SavedReplyMode },
): Promise<SavedReply> {
  assertId(input.id);
  assertMode(input.mode);
  const title = normalizedTitle(input.title);
  const body = normalizedBody(input.body);
  const now = Math.floor(Date.now() / 1000);
  const [created] = await db.insert(conversationSavedReplies).values({
    id: input.id, title, body, mode: input.mode,
    createdBy: userId, updatedBy: userId, createdAt: now, updatedAt: now, version: 1,
  }).onConflictDoNothing({ target: conversationSavedReplies.id }).returning();
  if (created) return created;
  const existing = await getSavedReply(db, input.id);
  if (existing.createdBy !== userId || existing.title !== title || existing.body !== body || existing.mode !== input.mode) {
    throw new ConflictError("This saved reply id is already in use. Refresh and try again.");
  }
  return existing;
}

/** Every edit, archive and restore requires the version the editor actually loaded. */
export async function updateSavedReply(
  db: Database,
  userId: string,
  id: string,
  input: { version: number; title?: string; body?: string; archived?: boolean },
): Promise<SavedReply> {
  assertId(id);
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new ValidationError("Invalid saved reply version.");
  if (input.title === undefined && input.body === undefined && input.archived === undefined) {
    throw new ValidationError("Choose a saved reply change.");
  }
  if (input.archived !== undefined && typeof input.archived !== "boolean") throw new ValidationError("Invalid saved reply archive state.");
  const now = Math.floor(Date.now() / 1000);
  const [updated] = await db.update(conversationSavedReplies).set({
    ...(input.title !== undefined ? { title: normalizedTitle(input.title) } : {}),
    ...(input.body !== undefined ? { body: normalizedBody(input.body) } : {}),
    ...(input.archived !== undefined ? { archivedAt: input.archived ? now : null } : {}),
    updatedBy: userId, updatedAt: now, version: sql`${conversationSavedReplies.version} + 1`,
  }).where(and(eq(conversationSavedReplies.id, id), eq(conversationSavedReplies.version, input.version))).returning();
  if (updated) return updated;
  await getSavedReply(db, id);
  throw new ConflictError("Someone else changed this saved reply. Refresh and try again.");
}
