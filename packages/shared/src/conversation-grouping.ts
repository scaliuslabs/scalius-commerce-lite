/** Presentation metadata only: callers retain their own message rows and paging anchors. */
export interface GroupableConversationMessage {
  seq: number;
  kind: string;
  visibility: string;
  authorType: string;
  authorUserId?: string | null;
  /** API timestamp in seconds. */
  createdAt: number;
}

export function groupConversationMessages<T extends GroupableConversationMessage>(
  messages: readonly T[],
  { previous, dayKey, windowMs = 300_000 }: {
    /** Last rendered message, for append-only customer updates. */
    previous?: T;
    /** The caller's store-time calendar day; grouping never guesses a timezone. */
    dayKey: (createdAtSeconds: number) => string;
    windowMs?: number;
  },
): Array<{ message: T; groupStart: boolean; showAuthor: boolean; startsDay: boolean }> {
  let before = previous;
  return messages.map((message) => {
    const startsDay = !before || dayKey(message.createdAt) !== dayKey(before.createdAt);
    const elapsed = before ? (message.createdAt - before.createdAt) * 1_000 : Infinity;
    const grouped = Boolean(before && !startsDay && message.kind === "message" && before.kind === "message"
      && message.seq === before.seq + 1 && message.authorType === before.authorType
      && (message.authorUserId ?? null) === (before.authorUserId ?? null)
      && message.visibility === before.visibility && elapsed >= 0 && elapsed <= windowMs);
    before = message;
    return { message, groupStart: !grouped, showAuthor: message.kind === "message" && !grouped, startsDay };
  });
}
