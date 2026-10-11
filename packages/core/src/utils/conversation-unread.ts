import { conversationMessages, conversations } from "@scalius/database/schema";
import { and, eq, gt, inArray, type AnyColumn } from "drizzle-orm";

/** Staff unread means incoming public messages after the explicitly acknowledged sequence. */
export function staffUnreadMessageCondition(
  messages: Record<"conversationId" | "seq" | "kind" | "visibility" | "authorType", AnyColumn> = conversationMessages,
  threads: Record<"id" | "staffReadSeq", AnyColumn> = conversations,
) {
  return and(
    eq(messages.conversationId, threads.id),
    gt(messages.seq, threads.staffReadSeq),
    eq(messages.kind, "message"),
    eq(messages.visibility, "public"),
    inArray(messages.authorType, ["customer", "guest_receipt"]),
  )!;
}
