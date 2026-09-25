// The inbox URL state: which list (status), whose conversations and the
// search term. Conversation ids are opaque (`cnv_…`); no customer data ever
// enters the URL beyond what the merchant typed into the search box.

export interface InboxSearch {
  status?: "pending" | "closed";
  assignee?: "me" | "none";
  q?: string;
}

export function validateInboxSearch(input: Record<string, unknown>): InboxSearch {
  const search: InboxSearch = {};
  if (input.status === "pending" || input.status === "closed") search.status = input.status;
  if (input.assignee === "me" || input.assignee === "none") search.assignee = input.assignee;
  if (typeof input.q === "string" && input.q.trim()) search.q = input.q.trim().slice(0, 100);
  return search;
}
