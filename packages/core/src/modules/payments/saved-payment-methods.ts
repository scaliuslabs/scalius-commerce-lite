// Saved payment methods (`customer_payment_methods`, migration 0173): a
// buyer's card or wallet kept by its provider for charges without the buyer.
// The store keeps the provider's opaque reference and display facts only.
//
// - Saving: `buildSavedPaymentMethodUpsert` rides the batch that applies the
//   confirmed or authorized payment that kept it (process-payment.ts), for
//   the order's account customer only, and only once that payment landed.
//   One row per provider method: a repeat refreshes its facts and never
//   moves it to another customer or app.
// - Owning (0175, security audit N3): a method belongs to the app whose
//   purchase option the buyer kept it for. An app sees, charges and removes
//   only its own; staff see and act on every method; the buyer sees and
//   removes their own in their account (`SavedMethodActor`).
// - Removing: the provider detaches it first (`deleteSavedMethod`, when the
//   gateway has it), then the row is marked `removed`. A retry is safe: the
//   provider answers `not_found` for a method it already let go.
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { customerPaymentMethods, orderItems, type CustomerPaymentMethodStatus } from "@scalius/database/schema";
import { LINE_PURCHASE_OPTION_PROPERTY_KEY, readLinePurchaseOption } from "@scalius/shared/line-properties";
import { purchaseOptionAppId } from "@scalius/shared/plugins/ids";
import type { Database } from "@scalius/database/client";
import { NotFoundError, ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import { providerErrorOf } from "@scalius/shared/plugins/providers/kinds";
import type { SavedPaymentMethod } from "@scalius/shared/plugins/providers/payment";
import { paymentProvidersFor, type PaymentProvidersSource } from "./gateways/registry";
import { gatewayHasCapability } from "./gateways/port";

type SQLiteBatchItem = BatchItem<"sqlite">;

/** At most this many active methods are listed per customer (newest last). */
export const CUSTOMER_PAYMENT_METHODS_LIST_LIMIT = 50;

/**
 * Who reads or acts on saved methods: staff (and agents acting for them)
 * reach every method; an app only the ones kept for its own purchase
 * options; a buyer only their own.
 */
export type SavedMethodActor =
  | { kind: "staff" }
  | { kind: "app"; pluginId: string }
  | { kind: "customer"; customerId: string };

/** Whether the actor may see and act on the method (others read it as not found). */
export function savedMethodVisibleTo(
  method: Pick<CustomerPaymentMethodView, "customerId" | "ownerPluginId">,
  actor: SavedMethodActor,
): boolean {
  if (actor.kind === "staff") return true;
  if (actor.kind === "app") return method.ownerPluginId === actor.pluginId;
  return method.customerId === actor.customerId;
}

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
  /** The app that kept it for its purchase option: the only app that may charge it (null: staff only). */
  ownerPluginId: string | null;
  purchaseOptionId: string | null;
  /** What the buyer kept it for, as they saw it at checkout ("Subscribe and save"). */
  purchaseOptionTitle: string | null;
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
  ownerPluginId: customerPaymentMethods.ownerPluginId,
  purchaseOptionId: customerPaymentMethods.purchaseOptionId,
  purchaseOptionTitle: customerPaymentMethods.purchaseOptionTitle,
  createdAt: customerPaymentMethods.createdAt,
  updatedAt: customerPaymentMethods.updatedAt,
};

function newMethodId(): string {
  return `cpm_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** The app a kept method belongs to, and the purchase option it was kept for. */
export interface SavedPaymentMethodOwner {
  ownerPluginId: string | null;
  purchaseOptionId: string | null;
  purchaseOptionTitle: string | null;
}

const NO_OWNER: SavedPaymentMethodOwner = { ownerPluginId: null, purchaseOptionId: null, purchaseOptionTitle: null };

/** The title frozen beside a line's purchase option (`displayValue`), or null. */
function purchaseOptionTitleOf(properties: string | null): string | null {
  try {
    const entries: unknown = properties ? JSON.parse(properties) : null;
    if (!Array.isArray(entries)) return null;
    for (const entry of entries) {
      if (entry && typeof entry === "object" && (entry as { key?: unknown }).key === LINE_PURCHASE_OPTION_PROPERTY_KEY) {
        const title = (entry as { displayValue?: unknown }).displayValue;
        return typeof title === "string" && title.trim() ? title.trim().slice(0, 80) : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Whose purchase option the buyer kept a method for (security audit N3):
 * the one app owning every `_purchase_option` line of the order, and the
 * option itself (with its title) when there is exactly one. Options of two
 * apps (or none) own nothing: no app may charge that method, only staff.
 */
export async function readSavedPaymentMethodOwner(db: Database, orderId: string): Promise<SavedPaymentMethodOwner> {
  const lines = await db.select({ properties: orderItems.properties }).from(orderItems).where(eq(orderItems.orderId, orderId)).all();
  const options = new Map<string, string | null>();
  for (const line of lines) {
    const option = readLinePurchaseOption(line.properties);
    if (option && !options.has(option)) options.set(option, purchaseOptionTitleOf(line.properties));
  }
  const apps = new Set([...options.keys()].map((option) => purchaseOptionAppId(option)));
  const [app] = [...apps];
  if (apps.size !== 1 || !app) return NO_OWNER;
  const only = options.size === 1 ? [...options][0]! : null;
  return { ownerPluginId: app, purchaseOptionId: only?.[0] ?? null, purchaseOptionTitle: only?.[1] ?? null };
}

/**
 * The upsert of a kept method, for the batch that applies its payment:
 * written for the order's account customer when `landed` holds (the payment
 * row is in its new state). A guest order writes nothing. A known method
 * refreshes its facts (and becomes active again) only for its own customer,
 * and keeps the app it was first kept for.
 */
export function buildSavedPaymentMethodUpsert(
  db: Database,
  input: { orderId: string; providerId: string; method: SavedPaymentMethod; owner: SavedPaymentMethodOwner; landed: SQL },
): SQLiteBatchItem {
  const method = input.method;
  // Columns in the table's order (an INSERT … SELECT names none).
  return db.insert(customerPaymentMethods).select(sql`
    SELECT ${newMethodId()}, owner_order.account_owner_customer_id, ${input.providerId}, ${method.ref},
      ${method.brand ?? null}, ${method.last4 ?? null}, ${method.expiryMonth ?? null}, ${method.expiryYear ?? null},
      ${method.label ?? null}, 'active', owner_order.id, unixepoch(), unixepoch(),
      ${input.owner.ownerPluginId}, ${input.owner.purchaseOptionId}, ${input.owner.purchaseOptionTitle}
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

/** A customer's active saved methods the actor may see, oldest first. */
export async function listCustomerPaymentMethods(
  db: Database,
  customerId: string,
  actor: SavedMethodActor,
): Promise<CustomerPaymentMethodView[]> {
  if (actor.kind === "customer" && actor.customerId !== customerId) return [];
  return await db
    .select(VIEW_COLUMNS)
    .from(customerPaymentMethods)
    .where(and(
      eq(customerPaymentMethods.customerId, customerId),
      eq(customerPaymentMethods.status, "active"),
      actor.kind === "app" ? eq(customerPaymentMethods.ownerPluginId, actor.pluginId) : undefined,
    ))
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
  /** Who removes it: an app only its own, a buyer only theirs. */
  actor: SavedMethodActor;
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
  if (!method || !savedMethodVisibleTo(method, input.actor)) throw new NotFoundError("Saved payment method not found");
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
