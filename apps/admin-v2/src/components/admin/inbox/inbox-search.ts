// Only non-sensitive inbox filters belong in route URLs; query text stays in memory.
import { CONVERSATION_SUBJECT_TYPES, type ConversationSubjectType } from "@scalius/shared/conversation";

export type InboxSubject = ConversationSubjectType;

/** The subject filter's options, in the order the dashboard lists them. */
export const INBOX_SUBJECTS: readonly InboxSubject[] = ["order", "store", "review", "warranty_claim"];

export interface InboxSearch {
  status?: "pending" | "closed";
  assignee?: string;
  unread?: true;
  sort?: "waiting_longest";
  subject?: InboxSubject;
}

function isInboxSubject(value: unknown): value is InboxSubject {
  return typeof value === "string" && (CONVERSATION_SUBJECT_TYPES as readonly string[]).includes(value);
}

export function validateInboxSearch(input: Record<string, unknown>): InboxSearch {
  const search: InboxSearch = {};
  if (input.status === "pending" || input.status === "closed") search.status = input.status;
  if (typeof input.assignee === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(input.assignee)) search.assignee = input.assignee;
  if (input.unread === true) search.unread = true;
  if (input.sort === "waiting_longest") search.sort = input.sort;
  if (isInboxSubject(input.subject)) search.subject = input.subject;
  return search;
}
