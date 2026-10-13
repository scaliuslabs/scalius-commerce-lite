import type { Database } from "@scalius/database/client";
import { conversationSearchTerms, conversations } from "@scalius/database/schema";
import { eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../../errors";

const FIND_WINDOW = 2_000;
const FIND_PAGE_SIZE = 50;

type Statement = Parameters<Database["batch"]>[0][number];

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

export interface ConversationMessageSearchPage {
  items: Array<{ seq: number }>;
  nextCursor: number | null;
  scanExhausted: boolean;
  scanned: number;
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
  const thread = await db.select({ id: conversations.id }).from(conversations)
    .where(eq(conversations.id, conversationId)).get();
  if (!thread) throw new NotFoundError("Conversation not found");
  if (terms.length === 0) return { items: [], nextCursor: null, scanExhausted: true, scanned: 0 };

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
  };
}
