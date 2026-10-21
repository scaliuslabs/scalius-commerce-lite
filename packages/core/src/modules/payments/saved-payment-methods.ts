// Saved payment methods (`customer_payment_methods`, migration 0173): a
// buyer's card or wallet kept by its provider for charges without the buyer.
// The store keeps the provider's opaque reference and display facts only.
//
// - Saving: `buildSavedPaymentMethodUpsert` rides the batch that applies the
//   confirmed or authorized payment that kept it (process-payment.ts), for
//   the order's account customer only, and only once that payment landed.
//   One row per provider method: a repeat refreshes its facts and never
//   moves it to another customer.
// - Removing: the provider detaches it first (`deleteSavedMethod`, when the
//   gateway has it), then the row is marked `removed`. A retry is safe: the
//   provider answers `not_found` for a method it already let go.
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { customerPaymentMethods, type CustomerPaymentMethodStatus } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { NotFoundError, ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import { providerErrorOf } from "@scalius/shared/plugins/providers/kinds";
import type { SavedPaymentMethod } from "@scalius/shared/plugins/providers/payment";
import { paymentProvidersFor, type PaymentProvidersSource } from "./gateways/registry";
import { gatewayHasCapability } from "./gateways/port";

type SQLiteBatchItem = BatchItem<"sqlite">;

/** At most this many active methods are listed per customer (newest last). */
export const CUSTOMER_PAYMENT_METHODS_LIST_LIMIT = 50;

/** A saved method as staff and apps see it: never the provider reference. */
export interface CustomerPaymentMethodView {
  id: string;
  customerId: string;
  providerId: string;
  brand: string | null;
  last4: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  label: string | null;
  status: CustomerPaymentMethodStatus;
  sourceOrderId: string | null;
  createdAt: number;
  updatedAt: number;
}

const VIEW_COLUMNS = {
  id: customerPaymentMethods.id,
  customerId: customerPaymentMethods.customerId,
  providerId: customerPaymentMethods.providerId,
  brand: customerPaymentMethods.brand,
  last4: customerPaymentMethods.last4,
  expiryMonth: customerPaymentMethods.expiryMonth,
  expiryYear: customerPaymentMethods.expiryYear,
  label: customerPaymentMethods.label,
  status: customerPaymentMethods.status,
  sourceOrderId: customerPaymentMethods.sourceOrderId,
  createdAt: customerPaymentMethods.createdAt,
  updatedAt: customerPaymentMethods.updatedAt,
};

function newMethodId(): string {
  return `cpm_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * The upsert of a kept method, for the batch that applies its payment:
 * written for the order's account customer when `landed` holds (the payment
 * row is in its new state). A guest order writes nothing. A known method
 * refreshes its facts (and becomes active again) only for its own customer.
 */
export function buildSavedPaymentMethodUpsert(
  db: Database,
  input: { orderId: string; providerId: string; method: SavedPaymentMethod; landed: SQL },
): SQLiteBatchItem {
  const method = input.method;
  // Columns in the table's order (an INSERT … SELECT names none).
  return db.insert(customerPaymentMethods).select(sql`
    SELECT ${newMethodId()}, owner_order.account_owner_customer_id, ${input.providerId}, ${method.ref},
      ${method.brand ?? null}, ${method.last4 ?? null}, ${method.expiryMonth ?? null}, ${method.expiryYear ?? null},
      ${method.label ?? null}, 'active', owner_order.id, unixepoch(), unixepoch()
    FROM orders AS owner_order
    WHERE owner_order.id = ${input.orderId}
      AND owner_order.account_owner_customer_id IS NOT NULL
      AND ${input.landed}
  `).onConflictDoUpdate({
    target: [customerPaymentMethods.providerId, customerPaymentMethods.providerMethodRef],
    set: {
      brand: sql`excluded.brand`,
      last4: sql`excluded.last4`,
      expiryMonth: sql`excluded.expiry_month`,
      expiryYear: sql`excluded.expiry_year`,
      label: sql`excluded.label`,
      status: "active",
      updatedAt: sql`unixepoch()`,
    },
    // Never moved to another customer.
    setWhere: sql`${customerPaymentMethods.customerId} = excluded.customer_id`,
  }) as unknown as SQLiteBatchItem;
}

/** A customer's active saved methods, oldest first. */
export async function listCustomerPaymentMethods(db: Database, customerId: string): Promise<CustomerPaymentMethodView[]> {
  return await db
    .select(VIEW_COLUMNS)
    .from(customerPaymentMethods)
    .where(and(eq(customerPaymentMethods.customerId, customerId), eq(customerPaymentMethods.status, "active")))
    .orderBy(asc(customerPaymentMethods.createdAt), asc(customerPaymentMethods.id))
    .limit(CUSTOMER_PAYMENT_METHODS_LIST_LIMIT)
    .all() as CustomerPaymentMethodView[];
}

/** One saved method with its provider reference: for the payment kernel only, never a response. */
export async function readCustomerPaymentMethod(
  db: Database,
  methodId: string,
): Promise<(CustomerPaymentMethodView & { providerMethodRef: string }) | null> {
  const row = await db
    .select({ ...VIEW_COLUMNS, providerMethodRef: customerPaymentMethods.providerMethodRef })
    .from(customerPaymentMethods)
    .where(eq(customerPaymentMethods.id, methodId))
    .get();
  return (row as (CustomerPaymentMethodView & { providerMethodRef: string }) | undefined) ?? null;
}

export interface RemoveCustomerPaymentMethodInput {
  methodId: string;
  providers: PaymentProvidersSource;
  encryptionKey: string | undefined;
  /** Bounds the provider call. */
  signal?: AbortSignal;
}

/**
 * Remove a saved method: detach it at the provider when the gateway can
 * (`deleteSavedMethod`), then mark it `removed`. A provider that refuses or
 * cannot be reached keeps it active (retry later, nothing is lost); a
 * gateway that no longer exists, or never offered detaching, removes it
 * locally only. Removing a removed method returns it unchanged.
 */
export async function removeCustomerPaymentMethod(
  db: Database,
  input: RemoveCustomerPaymentMethodInput,
): Promise<CustomerPaymentMethodView> {
  const method = await readCustomerPaymentMethod(db, input.methodId);
  if (!method) throw new NotFoundError("Saved payment method not found");
  const { providerMethodRef, ...view } = method;
  if (method.status === "removed") return view;

  const providers = await paymentProvidersFor(input.providers, method.providerId);
  const gateway = providers.get(method.providerId);
  if (gateway?.deleteSavedMethod && gatewayHasCapability(gateway, "vault")) {
    const settings = await gateway.loadSettings(db, input.encryptionKey);
    if (!settings || settings.credentialErrors?.length || !gateway.canVerify(settings)) {
      throw new ServiceUnavailableError(`${gateway.label} cannot be reached to remove the payment method. Try again later.`);
    }
    try {
      await gateway.deleteSavedMethod(
        { ref: providerMethodRef, idempotencyKey: `delete:${method.id}` },
        { settings, signal: input.signal ?? AbortSignal.timeout(12_000) },
      );
    } catch (error) {
      const failure = providerErrorOf(error);
      if (failure?.category === "declined") throw new ValidationError(failure.message);
      throw new ServiceUnavailableError(`${gateway.label} did not confirm removing the payment method. Try again later.`);
    }
  }
  await db.update(customerPaymentMethods)
    .set({ status: "removed", updatedAt: sql`unixepoch()` })
    .where(and(eq(customerPaymentMethods.id, method.id), eq(customerPaymentMethods.status, "active")));
  return { ...view, status: "removed", updatedAt: Math.floor(Date.now() / 1000) };
}
