import { phoneOrNull } from "@scalius/shared/customer-auth-policy";
import type { Database } from "@scalius/database/client";
import { customers, orders } from "@scalius/database/schema";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";

import { AppError, ConflictError, NotFoundError } from "@scalius/core/errors";
import { createOrderReceiptToken, recordOrderReceipt } from "./receipts";
import { customerAccountOrderVisibilityCondition } from "./account-orders";

/**
 * A signed-in account owner opens their own receipt without the checkout
 * browser's cookie: the customer session proves ownership (the same check as
 * the account order page) and a fresh private receipt proof is issued, which
 * the storefront keeps in its httpOnly receipt cookie, never in a URL.
 */
export async function issueAccountOwnerReceipt(
  db: Database,
  input: { customerId: string; orderId: string },
): Promise<{ orderId: string; receiptToken: string; expiresAt: number }> {
  const owned = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.id, input.orderId), customerAccountOrderVisibilityCondition(input.customerId)))
    .get();
  if (!owned) throw new NotFoundError("Order receipt not found");

  const receiptToken = createOrderReceiptToken();
  const receipt = await recordOrderReceipt(db, {
    orderId: owned.id,
    token: receiptToken,
    source: "account_owner",
  });
  return { orderId: owned.id, receiptToken, expiresAt: receipt.expiresAt };
}

const CONTACT_MISMATCH_MESSAGE =
  "This order was placed with a different phone number and email, so it can't be added to your account.";
const CONTACT_NOT_PROVEN_MESSAGE =
  "Confirm this order's phone number or email in your account with a code first, then save the order.";

export interface ClaimGuestOrderToAccountInput {
  orderId: string;
  customerId: string;
}

export interface ClaimGuestOrderToAccountResult {
  orderId: string;
  customerId: string;
  alreadyClaimed: boolean;
}

function normalizeEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** A claim refused because the account has not proven the order's contact (`details.reason`). */
function claimRefused(reason: "contact_not_proven" | "contact_mismatch"): AppError {
  return new AppError(403, "forbidden", reason === "contact_not_proven" ? CONTACT_NOT_PROVEN_MESSAGE : CONTACT_MISMATCH_MESSAGE, { reason });
}

/**
 * The account still proves, at the moment of the write, the order's phone or
 * email: a live, unerased account whose PROVEN phone (`phone_verified_at`) or
 * PROVEN email (`email_verified_at`) is the order's. Read from the account row
 * inside the write, never from a session's copy, so a contact typed at sign-up
 * and never proven, or a proof another sign-in write took away meanwhile,
 * claims nothing.
 */
function provenContactCondition(customerId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${customers} AS claimant WHERE claimant.id = ${customerId}
    AND claimant.erased_at IS NULL AND claimant.deleted_at IS NULL
    AND ((claimant.phone_verified_at IS NOT NULL AND claimant.phone <> '' AND claimant.phone = ${sql.raw('"orders"."customer_phone"')})
      OR (claimant.email_verified_at IS NOT NULL AND trim(coalesce(claimant.email, '')) <> ''
        AND lower(trim(claimant.email)) = lower(trim(${sql.raw('"orders"."customer_email"')})))))`;
}

/**
 * Attach a receipt-proven guest order to an authenticated account.
 *
 * Receipt authorization is verified by the API before this service is called.
 * The account must also have PROVEN (by a sign-in code) the order's phone or
 * email: a contact only typed into the account proves nothing, so a receipt
 * on a shared device never moves the order, its keys or its messages to
 * someone else's account (rules/orders/claim-needs-proven-contact.md). This
 * changes only private account ownership; the merchant CRM customer link's
 * already-counted order metrics remain untouched.
 */
export async function claimGuestOrderToAccount(
  db: Database,
  input: ClaimGuestOrderToAccountInput,
): Promise<ClaimGuestOrderToAccountResult> {
  const order = await db
    .select({
      id: orders.id,
      accountOwnerCustomerId: orders.accountOwnerCustomerId,
      customerEmail: orders.customerEmail,
      customerPhone: orders.customerPhone,
    })
    .from(orders)
    .where(and(eq(orders.id, input.orderId), isNull(orders.deletedAt)))
    .get();

  if (!order) throw new NotFoundError("Order receipt not found");
  if (order.accountOwnerCustomerId === input.customerId) {
    return { orderId: order.id, customerId: input.customerId, alreadyClaimed: true };
  }
  if (order.accountOwnerCustomerId) {
    throw new ConflictError("This order is already saved to another customer account.");
  }

  const account = await db
    .select({
      email: customers.email,
      emailVerifiedAt: customers.emailVerifiedAt,
      phone: customers.phone,
      phoneVerifiedAt: customers.phoneVerifiedAt,
      erasedAt: customers.erasedAt,
      deletedAt: customers.deletedAt,
    })
    .from(customers)
    .where(eq(customers.id, input.customerId))
    .get();
  if (!account || account.erasedAt || account.deletedAt) throw claimRefused("contact_mismatch");
  // A phone matches only a phone: an order placed without one never matches by it.
  const orderPhone = phoneOrNull(order.customerPhone);
  const orderEmail = normalizeEmail(order.customerEmail);
  const phoneMatches = orderPhone !== null && phoneOrNull(account.phone) === orderPhone;
  const emailMatches = orderEmail !== "" && normalizeEmail(account.email) === orderEmail;
  const provenMatch = (phoneMatches && account.phoneVerifiedAt !== null) || (emailMatches && account.emailVerifiedAt !== null);
  if (!provenMatch) throw claimRefused(phoneMatches || emailMatches ? "contact_not_proven" : "contact_mismatch");

  const claimed = await db
    .update(orders)
    .set({
      // Filed under the account on both sides (see customer-identity.ts).
      customerId: input.customerId,
      accountOwnerCustomerId: input.customerId,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(
      eq(orders.id, input.orderId),
      isNull(orders.accountOwnerCustomerId),
      isNull(orders.deletedAt),
      provenContactCondition(input.customerId),
    ))
    .returning({ id: orders.id });

  if (claimed.length > 0) {
    return { orderId: input.orderId, customerId: input.customerId, alreadyClaimed: false };
  }

  const latest = await db
    .select({ accountOwnerCustomerId: orders.accountOwnerCustomerId })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .get();
  if (latest?.accountOwnerCustomerId === input.customerId) {
    return { orderId: input.orderId, customerId: input.customerId, alreadyClaimed: true };
  }
  if (latest?.accountOwnerCustomerId) {
    throw new ConflictError("This order is already saved to another customer account.");
  }
  throw new ConflictError("This order changed while it was being saved. Refresh the receipt and try again.");
}
