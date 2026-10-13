import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import { conversationMessages, conversationSearchState, conversationSearchTerms, conversations } from "@scalius/database/schema";
import { and, asc, eq, gt, isNull, lte, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../../errors";

const BACKFILL_LIMIT = 200;
export const CONVERSATION_SEARCH_PAGE_BYTES = 256 * 1024;
const FIND_WINDOW = 2_000;
const FIND_PAGE_SIZE = 50;
const SEARCH_STATE_ID = "v1";
const BACKFILL_CONFLICT = "CONVERSATION_SEARCH_BACKFILL_CONFLICT";

type Statement = Parameters<Database["batch"]>[0][number];
export type ConversationSearchCoverage = "complete" | "since_index";

/** Keep combining marks attached to letters, including Bangla vowel signs. */
export function tokenizeConversationSearch(text: string): string[] {
  const terms = new Set<string>();
  for (const word of text.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? []) {
    const points = Array.from(word);
    if (points.length >= 2) terms.add(points.slice(0, 32).join(""));
  }
  // Message bodies are already bounded at 5,000 characters. Do not silently
  // discard a later word because earlier words filled an arbitrary term cap.
  return [...terms];
}

function queryTerms(query: string): string[] {
  if (query.length > 100) throw new ValidationError("Search must be 100 characters or fewer.");
  const terms = tokenizeConversationSearch(query);
  if (terms.length > 8) throw new ValidationError("Search with up to 8 words.");
  return terms;
}

/** Binary/C collation orders valid Unicode scalar values in code point order. */
function prefixRange(column: SQLWrapper, prefix: string): SQL {
  const points = Array.from(prefix);
  const last = points.pop()!.codePointAt(0)!;
  const successor = last === 0xd7ff ? 0xe000 : last + 1;
  // Every prefix ends with a letter, number or mark, never U+10FFFF.
  const upper = points.join("") + String.fromCodePoint(successor);
  return sql`${column} >= ${prefix} AND ${column} < ${upper}`;
}

export interface ConversationSearchMessage {
  id: string;
  conversationId: string;
  seq: number;
  body?: string | null;
  eventKind?: string | null;
  eventData?: unknown;
}

function messageSearchText(message: ConversationSearchMessage): string {
  const parts = [message.body ?? ""];
  if (message.eventKind === "product_reply") {
    let data = message.eventData;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch { data = null; }
    }
    if (data && typeof data === "object" && "cards" in data && Array.isArray(data.cards)) {
      for (const card of data.cards) {
        if (!card || typeof card !== "object") continue;
        if ("title" in card && typeof card.title === "string") parts.push(card.title);
        if ("variantLabel" in card && typeof card.variantLabel === "string") parts.push(card.variantLabel);
      }
    }
  }
  return parts.join(" ");
}

/** Append these statements after the immutable message insert in its batch. */
export function planConversationSearchIndex(db: Database, message: ConversationSearchMessage): Statement[] {
  const terms = tokenizeConversationSearch(messageSearchText(message));
  if (terms.length === 0) return [];
  // Four binds irrespective of the number of words. json_each is supported by
  // every relational adapter; insert-select needs WHERE before ON CONFLICT.
  return [db.insert(conversationSearchTerms).select(sql`
    SELECT ${message.conversationId}, ${message.id}, ${message.seq}, CAST(value AS TEXT)
    FROM json_each(${JSON.stringify(terms)}) WHERE 1 = 1
  `).onConflictDoNothing()];
}

/**
 * One page, one bound UTF-8 payload, one insert. Nested term arrays avoid
 * repeating message identifiers for every word and keep one valid 5,000-
 * character message well below the cap even with multibyte characters.
 */
export function planConversationSearchPage(db: Database, messages: readonly ConversationSearchMessage[]) {
  const encoded: string[] = [];
  const encoder = new TextEncoder();
  let payloadBytes = 2; // outer array brackets
  for (const message of messages.slice(0, BACKFILL_LIMIT)) {
    const entry = JSON.stringify({ conversationId: message.conversationId, messageId: message.id,
      seq: message.seq, terms: tokenizeConversationSearch(messageSearchText(message)) });
    const bytes = encoder.encode(entry).byteLength + (encoded.length ? 1 : 0);
    if (payloadBytes + bytes > CONVERSATION_SEARCH_PAGE_BYTES) {
      if (encoded.length === 0) throw new ValidationError("A conversation search entry exceeds the indexing byte budget.");
      break;
    }
    encoded.push(entry);
    payloadBytes += bytes;
  }
  const payload = `[${encoded.join(",")}]`;
  const statement = db.insert(conversationSearchTerms).select(sql`
    SELECT CAST(json_extract(entry.value, '$.conversationId') AS TEXT),
      CAST(json_extract(entry.value, '$.messageId') AS TEXT),
      CAST(json_extract(entry.value, '$.seq') AS INTEGER), CAST(term.value AS TEXT)
    FROM json_each(${payload}) AS entry
    CROSS JOIN json_each(json_extract(entry.value, '$.terms')) AS term WHERE 1 = 1
  `).onConflictDoNothing();
  return { statement, indexed: encoded.length, payloadBytes };
}

/** Conversation-level AND: words may occur on different lines of the thread. */
export function conversationBodySearchCondition(conversationId: SQLWrapper, query: string): SQL {
  const terms = queryTerms(query);
  if (terms.length === 0) return sql`1 = 0`;
  return sql.join(terms.map((term) => sql`EXISTS (
    SELECT 1 FROM conversation_search_terms AS body_term
    WHERE body_term.conversation_id = ${conversationId}
      AND ${prefixRange(sql`body_term.term`, term)}
  )`), sql` AND `);
}

export async function getConversationSearchCoverage(db: Database): Promise<ConversationSearchCoverage> {
  const state = await db.select({ complete: conversationSearchState.complete }).from(conversationSearchState)
    .where(eq(conversationSearchState.id, SEARCH_STATE_ID)).get();
  return state?.complete ? "complete" : "since_index";
}

/**
 * Each maintenance turn indexes one bounded bulk page of historical messages. The CAS guard
 * and cursor move share the terms' transaction, so concurrent turns cannot
 * move the cursor backwards or advertise rows whose terms failed to commit.
 * New messages are indexed by their append batch, even behind this ID cursor.
 */
export async function backfillConversationSearch(db: Database, options: { limit?: number } = {}): Promise<{
  indexed: number; lastMessageId: string | null; complete: boolean;
}> {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > BACKFILL_LIMIT) {
    throw new ValidationError("Search backfill must process between 1 and 200 messages.");
  }
  await db.insert(conversationSearchState).values({ id: SEARCH_STATE_ID }).onConflictDoNothing();
  const state = (await db.select().from(conversationSearchState)
    .where(eq(conversationSearchState.id, SEARCH_STATE_ID)).get())!;
  if (state.complete) return { indexed: 0, lastMessageId: state.lastMessageId, complete: true };

  const rows = await db.select({
    id: conversationMessages.id,
    conversationId: conversationMessages.conversationId,
    seq: conversationMessages.seq,
    body: conversationMessages.body,
    eventKind: conversationMessages.eventKind,
    eventData: conversationMessages.eventData,
  }).from(conversationMessages)
    .where(state.lastMessageId === null ? undefined : gt(conversationMessages.id, state.lastMessageId))
    .orderBy(asc(conversationMessages.id)).limit(limit + 1).all();
  const plan = planConversationSearchPage(db, rows.slice(0, limit));
  const page = rows.slice(0, plan.indexed);
  const lastMessageId = page.at(-1)?.id ?? state.lastMessageId;
  const complete = rows.length <= plan.indexed;
  const current = and(
    eq(conversationSearchState.id, SEARCH_STATE_ID),
    eq(conversationSearchState.complete, false),
    state.lastMessageId === null ? isNull(conversationSearchState.lastMessageId)
      : eq(conversationSearchState.lastMessageId, state.lastMessageId),
  )!;
  try {
    await safeBatch(db, [
      db.update(conversationSearchState).set({ lastMessageId, complete }).where(current),
      buildBatchGuard(db, sql`changes() = 1`, BACKFILL_CONFLICT),
      plan.statement,
    ]);
  } catch (error) {
    if (!isBatchGuardError(error, BACKFILL_CONFLICT)) throw error;
    const latest = (await db.select().from(conversationSearchState)
      .where(eq(conversationSearchState.id, SEARCH_STATE_ID)).get())!;
    return { indexed: 0, lastMessageId: latest.lastMessageId, complete: latest.complete };
  }
  return { indexed: page.length, lastMessageId, complete };
}

/**
 * Prioritize the thread staff are actually searching. The marker certifies a
 * contiguous historical prefix; later appends already index themselves.
 * Nothing here changes conversation activity, editor versions or read state.
 */
async function catchUpThreadSearch(
  db: Database,
  thread: { id: string; lastSeq: number; searchIndexedSeq: number | null },
): Promise<ConversationSearchCoverage> {
  const indexedSeq = thread.searchIndexedSeq ?? 0;
  if (indexedSeq >= thread.lastSeq) return "complete";
  const rows = await db.select({
    id: conversationMessages.id, conversationId: conversationMessages.conversationId,
    seq: conversationMessages.seq, body: conversationMessages.body,
    eventKind: conversationMessages.eventKind, eventData: conversationMessages.eventData,
  }).from(conversationMessages).where(and(
    eq(conversationMessages.conversationId, thread.id), gt(conversationMessages.seq, indexedSeq),
    lte(conversationMessages.seq, thread.lastSeq),
  )).orderBy(asc(conversationMessages.seq)).limit(BACKFILL_LIMIT).all();
  // Gap-free sequences are a database invariant. Fail closed on damaged
  // legacy data rather than marking missing history fully searchable.
  let contiguous = 0;
  while (contiguous < rows.length && rows[contiguous]!.seq === indexedSeq + contiguous + 1) contiguous++;
  const plan = planConversationSearchPage(db, rows.slice(0, contiguous));
  if (plan.indexed === 0) return "since_index";
  const nextSeq = rows[plan.indexed - 1]!.seq;
  try {
    await safeBatch(db, [
      db.update(conversations).set({ searchIndexedSeq: nextSeq }).where(and(
        eq(conversations.id, thread.id),
        thread.searchIndexedSeq === null ? isNull(conversations.searchIndexedSeq)
          : eq(conversations.searchIndexedSeq, thread.searchIndexedSeq),
      )),
      buildBatchGuard(db, sql`changes() = 1`, BACKFILL_CONFLICT),
      plan.statement,
    ]);
  } catch (error) {
    if (!isBatchGuardError(error, BACKFILL_CONFLICT)) throw error;
    const latest = await db.select({ seq: conversations.searchIndexedSeq }).from(conversations)
      .where(eq(conversations.id, thread.id)).get();
    return (latest?.seq ?? 0) >= thread.lastSeq ? "complete" : "since_index";
  }
  return nextSeq >= thread.lastSeq ? "complete" : "since_index";
}

export interface ConversationMessageSearchPage {
  items: Array<{ seq: number }>;
  nextCursor: number | null;
  scanExhausted: boolean;
  scanned: number;
  bodyCoverage: ConversationSearchCoverage;
}

/** Staff-only search: route authorization must precede this internal-note read. */
export async function findConversationMessages(
  db: Database,
  conversationId: string,
  options: { q: string; cursor?: number },
): Promise<ConversationMessageSearchPage> {
  const terms = queryTerms(options.q);
  if (options.cursor !== undefined && (!Number.isSafeInteger(options.cursor) || options.cursor < 1)) {
    throw new ValidationError("Invalid message search cursor.");
  }
  const thread = await db.select({ id: conversations.id, lastSeq: conversations.lastSeq, searchIndexedSeq: conversations.searchIndexedSeq }).from(conversations)
    .where(eq(conversations.id, conversationId)).get();
  if (!thread) throw new NotFoundError("Conversation not found");
  let bodyCoverage = await getConversationSearchCoverage(db);
  if (terms.length === 0) return { items: [], nextCursor: null, scanExhausted: true, scanned: 0, bodyCoverage };

  if (bodyCoverage !== "complete") bodyCoverage = await catchUpThreadSearch(db, thread);

  // Walk a bounded sequence window using the thread sequence index, then
  // probe the term index for each row. Even a very common prefix cannot
  // force sorting an unbounded postings list before this window is selected.
  const remaining = terms.map((term) => sql`EXISTS (
    SELECT 1 FROM conversation_search_terms AS match_term
    WHERE match_term.conversation_id = ${conversationId} AND match_term.seq = candidate.seq
      AND ${prefixRange(sql`match_term.term`, term)}
  )`);
  const rows = await db.all<{ seq: number; matches: number }>(sql`
    WITH candidates AS MATERIALIZED (
      SELECT seq FROM conversation_messages
      WHERE conversation_id = ${conversationId}
        AND ${options.cursor === undefined ? sql`1 = 1` : sql`seq < ${options.cursor}`}
      ORDER BY seq DESC LIMIT ${FIND_WINDOW + 1}
    )
    SELECT candidate.seq, CASE WHEN ${remaining.length ? sql.join(remaining, sql` AND `) : sql`1 = 1`}
      THEN 1 ELSE 0 END AS matches
    FROM candidates AS candidate ORDER BY candidate.seq DESC
  `);
  const items: Array<{ seq: number }> = [];
  let scanned = 0;
  while (scanned < Math.min(rows.length, FIND_WINDOW) && items.length < FIND_PAGE_SIZE) {
    const row = rows[scanned++]!;
    if (Number(row.matches) === 1) items.push({ seq: Number(row.seq) });
  }
  const scanExhausted = rows.length <= scanned;
  return {
    items,
    nextCursor: scanExhausted ? null : Number(rows[scanned - 1]!.seq),
    scanExhausted,
    scanned,
    bodyCoverage,
  };
}
