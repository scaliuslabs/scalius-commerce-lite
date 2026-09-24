import type { Database } from "@scalius/database/client";
import { customers, orders } from "@scalius/database/schema";
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";

import { ConflictError, ForbiddenError, NotFoundError } from "@scalius/core/errors";

export interface ClaimGuestOrderToAccountInput {
  orderId: string;
  customerId: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
}

export interface ClaimGuestOrderToAccountResult {
  orderId: string;
  customerId: string;
  alreadyClaimed: boolean;
}

function normalizeEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizePhone(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function immutableContactConditions(input: ClaimGuestOrderToAccountInput): SQL[] {
  const conditions: SQL[] = [];
  const phone = normalizePhone(input.customerPhone);
  const email = normalizeEmail(input.customerEmail);
  if (phone) conditions.push(eq(orders.customerPhone, phone));
  if (email) conditions.push(sql`lower(trim(${orders.customerEmail})) = ${email}`);
  return conditions;
}

/**
 * The statement that adds unowned orders placed with an account's VERIFIED
 * email or phone to that account's history (Shopify attaches orders by
 * verified contact). Returns null when the account has nothing verified.
 * Only private account ownership changes; the merchant CRM link and the
 * order's own contact snapshot stay as they are.
 */
export function buildVerifiedContactOrderLink(
  db: Database,
  input: { customerId: string; email?: string | null; phone?: string | null },
) {
  const conditions: SQL[] = [];
  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);
  if (phone) conditions.push(eq(orders.customerPhone, phone));
  if (email) conditions.push(sql`lower(trim(${orders.customerEmail})) = ${email}`);
  if (conditions.length === 0) return null;
  return db
    .update(orders)
    .set({ accountOwnerCustomerId: input.customerId })
    .where(and(
      isNull(orders.accountOwnerCustomerId),
      isNull(orders.deletedAt),
      or(...conditions),
    ));
}

/** Links verified-contact guest orders for a signed-in account (any device). */
export async function linkVerifiedContactOrders(db: Database, customerId: string): Promise<void> {
  const account = await db
    .select({
      email: customers.email,
      phone: customers.phone,
      emailVerifiedAt: customers.emailVerifiedAt,
      phoneVerifiedAt: customers.phoneVerifiedAt,
    })
    .from(customers)
    .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)))
    .get();
  if (!account) return;
  await buildVerifiedContactOrderLink(db, {
    customerId,
    email: account.emailVerifiedAt ? account.email : null,
    phone: account.phoneVerifiedAt ? account.phone : null,
  });
}

/**
 * Attach a receipt-proven guest order to an authenticated account.
 *
 * Receipt authorization is verified by the API before this service is called.
 * This service additionally requires the active account to match an immutable
 * checkout contact and changes only private account ownership. The merchant CRM
 * customer link and its already-counted order metrics remain untouched.
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

  const contactConditions = immutableContactConditions(input);
  if (contactConditions.length === 0) {
    throw new ForbiddenError("The signed-in account does not match this order contact.");
  }
  const contactMatches = (
    normalizePhone(input.customerPhone) !== "" &&
    normalizePhone(input.customerPhone) === normalizePhone(order.customerPhone)
  ) || (
    normalizeEmail(input.customerEmail) !== "" &&
    normalizeEmail(input.customerEmail) === normalizeEmail(order.customerEmail)
  );
  if (!contactMatches) {
    throw new ForbiddenError("The signed-in account does not match this order contact.");
  }

  const claimed = await db
    .update(orders)
    .set({
      accountOwnerCustomerId: input.customerId,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(
      eq(orders.id, input.orderId),
      isNull(orders.accountOwnerCustomerId),
      isNull(orders.deletedAt),
      or(...contactConditions),
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
