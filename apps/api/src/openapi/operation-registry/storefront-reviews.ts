// Agent operation registry rows for the storefront review routes (Wave B).
// Published reviews are public catalogue content; writing, editing and
// withdrawing a review is the buyer's own words from the hosted account or
// receipt page, so agents never do it for them.
import type { OperationRegistryEntry } from "./entry";

const BUYER_WORDS_ONLY =
  "A review is the buyer's own words about a delivered order line, written from the hosted account or receipt page; agents never read the buyer's review list or write, edit or withdraw a review.";

const customer = (overrides: Partial<OperationRegistryEntry> = {}): OperationRegistryEntry => ({
  exposure: "excluded",
  principals: ["customer"],
  sensitive: true,
  reason: BUYER_WORDS_ONLY,
  ...overrides,
});

const receipt = (overrides: Partial<OperationRegistryEntry> = {}): OperationRegistryEntry => ({
  exposure: "excluded",
  principals: ["visitor"],
  sensitive: true,
  reason: BUYER_WORDS_ONLY,
  ...overrides,
});

export const STOREFRONT_REVIEW_OPERATIONS = {
  "storefront.customer_auth_reviews.get_reviews": customer(),
  "storefront.customer_auth_reviews.reviews": customer({ idempotency: "required" }),
  "storefront.customer_auth_reviews.update": customer({ revision: "required" }),
  "storefront.customer_auth_reviews_products.get": customer(),
  "storefront.orders_receipt_reviews.get_reviews": receipt(),
  "storefront.orders_receipt_reviews.reviews": receipt({ idempotency: "required" }),
  "storefront.orders_receipt_reviews.update": receipt({ revision: "required" }),
  "storefront.products_reviews.get_reviews": {},
} satisfies Record<string, OperationRegistryEntry>;
