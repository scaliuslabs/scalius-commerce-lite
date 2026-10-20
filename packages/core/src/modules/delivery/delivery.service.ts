// Delivery providers and shipments. Every courier is an app's, reached
// through the one courier port (./couriers/port.ts): a provider row's `type`
// names the courier, the request's couriers resolve it, and nothing here
// branches on which courier it is.
import { deliveryProviders, deliveryShipments, orders, orderItems, products, ShipmentStatus, type Order } from "@scalius/database/schema";
import { fromMinor } from "@scalius/shared/money";
import { DELIVERY_HIERARCHY_COUNTRY } from "@scalius/shared/markets";
import { providerServesCountry } from "@scalius/shared/plugins/providers";
import {
  providerErrorOf,
  type CourierFind,
  type CourierShipment,
  type CourierShipmentInput,
} from "@scalius/shared/plugins/providers";

import type { Database } from "@scalius/database/client";
import {
  PROVIDER_OUTCOME_UNKNOWN,
  type MerchantOrderShipmentLookup,
  type ShipmentOptions,
  type ShipmentResult,
} from "./types";
import { and, eq, desc, getTableColumns, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { NotFoundError, ValidationError, ServiceUnavailableError, ConflictError } from "@scalius/core/errors";
import {
  assertNoActivePaymentSessionAttempt,
  assertNoActiveRefundAttempt,
  assertNoActiveShipmentClaim,
  hasActiveShipmentClaim,
} from "../order-kernel";
import { assertOrderStockCoverable, InventoryLocationShortfallError } from "../inventory";
import { getDeliveryProviderReadinessSummary } from "./provider-readiness";
import type { DeliveryProviderReadinessSummary } from "./provider-readiness";
import type { Courier, CourierCall, CourierRow, CourierSetup } from "./couriers/port";
import { courierFor, type CourierProvidersSource } from "./couriers/registry";
import { readinessMessages } from "@scalius/shared/readiness";

type ShipmentInternalOptions = {
  shipmentId?: string;
  /** The request's couriers (the active apps'); absent: none. */
  couriers?: CourierProvidersSource;
};

type DeliveryProviderActionReadiness =
  | {
    ready: true;
    provider: NonNullable<Awaited<ReturnType<typeof getDeliveryProvider>>>;
    courier: Courier;
    /** The courier's settings for this row, read once for the action. */
    settings: unknown;
    summary: DeliveryProviderReadinessSummary;
  }
  | {
    ready: false;
    provider: Awaited<ReturnType<typeof getDeliveryProvider>> | null;
    summary?: DeliveryProviderReadinessSummary;
    message: string;
  };

const EXPIRED_CLAIM_DELETABLE_STATUSES = new Set<string>([
  ShipmentStatus.FAILED,
  ShipmentStatus.CANCELLED,
]);

const DELETABLE_SHIPMENT_STATUSES = new Set<string>([
  ShipmentStatus.FAILED,
  ShipmentStatus.CANCELLED,
]);

export const ORDER_SHIPMENT_LIST_LIMIT = 100;

function mergeShipmentMetadata(
  existing: string | null | undefined,
  next: Record<string, unknown>,
): string {
  let parsed: Record<string, unknown> = {};
  if (existing) {
    try {
      const value = JSON.parse(existing);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
  }

  return JSON.stringify({ ...parsed, ...next });
}

/**
 * Where the parcel goes, from the saved order's address snapshot: the
 * recipient (the contact unless another was given), the street lines, the
 * store's location ids and names (Bangladesh), the postal code and the
 * country.
 */
function shipmentRecipient(order: Order): CourierShipmentInput["recipient"] {
  // A shipped order always has a phone (the shared contact rule); fail closed if not.
  const phone = order.shippingPhone ?? order.customerPhone;
  if (!phone) throw new ValidationError("This order has no phone number for the courier. Add one to the order first.");
  return {
    name: order.shippingName ?? order.customerName,
    phone,
    address: [order.shippingAddress, order.shippingAddressLine2].filter(Boolean).join(", "),
    cityId: order.city ?? null,
    zoneId: order.zone ?? null,
    areaId: order.area ?? null,
    cityName: order.cityName ?? order.shippingLocality ?? null,
    zoneName: order.zoneName ?? null,
    areaName: order.areaName ?? null,
    postalCode: order.shippingPostalCode ?? null,
    // Written before 0113 without a country, an address is Bangladesh's.
    country: order.shippingCountryCode ?? (order.shippingAddress?.trim() ? DELIVERY_HIERARCHY_COUNTRY : null),
  };
}

/** Why a courier is not offered for an order shipping to `country` (merchant-facing). */
export function courierCountryMessage(label: string, country: string | null): string {
  return country
    ? `${label} doesn't deliver to ${country}. Ship this order another way.`
    : `${label} needs a delivery address.`;
}

/**
 * A row's courier and its setup. A courier this request cannot use (an app
 * that is no longer active, or an unknown type) is a blocked setup, never a
 * call.
 */
async function readCourierSetup(
  provider: CourierRow,
  encryptionKey: string | undefined,
  couriers: CourierProvidersSource | undefined,
): Promise<{ courier: Courier | null; setup: CourierSetup }> {
  const courier = await courierFor(couriers, provider.type);
  if (courier) return { courier, setup: await courier.setup(provider, encryptionKey) };
  return {
    courier: null,
    setup: {
      settings: null,
      error: `Unsupported provider type: ${provider.type}`,
      readiness: getDeliveryProviderReadinessSummary({
        type: provider.type,
        isActive: provider.isActive,
        lastTestAttemptAt: provider.lastTestAttemptAt,
        lastTestSuccessAt: provider.lastTestSuccessAt,
        lastTestFailureAt: provider.lastTestFailureAt,
      }),
    },
  };
}

/** Why a row's courier cannot be called: fixed text, never a value. */
function setupFailureMessage(setup: CourierSetup): string {
  const reason = setup.error ?? "Delivery provider setup is incomplete or unreadable.";
  return `Failed to create provider: ${setup.unreadable ? `Invalid credentials format: ${reason}` : reason}`;
}

/** The courier and settings of a row whose setup can be read, else a 503. */
async function requireCourierSettings(
  provider: CourierRow,
  encryptionKey: string | undefined,
  couriers: CourierProvidersSource | undefined,
): Promise<{ courier: Courier; settings: unknown }> {
  const { courier, setup } = await readCourierSetup(provider, encryptionKey, couriers);
  if (!courier || setup.settings === null) {
    console.error("[delivery] could not read provider setup", { providerType: provider.type, providerId: provider.id });
    throw new ServiceUnavailableError(setupFailureMessage(setup));
  }
  return { courier, settings: setup.settings };
}

function courierCall(settings: unknown, db: Database): CourierCall {
  return { settings, signal: new AbortController().signal, db };
}

/** Whether a setup may be switched on: the courier's own blockers, thrown as one validation error. */
export async function assertDeliveryProviderActivatable(
  provider: Pick<CourierRow, "type">,
  encryptionKey: string | undefined,
  couriers?: CourierProvidersSource,
): Promise<void> {
  const { setup } = await readCourierSetup({
    id: "",
    isActive: true,
    credentials: "{}",
    config: "{}",
    lastTestAttemptAt: null,
    lastTestSuccessAt: null,
    lastTestFailureAt: null,
    lastTestSuccessFingerprint: null,
    ...provider,
  }, encryptionKey, couriers);
  const blockers = setup.readiness.activationBlockers;
  if (blockers.length === 0) return;
  throw new ValidationError("Delivery provider cannot be activated until required setup is complete.", { blockers });
}

/** A delivery provider row's readiness, as settings and shipment actions judge it. */
export async function getDeliveryProviderReadiness(
  provider: CourierRow,
  encryptionKey: string | undefined,
  couriers?: CourierProvidersSource,
): Promise<DeliveryProviderReadinessSummary> {
  return (await readCourierSetup(provider, encryptionKey, couriers)).setup.readiness;
}

function providerActionFailureMessage(
  providerId: string,
  summary: DeliveryProviderReadinessSummary,
): string {
  const blockerMessages = readinessMessages(summary);
  return `Delivery provider ${providerId} is not ready for shipment creation: ${blockerMessages.join(" ")}`;
}

export async function getDeliveryProviderActionReadiness(
  db: Database,
  providerId: string,
  encryptionKey?: string,
  couriers?: CourierProvidersSource,
): Promise<DeliveryProviderActionReadiness> {
  const provider = await getDeliveryProvider(db, providerId);
  if (!provider) {
    return {
      ready: false,
      provider: null,
      message: `Delivery provider ${providerId} was not found.`,
    };
  }

  const { courier, setup } = await readCourierSetup(provider, encryptionKey, couriers);
  if (setup.unreadable) {
    return {
      ready: false,
      provider,
      message: `Delivery provider ${providerId} is not ready for shipment creation: ${setup.error}`,
    };
  }
  const summary = setup.readiness;
  if (!courier || !summary.active || setup.settings === null) {
    return {
      ready: false,
      provider,
      summary,
      message: providerActionFailureMessage(providerId, summary),
    };
  }

  return { ready: true, provider, courier, settings: setup.settings, summary };
}

export async function markShipmentReconciliationRequired(
  db: Database,
  shipmentId: string,
  reason: string,
  data?: ShipmentResult["data"],
  error?: unknown,
): Promise<void> {
  const existing = await db
    .select({ metadata: deliveryShipments.metadata })
    .from(deliveryShipments)
    .where(eq(deliveryShipments.id, shipmentId))
    .get();

  const errorMessage = error instanceof Error ? error.message : error ? String(error) : undefined;
  await db
    .update(deliveryShipments)
    .set({
      ...(data?.externalId !== undefined ? { externalId: data.externalId } : {}),
      ...(data?.trackingId !== undefined ? { trackingId: data.trackingId } : {}),
      status: ShipmentStatus.RECONCILE_REQUIRED,
      rawStatus: reason,
      metadata: mergeShipmentMetadata(existing?.metadata, {
        ...(data?.metadata ?? {}),
        reconciliation: {
          required: true,
          reason,
          ...(data?.status ? { providerStatus: data.status } : {}),
          error: errorMessage,
          detectedAt: new Date().toISOString(),
        },
      }),
      updatedAt: sql`unixepoch()`,
    })
    .where(eq(deliveryShipments.id, shipmentId));
}

/**
 * Get all providers from the database
 */
export async function getDeliveryProviders(
  db: Database,
  options?: { limit: number; offset: number },
) {
  const query = db
    .select()
    .from(deliveryProviders)
    .orderBy(desc(deliveryProviders.updatedAt));
  if (!options) return query;
  return query
    .limit(Math.max(1, Math.min(options.limit, 11)))
    .offset(Math.max(0, options.offset));
}

/**
 * Get provider by ID
 */
export async function getDeliveryProvider(db: Database, id: string) {
  const [provider] = await db
    .select()
    .from(deliveryProviders)
    .where(eq(deliveryProviders.id, id));

  return provider;
}

/**
 * Save provider to database (create or update)
 */
/**
 * Saves a merchant's courier: its name, the app courier it uses and whether
 * it is on. The courier's keys and options live in the app's settings; the
 * row carries none. Switching it on checks the courier's readiness first.
 */
export async function saveDeliveryProvider(
  db: Database,
  provider: { id: string; name: string; type: string; isActive: boolean },
  encryptionKey: string | undefined,
  couriers?: CourierProvidersSource,
) {
  const providerId = provider.id || nanoid();
  if (provider.isActive) await assertDeliveryProviderActivatable({ type: provider.type }, encryptionKey, couriers);
  const existingProvider = await getDeliveryProvider(db, providerId);
  if (existingProvider) {
    await db
      .update(deliveryProviders)
      .set({
        name: provider.name,
        type: provider.type,
        isActive: provider.isActive,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(deliveryProviders.id, providerId));
  } else {
    await db.insert(deliveryProviders).values({
      id: providerId,
      name: provider.name,
      type: provider.type,
      isActive: provider.isActive,
      credentials: "{}",
      config: "{}",
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    });
  }
  return { ...provider, id: providerId };
}

/** Runs a courier's connection test with a row's settings. */
async function testCourierConnection(
  courier: Courier,
  settings: unknown,
  db: Database,
): Promise<{ success: boolean; message: string }> {
  if (!courier.testConnection) {
    return { success: false, message: `${courier.label} does not offer a connection test.` };
  }
  const result = await courier.testConnection({}, courierCall(settings, db));
  return { success: result.ok, message: result.message };
}

/**
 * Test provider connection
 */
export async function testDeliveryProvider(
  db: Database,
  id: string,
  encryptionKey?: string,
  couriers?: CourierProvidersSource,
) {
  const provider = await getDeliveryProvider(db, id);
  if (!provider) {
    throw new NotFoundError(`Provider with ID ${id} not found`);
  }

  const testedAt = sql`unixepoch()`;
  await db
    .update(deliveryProviders)
    .set({
      lastTestAttemptAt: testedAt,
      updatedAt: sql`unixepoch()`,
    })
    .where(eq(deliveryProviders.id, id));

  try {
    if (!encryptionKey) {
      throw new ServiceUnavailableError("CREDENTIAL_ENCRYPTION_KEY is required to test provider readiness.");
    }
    const { courier, setup } = await readCourierSetup(provider, encryptionKey, couriers);
    if (setup.unreadable) throw new ServiceUnavailableError(setup.error ?? "Delivery provider credentials cannot be read.");
    if (setup.readiness.activationBlockers.length > 0) {
      throw new ValidationError("Delivery provider cannot be activated until required setup is complete.", {
        blockers: setup.readiness.activationBlockers,
      });
    }
    if (!courier || setup.settings === null) throw new ServiceUnavailableError(setupFailureMessage(setup));
    const result = await testCourierConnection(courier, setup.settings, db);
    if (result.success) {
      await db
        .update(deliveryProviders)
        .set({
          lastTestSuccessAt: sql`unixepoch()`,
          lastTestFailureAt: null,
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(deliveryProviders.id, id));
    } else {
      await db
        .update(deliveryProviders)
        .set({
          lastTestFailureAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(deliveryProviders.id, id));
    }
    return result;
  } catch (error: unknown) {
    await db
      .update(deliveryProviders)
      .set({
        lastTestFailureAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(deliveryProviders.id, id));
    return {
      success: false,
      message: `Failed to test provider: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Asks the courier whether it booked this order (its `findShipment`):
 * positive-only, so anything but a confirmation keeps the recovery lock.
 * Couriers without a lookup answer so without reading their setup.
 */
export async function lookupShipmentByMerchantOrderId(
  db: Database,
  providerId: string,
  merchantOrderId: string,
  encryptionKey?: string,
  couriers?: CourierProvidersSource,
): Promise<MerchantOrderShipmentLookup> {
  const provider = await getDeliveryProvider(db, providerId);
  if (!provider) throw new NotFoundError("Delivery provider not found");
  const courier = await courierFor(couriers, provider.type);
  if (!courier?.findShipment) {
    return {
      confirmed: false,
      message: `${provider.type} does not support lookup by the original order number. Confirm the outcome in the courier portal or with courier support.`,
    };
  }
  const { settings } = await requireCourierSettings(provider, encryptionKey, couriers);
  let found: CourierFind;
  try {
    found = await courier.findShipment({ orderId: merchantOrderId }, courierCall(settings, db));
  } catch (error) {
    const failure = providerErrorOf(error);
    if (!failure) throw error;
    return { confirmed: false, message: `${failure.message} The recovery lock remains active.` };
  }
  if (!found.found) return { confirmed: false, message: found.message };
  return {
    confirmed: true,
    courier: courier.label,
    externalId: found.externalId,
    status: found.tracking.status,
    rawStatus: found.tracking.rawStatus,
  };
}

/**
 * Create shipment for an order
 *
 * Uses insert-first pattern: a "creating" record is written before calling
 * the provider API, then updated with the result.  This guarantees a DB
 * record exists even when the provider succeeds but the subsequent DB
 * write fails (e.g. due to a worker timeout).
 */
export async function createShipment(
  db: Database,
  orderId: string,
  providerId: string,
  options?: ShipmentOptions,
  encryptionKey?: string,
  internalOptions?: ShipmentInternalOptions,
): Promise<ShipmentResult> {
  // Get order
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId));

  if (!order) {
    return {
      success: false,
      message: `Order with ID ${orderId} not found`,
    };
  }

  const providerReadiness = await getDeliveryProviderActionReadiness(db, providerId, encryptionKey, internalOptions?.couriers);
  if (!providerReadiness.ready) {
    return {
      success: false,
      message: providerReadiness.message,
    };
  }
  const { provider, courier, settings } = providerReadiness;

  const recipient = shipmentRecipient(order);
  // A courier never books outside its countries (the order page hides it for such an order).
  if (!providerServesCountry(courier.countries, recipient.country)) {
    return { success: false, message: courierCountryMessage(courier.label, recipient.country) };
  }
  const preflightFailure = await courier.preflight?.(recipient, db);
  if (preflightFailure) return { success: false, message: preflightFailure };

  // Booking ships the order, which deducts its stock at its fulfilment
  // location: never book a courier for units that location doesn't hold.
  try {
    await assertOrderStockCoverable(db, orderId);
  } catch (error) {
    if (error instanceof InventoryLocationShortfallError) return { success: false, message: error.message };
    throw error;
  }

  // Load order items with product names for item description and count
  const items = await db
    .select({
      quantity: orderItems.quantity,
      productName: products.name,
    })
    .from(orderItems)
    .leftJoin(products, eq(products.id, orderItems.productId))
    .where(eq(orderItems.orderId, orderId));

  const totalItemCount = items.reduce((sum, i) => sum + i.quantity, 0);
  const itemDescription = items
    .map((i) => `${i.productName || "Product"} x${i.quantity}`)
    .join(", ");

  // The local shipment id is the booking's idempotency key: a retry after a
  // lost answer names the same booking.
  const shipmentId = internalOptions?.shipmentId ?? nanoid();

  // Provider money and contents are order authority, never browser/provider-
  // form authority. Keep only genuine merchant choices from the caller and
  // overwrite every commerce fact with the fresh saved order projection.
  const input: CourierShipmentInput = {
    idempotencyKey: shipmentId,
    orderId: order.id,
    recipient,
    // The rider collects what is due, except on an invoice: it is paid by
    // its due date, never in cash at the door.
    codAmountMinor: order.paymentTermsDays ? 0 : Math.max(0, order.balanceDueMinor),
    currency: order.currencyCode,
    decimalPlaces: order.currencyDecimalPlaces,
    note: options?.note || order.notes || null,
    itemCount: totalItemCount > 0 ? totalItemCount : null,
    itemDescription: itemDescription || null,
    options: {
      deliveryType: options?.deliveryType ?? null,
      itemType: options?.itemType ?? null,
      itemWeightKg: options?.itemWeight ?? null,
    },
  };

  // 1. Insert a "creating" placeholder shipment FIRST
  await db.insert(deliveryShipments).values({
    id: shipmentId,
    orderId,
    providerId,
    providerType: provider.type,
    // The courier's name as staff and buyers read it ("Pathao"), whatever the row's type id.
    courierName: courier.label,
    status: "creating",
    rawStatus: "creating",
    metadata: JSON.stringify({ initiatedAt: new Date().toISOString() }),
    createdAt: sql`unixepoch()`,
    updatedAt: sql`unixepoch()`,
  });

  let shipmentResult: ShipmentResult;
  let booked: CourierShipment | null = null;
  try {
    booked = await courier.createShipment(input, courierCall(settings, db));
    shipmentResult = {
      success: true,
      message: `${courier.label} shipment created.`,
      data: {
        externalId: booked.externalId,
        // A booking without its own tracking id is tracked by its booking id.
        trackingId: booked.trackingId ?? booked.externalId,
        status: booked.status,
        metadata: booked.details ?? {},
      },
    };
  } catch (error) {
    // Only a certain refusal proves nothing was booked; anything else may
    // have reached the courier and is kept for reconciliation.
    const failure = providerErrorOf(error);
    shipmentResult = failure && !failure.uncertain
      ? { success: false, message: failure.message }
      : {
        success: false,
        reconciliationRequired: true,
        message: failure?.message
          ?? "Shipment outcome is unknown. Check the courier account for confirmation before another shipment is created.",
      };
  }

  if (shipmentResult.reconciliationRequired) {
    try {
      await markShipmentReconciliationRequired(db, shipmentId, PROVIDER_OUTCOME_UNKNOWN);
    } catch {
      // The durable creating placeholder still fences retries if this write fails.
    }
    return { ...shipmentResult, shipmentId };
  }

  if (booked && shipmentResult.data) {
    try {
      const trackingId = shipmentResult.data.trackingId;
      const trackingUrl = trackingId && courier.trackingUrl ? courier.trackingUrl(trackingId) : null;
      await db
        .update(deliveryShipments)
        .set({
          externalId: booked.externalId,
          trackingId,
          ...(trackingUrl ? { trackingUrl } : {}),
          status: booked.status || "pending",
          rawStatus: booked.rawStatus || "pending",
          metadata: JSON.stringify(booked.details ?? {}),
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(deliveryShipments.id, shipmentId));
      return { ...shipmentResult, shipmentId };
    } catch {
      try {
        await markShipmentReconciliationRequired(
          db,
          shipmentId,
          "shipment_success_persist_failed",
          shipmentResult.data,
          "Provider creation succeeded but local shipment persistence failed.",
        );
      } catch {
        // Never replace a possibly accepted request with a retryable failed row.
      }
      return {
        ...shipmentResult,
        shipmentId,
        reconciliationRequired: true,
        message: "Shipment was created but local shipment reconciliation is required.",
      };
    }
  }

  try {
    await db
      .update(deliveryShipments)
      .set({
        status: "failed",
        rawStatus: "provider_rejected",
        metadata: JSON.stringify({ error: shipmentResult.message }),
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(deliveryShipments.id, shipmentId));
    return { ...shipmentResult, shipmentId };
  } catch {
    return {
      success: false,
      shipmentId,
      reconciliationRequired: true,
      message: "Shipment rejection could not be saved. Local shipment reconciliation is required before retrying.",
    };
  }
}

/** Shipment columns plus the order currency decimals that convert its amount. */
function shipmentViewColumns() {
  return {
    ...getTableColumns(deliveryShipments),
    currencyDecimalPlaces: orders.currencyDecimalPlaces,
  };
}

/** A shipment in the decimal HTTP contract. */
export function presentShipment<T extends { shipmentAmountMinor: number | null; currencyDecimalPlaces: number }>(
  { shipmentAmountMinor, currencyDecimalPlaces, ...shipment }: T,
) {
  return {
    ...shipment,
    shipmentAmount: shipmentAmountMinor === null ? null : fromMinor(shipmentAmountMinor, currencyDecimalPlaces),
  };
}

export type ShipmentView = ReturnType<
  typeof presentShipment<typeof deliveryShipments.$inferSelect & { currencyDecimalPlaces: number }>
>;

/**
 * Get shipment by ID
 */
export async function getShipment(db: Database, id: string): Promise<ShipmentView | undefined> {
  const [shipment] = await db
    .select(shipmentViewColumns())
    .from(deliveryShipments)
    .innerJoin(orders, eq(orders.id, deliveryShipments.orderId))
    .where(eq(deliveryShipments.id, id));

  return shipment ? presentShipment(shipment) : undefined;
}

/**
 * Get latest shipment for an order
 */
export async function getLatestShipment(db: Database, orderId: string): Promise<ShipmentView | undefined> {
  const [shipment] = await db
    .select(shipmentViewColumns())
    .from(deliveryShipments)
    .innerJoin(orders, eq(orders.id, deliveryShipments.orderId))
    .where(eq(deliveryShipments.orderId, orderId))
    .orderBy(desc(deliveryShipments.createdAt))
    .limit(1);

  return shipment ? presentShipment(shipment) : undefined;
}

/**
 * Get all shipments for an order
 */
export async function getShipments(db: Database, orderId: string) {
  const rows = await db
    .select({
      ...shipmentViewColumns(),
      providerName: deliveryProviders.name,
    })
    .from(deliveryShipments)
    .innerJoin(orders, eq(orders.id, deliveryShipments.orderId))
    .leftJoin(
      deliveryProviders,
      eq(deliveryShipments.providerId, deliveryProviders.id),
    )
    .where(eq(deliveryShipments.orderId, orderId))
    .orderBy(desc(deliveryShipments.createdAt), desc(deliveryShipments.id))
    .limit(ORDER_SHIPMENT_LIST_LIMIT);
  return rows.map(presentShipment);
}

/**
 * Check and update shipment status
 */
export async function checkShipmentStatus(
  db: Database,
  shipmentId: string,
  encryptionKey?: string,
  couriers?: CourierProvidersSource,
) {
  // Get shipment
  const [shipment] = await db
    .select()
    .from(deliveryShipments)
    .where(eq(deliveryShipments.id, shipmentId));

  if (!shipment) {
    throw new NotFoundError(`Shipment with ID ${shipmentId} not found`);
  }
  await assertNoActiveRefundAttempt(db, shipment.orderId);
  await assertNoActivePaymentSessionAttempt(db, shipment.orderId);

  const orderClaim = await db
    .select({
      shipmentClaimId: orders.shipmentClaimId,
      shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
    })
    .from(orders)
    .where(eq(orders.id, shipment.orderId))
    .get();
  if (orderClaim) assertNoActiveShipmentClaim(orderClaim);

  // Get provider
  if (!shipment.providerId) {
    throw new ValidationError(`Shipment ${shipmentId} has no provider (manual shipment)`);
  }
  const provider = await getDeliveryProvider(db, shipment.providerId);
  if (!provider) {
    throw new NotFoundError(`Provider with ID ${shipment.providerId} not found`);
  }
  if (provider.isActive !== true) {
    throw new ValidationError(`Provider with ID ${shipment.providerId} is not active`);
  }

  if (!shipment.externalId) {
    throw new ValidationError(`Shipment ${shipmentId} has no external ID (not yet submitted to provider)`);
  }

  try {
    const { courier, settings } = await requireCourierSettings(provider, encryptionKey, couriers);

    let statusResult: { status: string; rawStatus: string; metadata: Record<string, unknown> };
    try {
      const tracking = await courier.trackShipment({ externalId: shipment.externalId }, courierCall(settings, db));
      statusResult = { status: tracking.status, rawStatus: tracking.rawStatus, metadata: tracking.details ?? {} };
    } catch (error: unknown) {
      const failure = providerErrorOf(error);
      if (!failure) throw error;
      // The courier could not answer: the shipment says so until the next check.
      statusResult = { status: ShipmentStatus.UNKNOWN, rawStatus: "error", metadata: { error: failure.message } };
    }

    // Update shipment in database
    await db
      .update(deliveryShipments)
      .set({
        status: statusResult.status,
        rawStatus: statusResult.rawStatus,
        updatedAt: sql`unixepoch()`,
        metadata: mergeShipmentMetadata(shipment.metadata, statusResult.metadata || {}),
      })
      .where(eq(deliveryShipments.id, shipmentId));

    return {
      shipmentId,
      externalId: shipment.externalId,
      trackingId: shipment.trackingId,
      orderId: shipment.orderId,
      status: statusResult.status,
      rawStatus: statusResult.rawStatus,
      metadata: statusResult.metadata,
    };
  } catch (error: unknown) {
    console.error(
      `Error checking shipment status: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw new ServiceUnavailableError(
      `Failed to check shipment status: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Delete a shipment
 */
export async function deleteShipmentRecord(db: Database, id: string) {
  const shipment = await db
    .select({
      id: deliveryShipments.id,
      orderId: deliveryShipments.orderId,
      status: deliveryShipments.status,
    })
    .from(deliveryShipments)
    .where(eq(deliveryShipments.id, id))
    .get();
  if (!shipment) return true;

  await assertNoActiveRefundAttempt(db, shipment.orderId);
  await assertNoActivePaymentSessionAttempt(db, shipment.orderId);

  if (shipment?.status === ShipmentStatus.CREATING) {
    throw new ValidationError("Cannot delete a shipment while provider creation is in progress");
  }
  if (shipment.status === ShipmentStatus.RECONCILE_REQUIRED) {
    throw new ConflictError("Cannot delete a shipment that requires reconciliation");
  }
  const orderClaim = await db
    .select({
      shipmentClaimId: orders.shipmentClaimId,
      shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
    })
    .from(orders)
    .where(eq(orders.id, shipment.orderId))
    .get();

  if (orderClaim) {
    if (hasActiveShipmentClaim(orderClaim)) {
      throw new ConflictError("Cannot delete a shipment while order shipment creation is in progress");
    }

    if (orderClaim.shipmentClaimId === shipment.id) {
      if (!EXPIRED_CLAIM_DELETABLE_STATUSES.has(shipment.status)) {
        throw new ConflictError("Cannot delete a shipment linked to an unresolved expired shipment claim");
      }

      await db
        .update(orders)
        .set({
          shipmentClaimId: null,
          shipmentClaimExpiresAt: null,
          updatedAt: sql`unixepoch()`,
        })
        .where(and(eq(orders.id, shipment.orderId), eq(orders.shipmentClaimId, shipment.id)));
    }
  }

  if (!DELETABLE_SHIPMENT_STATUSES.has(shipment.status)) {
    throw new ConflictError(
      "Only failed or cancelled shipment attempts can be deleted. Active and fulfilled shipment history must be preserved.",
    );
  }

  await db.delete(deliveryShipments).where(eq(deliveryShipments.id, id));

  return true;
}
