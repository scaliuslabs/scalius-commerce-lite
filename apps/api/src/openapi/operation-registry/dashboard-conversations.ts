// Agent operation registry rows for the dashboard conversation routes.
//
// The inbox is buyer text, so it sits behind the opt-in grant scope
// `customer_conversations`: no preset grant (Read only, Operator, Full
// automation) reaches it; a Custom grant whose permission snapshot holds
// conversations.view / conversations.reply does. Replies follow the same
// reply-reach rules as the dashboard (the route decides the channel).
import type { OperationRegistryEntry } from "./entry";

const INBOX_IMAGES =
  "Conversation images are buyer media served as re-encoded files; they stay in the dashboard while agents read and answer the conversation text.";

const inbox = (overrides: Partial<OperationRegistryEntry> = {}): OperationRegistryEntry => ({
  grantScope: "customer_conversations",
  uncurated: true,
  ...overrides,
});

export const DASHBOARD_CONVERSATION_OPERATIONS = {
  // POST reads: a search body keeps private text out of the URL.
  "dashboard.conversations.query": inbox({ risk: "read" }),
  "dashboard.conversations.assignees": inbox(),
  "dashboard.conversations.search": inbox({ risk: "read" }),
  "dashboard.conversations.context": inbox(),
  "dashboard.conversations.saved_replies.list": inbox(),
  "dashboard.conversations.saved_replies.get": inbox(),
  "dashboard.conversations.saved_replies.create": inbox({ idempotency: "required" }),
  "dashboard.conversations.saved_replies.update": inbox({ revision: "required" }),
  "dashboard.conversations.attachment_get": { exposure: "excluded", sensitive: true, reason: INBOX_IMAGES },
  "dashboard.conversations.attachment_upload": { exposure: "excluded", sensitive: true, reason: INBOX_IMAGES },
  "dashboard.conversations.get": inbox(),
  "dashboard.conversations.list": inbox(),
  "dashboard.conversations.order_get": inbox(),
  "dashboard.conversations.order_post": inbox({ idempotency: "required" }),
  "dashboard.conversations.post": inbox({ idempotency: "required" }),
  "dashboard.conversations.read": inbox(),
  "dashboard.conversations.summary": inbox(),
  "dashboard.conversations.update": inbox({ revision: "required" }),
} satisfies Record<string, OperationRegistryEntry>;
