// The inbox URL state: which list (status), whose conversations, what the
// conversation is about (subject) and the search term. Conversation ids are
// opaque (`cnv_…`) and the subject is a fixed vocabulary; no customer data
// ever enters the URL beyond what the merchant typed into the search box.
import { CONVERSATION_SUBJECT_TYPES, type ConversationSubjectType } from "@scalius/shared/conversation";

export type InboxSubject = ConversationSubjectType;

/** The subject filter's options, in the order the dashboard lists them. */
export const INBOX_SUBJECTS: readonly InboxSubject[] = ["order", "store", "review", "warranty_claim"];

export interface InboxSearch {
  status?: "pending" | "closed";
  assignee?: "me" | "none";
  subject?: InboxSubject;
  q?: string;
}

function isInboxSubject(value: unknown): value is InboxSubject {
  return typeof value === "string" && (CONVERSATION_SUBJECT_TYPES as readonly string[]).includes(value);
}

export function validateInboxSearch(input: Record<string, unknown>): InboxSearch {
  const search: InboxSearch = {};
  if (input.status === "pending" || input.status === "closed") search.status = input.status;
  if (input.assignee === "me" || input.assignee === "none") search.assignee = input.assignee;
  if (isInboxSubject(input.subject)) search.subject = input.subject;
  if (typeof input.q === "string" && input.q.trim()) search.q = input.q.trim().slice(0, 100);
  return search;
}
