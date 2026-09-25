// Helpers and schemas shared by the storefront order routes.
import { z } from "@hono/zod-openapi";
import { getSessionCookie } from "@scalius/core/modules/customers";
import { CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES, type StorefrontGiftCardTenderSummary } from "@scalius/core/modules/orders";
import { GIFT_CARD_APPLY_HANDLE_MAX_LENGTH } from "@scalius/core/modules/gift-cards";
import { MAX_GIFT_CARDS_PER_ORDER } from "@scalius/shared/gift-card-tender";
import { fromMinor } from "@scalius/shared/money";
import type { WaitUntilExecutionContext } from "../../utils/cache-generation";
import {
  RECEIPT_TOKEN_TTL_SECONDS,
  getCheckoutStatusKvKey,
  getReceiptTokenKvKey,
} from "../../utils/order-receipt-token";

export const CUSTOMER_SESSION_HEADER = "X-Customer-Session";
const CHECKOUT_STATUS_TTL_SECONDS = 86400;

function scheduleCheckoutRecoveryHint(
  task: Promise<unknown>,
  executionCtx: WaitUntilExecutionContext | undefined,
): void {
  const guardedTask = task.catch((error: unknown) => {
    console.error("[Orders] Failed to write checkout recovery hint:", error);
  });

  if (executionCtx && typeof executionCtx.waitUntil === "function") {
    executionCtx.waitUntil(guardedTask);
    return;
  }

  void guardedTask;
}

export function scheduleCheckoutSuccessRecoveryHints(
  env: Env,
  statusToken: string,
  receiptToken: string,
  orderId: string,
  executionCtx: WaitUntilExecutionContext | undefined,
): void {
  if (!env.CACHE) return;

  try {
    scheduleCheckoutRecoveryHint(
      Promise.all([
        getCheckoutStatusKvKey(statusToken).then((statusKey) =>
          env.CACHE.put(
            statusKey,
            JSON.stringify({
              status: "completed",
              orderId,
              updatedAt: Date.now(),
            }),
            { expirationTtl: CHECKOUT_STATUS_TTL_SECONDS },
          ),
        ),
        getReceiptTokenKvKey(receiptToken).then((receiptKey) => env.CACHE.put(
          receiptKey,
          JSON.stringify({ orderId }),
          { expirationTtl: RECEIPT_TOKEN_TTL_SECONDS },
        )),
      ]),
      executionCtx,
    );
  } catch (error) {
    console.error("[Orders] Failed to schedule checkout success recovery hint:", error);
  }
}

export function scheduleCheckoutFailureStatusHint(
  env: Env,
  statusToken: string,
  orderId: string,
  errorMessage: string,
  executionCtx: WaitUntilExecutionContext | undefined,
): void {
  if (!env.CACHE) return;

  try {
    scheduleCheckoutRecoveryHint(
      getCheckoutStatusKvKey(statusToken).then((statusKey) =>
        env.CACHE.put(
          statusKey,
          JSON.stringify({
            status: "failed",
            orderId,
            error: errorMessage,
            updatedAt: Date.now(),
          }),
          { expirationTtl: CHECKOUT_STATUS_TTL_SECONDS },
        ),
      ),
      executionCtx,
    );
  } catch (error) {
    console.error("[Orders] Failed to schedule checkout failure recovery hint:", error);
  }
}

export function getCustomerSessionTokenFromRequest(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const explicitSessionToken = c.req.header(CUSTOMER_SESSION_HEADER)?.trim();
  if (explicitSessionToken) return explicitSessionToken;

  return getSessionCookie(c.req.header("Cookie") ?? null);
}

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

export const receiptSupportRequestActionSchema = z.object({
  type: z.enum(CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES),
  label: z.string(),
  description: z.string(),
  eligible: z.boolean(),
  disabledReason: z.string().nullable(),
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
  code: z.enum(["GIFT_CARD_UNUSABLE", "GIFT_CARD_DUPLICATE", "GIFT_CARD_NOT_NEEDED", "GIFT_CARD_NOT_ELIGIBLE"]),
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
