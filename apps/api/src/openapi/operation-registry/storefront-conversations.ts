// Agent operation registry rows for the storefront conversation routes.
import type { OperationRegistryEntry } from "./entry";

const BROWSER_ONLY =
  "Buyer-to-store messages and images are the buyer's own words, sent from the hosted account or receipt page; agents never read or write them.";

const customer = (overrides: Partial<OperationRegistryEntry> = {}): OperationRegistryEntry => ({
  exposure: "excluded",
  principals: ["customer"],
  sensitive: true,
  reason: BROWSER_ONLY,
  ...overrides,
});

const receipt = (overrides: Partial<OperationRegistryEntry> = {}): OperationRegistryEntry => ({
  exposure: "excluded",
  principals: ["visitor"],
  sensitive: true,
  reason: BROWSER_ONLY,
  ...overrides,
});

export const STOREFRONT_CONVERSATION_OPERATIONS = {
  "storefront.customer_auth_conversation_attachments.conversation_attachments": customer(),
  "storefront.customer_auth_conversations.conversations": customer({ idempotency: "required" }),
  "storefront.customer_auth_conversations.get": customer(),
  "storefront.customer_auth_conversations.get_conversations": customer(),
  "storefront.customer_auth_conversations_attachments.get": customer(),
  "storefront.customer_auth_conversations_messages.messages": customer({ idempotency: "required" }),
  "storefront.customer_auth_conversations_read.read": customer(),
  "storefront.customer_auth_conversations_unread.get_unread": customer(),
  "storefront.customer_auth_orders_conversation.conversation": customer({ idempotency: "required" }),
  "storefront.customer_auth_orders_conversation.get_conversation": customer(),
  "storefront.orders_receipt_conversation.conversation": receipt({ idempotency: "required" }),
  "storefront.orders_receipt_conversation.get_conversation": receipt(),
  "storefront.orders_receipt_conversation_attachments.conversation_attachments": receipt(),
  "storefront.orders_receipt_conversation_attachments.get": receipt(),
  "storefront.orders_receipt_conversation_read.read": receipt(),
} satisfies Record<string, OperationRegistryEntry>;
