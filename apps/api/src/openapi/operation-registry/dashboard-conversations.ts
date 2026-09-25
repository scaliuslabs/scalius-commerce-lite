// Agent operation registry rows for the dashboard conversation routes.
import type { OperationRegistryEntry } from "./entry";

const STAFF_INBOX_ONLY =
  "Buyer conversation text, internal notes and images are private customer content; the inbox stays a staff browser surface until a reviewed agent intent exists.";

const excluded = (overrides: Partial<OperationRegistryEntry> = {}): OperationRegistryEntry => ({
  exposure: "excluded",
  sensitive: true,
  reason: STAFF_INBOX_ONLY,
  ...overrides,
});

export const DASHBOARD_CONVERSATION_OPERATIONS = {
  "dashboard.conversations.attachment_get": excluded(),
  "dashboard.conversations.attachment_upload": excluded(),
  "dashboard.conversations.get": excluded(),
  "dashboard.conversations.list": excluded(),
  "dashboard.conversations.order_get": excluded(),
  "dashboard.conversations.order_post": excluded({ idempotency: "required" }),
  "dashboard.conversations.post": excluded({ idempotency: "required" }),
  "dashboard.conversations.read": excluded(),
  "dashboard.conversations.summary": excluded(),
  "dashboard.conversations.update": excluded({ revision: "required" }),
} satisfies Record<string, OperationRegistryEntry>;
