// Agent operation registry rows for the storefront warranty routes (Wave B §5.2, §7.1).
// A claim is the buyer's own description and photos of a fault, written from
// the hosted account or receipt page; guest routes need raw receipt proof. No
// agent reads a buyer's warranties or opens, answers or reads a claim.
import type { OperationRegistryEntry } from "./entry";

const BUYER_CLAIM_ONLY =
  "Warranty claims are the buyer's own description and photos, written from the hosted account or receipt page; agents never read a buyer's warranties or open, answer or read a claim.";

const customer = (overrides: Partial<OperationRegistryEntry> = {}): OperationRegistryEntry => ({
  exposure: "excluded",
  principals: ["customer"],
  sensitive: true,
  reason: BUYER_CLAIM_ONLY,
  ...overrides,
});

const receipt = (overrides: Partial<OperationRegistryEntry> = {}): OperationRegistryEntry => ({
  exposure: "excluded",
  principals: ["visitor"],
  sensitive: true,
  reason: `${BUYER_CLAIM_ONLY} Guest routes require raw receipt proof in a header.`,
  ...overrides,
});

export const STOREFRONT_WARRANTY_OPERATIONS = {
  "storefront.customer_auth_warranties.get_warranties": customer(),
  "storefront.customer_auth_warranties_claim_attachments.claim_attachments": customer(),
  "storefront.customer_auth_warranties_claims.claims": customer({ idempotency: "required" }),
  "storefront.orders_receipt_warranties_claim_attachments.claim_attachments": receipt(),
  "storefront.orders_receipt_warranties_claims.claims": receipt({ idempotency: "required" }),
  "storefront.orders_receipt_warranty_claims.get": receipt(),
  "storefront.orders_receipt_warranty_claims_messages.messages": receipt({ idempotency: "required" }),
  "storefront.orders_receipt_warranty_claims_read.read": receipt(),
  "storefront.orders_receipt_warranty_claims_attachments.attachments": receipt(),
  "storefront.orders_receipt_warranty_claims_attachments.get": receipt(),
} satisfies Record<string, OperationRegistryEntry>;
