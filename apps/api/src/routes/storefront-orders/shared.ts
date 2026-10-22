// Helpers and schemas shared by the storefront order routes.
import { z } from "@hono/zod-openapi";
import { getSessionCookie } from "@scalius/core/modules/customers";
import { CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES, type StorefrontGiftCardTenderSummary } from "@scalius/core/modules/orders";
import { GIFT_CARD_APPLY_HANDLE_MAX_LENGTH } from "@scalius/core/modules/gift-cards";
import { MAX_GIFT_CARDS_PER_ORDER } from "@scalius/shared/gift-card-tender";
import { fromMinor } from "@scalius/shared/money";
import { MARKET_SUBFOLDER_PATTERN } from "@scalius/shared/markets";

export const CUSTOMER_SESSION_HEADER = "X-Customer-Session";

export function getCustomerSessionTokenFromRequest(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const explicitSessionToken = c.req.header(CUSTOMER_SESSION_HEADER)?.trim();
  if (explicitSessionToken) return explicitSessionToken;

  return getSessionCookie(c.req.header("Cookie") ?? null);
}

/**
 * The signed-in buyer's customer id for segment price lists, read only when
 * awaited (`resolveCheckoutPriceScope` awaits it only when a segment list
 * prices one of the cart's SKUs), and at most once. A guest, or a session
 * that cannot be read, is no customer.
 */
export function lazySessionCustomerId(
  c: { req: { header: (name: string) => string | undefined } },
  read: (token: string) => Promise<{ customerId?: string | null } | null>,
): PromiseLike<string | null> {
  let pending: Promise<string | null> | null = null;
  return {
    then(onFulfilled, onRejected) {
      pending ??= (async () => {
        const token = getCustomerSessionTokenFromRequest(c);
        if (!token) return null;
        return (await read(token).catch(() => null))?.customerId ?? null;
      })();
      return pending.then(onFulfilled, onRejected);
    },
  };
}

/** A storefront page's subfolder presence in a checkout body (`en-in`); its market prices the cart. */
export const checkoutPresenceSchema = z.string().regex(MARKET_SUBFOLDER_PATTERN).optional().nullable().openapi({
  description: "The page's subfolder presence (`en-in`): before an address is known, its market prices the cart. Omit at the root.",
});

// ─── GET /receipt/:id ───────────────────────────────────────────────────────

export const receiptSupportRequestSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  customerId: z.string().nullable(),
  type: z.enum(CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES),
  status: z.string(),
  active: z.boolean(),
  severity: z.enum(["info", "success", "warning", "danger"]),
  label: z.string(),
  actionLabel: z.string(),
  reason: z.string(),
  submittedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

/** A delivered line a return may name, with the units that reached the buyer. */
export const returnableOrderLineSchema = z.object({
  orderItemId: z.string(),
  productName: z.string(),
  variantLabel: z.string().nullable(),
  quantity: z.number().int(),
});

/** The lines a return asks for: each once, with how many come back. */
export const supportRequestItemsSchema = z.array(z.object({
  orderItemId: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(100_000),
}).strict()).min(1).max(100);

export const receiptSupportRequestActionSchema = z.object({
  type: z.enum(CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES),
  label: z.string(),
  description: z.string(),
  eligible: z.boolean(),
  disabledReason: z.string().nullable(),
  /** A return: the delivered lines to choose from. */
  returnableItems: z.array(returnableOrderLineSchema).optional(),
});

export const persistedStorefrontVariantIdSchema = z
  .string()
  .trim()
  .min(1, "A saved product variant is required")
  .max(180, "Product variant id is too long")
  .regex(/^(?!default$).+$/, "A saved product variant is required");

export const storefrontShippingMethodSnapshotSchema = z.object({
  id: z.string().min(1).max(180),
  name: z.string().min(1).max(100),
  description: z.string().max(255).nullable(),
  baseAmountMinor: z.number().int().nonnegative(),
  feeWaived: z.boolean(),
});

// ─── Gift cards as a tender (Wave B §4.3) ───────────────────────────────────

/** The buyer's gift-card apply handles (never codes), in the order they were added. */
export const giftCardHandlesSchema = z
  .array(z.object({
    handle: z.string().trim().min(1).max(GIFT_CARD_APPLY_HANDLE_MAX_LENGTH),
  }).strict())
  .max(MAX_GIFT_CARDS_PER_ORDER, `Use at most ${MAX_GIFT_CARDS_PER_ORDER} gift cards on one order.`)
  .optional()
  .openapi({
    description: "Gift-card apply handles from `POST /checkout/gift-cards/apply`, in the order the buyer added them (at most 5). Omit for no gift cards.",
  });

export const giftCardIssueSchema = z.object({
  /** The handle the issue is about; null for an order-level issue. */
  handle: z.string().nullable(),
  code: z.enum(["gift_card_unusable", "gift_card_duplicate", "gift_card_not_needed", "gift_card_not_eligible"]),
  message: z.string(),
});

export const giftCardQuoteTenderSchema = z.object({
  handle: z.string(),
  last4: z.string(),
  applied: z.number(),
  appliedMinor: z.number().int(),
  /** The card's balance before this order. */
  balance: z.number(),
  balanceMinor: z.number().int(),
});

/** Tender facts in the decimal HTTP contract (major units plus `*Minor` twins). */
export function presentGiftCardTenderQuote(
  tender: StorefrontGiftCardTenderSummary,
  decimalPlaces: number,
) {
  return {
    giftCardTenders: tender.applied.map((card) => ({
      handle: card.handle,
      last4: card.last4,
      applied: fromMinor(card.appliedMinor, decimalPlaces),
      appliedMinor: card.appliedMinor,
      balance: fromMinor(card.balanceMinor, decimalPlaces),
      balanceMinor: card.balanceMinor,
    })),
    giftCardIssues: tender.issues,
    amountDue: fromMinor(tender.amountDueMinor, decimalPlaces),
    amountDueMinor: tender.amountDueMinor,
  };
}
