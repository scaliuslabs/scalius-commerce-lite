import { deliveryProviders, deliveryShipments, orders, orderItems, products, ShipmentStatus } from "@scalius/database/schema";
import { createProvider } from "./factory";
import { encryptCredentials } from "@scalius/core/utils/credential-encryption";

import type { Database } from "@scalius/database/client";
import type { ShipmentOptions, ShipmentResult } from "./types";
import { and, eq, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { NotFoundError, ValidationError, ServiceUnavailableError, ConflictError } from "@scalius/core/errors";
import { assertNoActiveShipmentClaim, hasActiveShipmentClaim } from "../orders/shipment-claim";

type ShipmentInternalOptions = {
  shipmentId?: string;
};

const EXPIRED_CLAIM_DELETABLE_STATUSES = new Set<string>([
  ShipmentStatus.FAILED,
  ShipmentStatus.CANCELLED,
]);

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
export async function getDeliveryProviders(db: Database) {
  return db
    .select()
    .from(deliveryProviders)
    .orderBy(desc(deliveryProviders.updatedAt));
}

/**
 * Get active providers from the database
 */
export async function getActiveDeliveryProviders(db: Database) {
  return db
    .select()
    .from(deliveryProviders)
    .where(eq(deliveryProviders.isActive, true))
    .orderBy(desc(deliveryProviders.updatedAt));
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
export async function saveDeliveryProvider(
  db: Database,
  provider: {
    id: string;
    name: string;
    type: string;
    isActive: boolean;
    credentials: Record<string, unknown> | string;
    config: Record<string, unknown> | string;
  },
  encryptionKey: string,
) {
  if (!encryptionKey) {
    throw new ServiceUnavailableError("CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials.");
  }

  const providerId = provider.id || nanoid();

  // Convert objects to JSON strings
  let credentials =
    typeof provider.credentials === "string"
      ? provider.credentials
      : JSON.stringify(provider.credentials);

  const config =
    typeof provider.config === "string"
      ? provider.config
      : JSON.stringify(provider.config);

  credentials = await encryptCredentials(credentials, encryptionKey);

  // Check if provider exists
  const existingProvider = await getDeliveryProvider(db, providerId);

  if (existingProvider) {
    // Update
    await db
      .update(deliveryProviders)
      .set({
        name: provider.name,
        type: provider.type,
        isActive: provider.isActive,
        credentials,
        config,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(deliveryProviders.id, providerId));
  } else {
    // Create
    await db.insert(deliveryProviders).values({
      id: providerId,
      name: provider.name,
      type: provider.type,
      isActive: provider.isActive,
      credentials,
      config,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    });
  }

  return { ...provider, id: providerId };
}

/**
 * Delete provider from database
 */
export async function deleteDeliveryProvider(db: Database, id: string) {
  await db.delete(deliveryProviders).where(eq(deliveryProviders.id, id));

  return true;
}

/**
 * Test provider connection
 */
export async function testDeliveryProvider(db: Database, id: string, encryptionKey?: string) {
  const provider = await getDeliveryProvider(db, id);
  if (!provider) {
    throw new NotFoundError(`Provider with ID ${id} not found`);
  }

  try {
    const providerInstance = await createProvider(provider, encryptionKey, db);
    return await providerInstance.testConnection();
  } catch (error: unknown) {
    return {
      success: false,
      message: `Failed to test provider: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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

  // Get provider
  const provider = await getDeliveryProvider(db, providerId);
  if (!provider) {
    return {
      success: false,
      message: `Provider with ID ${providerId} not found`,
    };
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

  // Merge enriched options with caller-provided options
  const enrichedOptions: ShipmentOptions = {
    itemCount: totalItemCount,
    itemDescription,
    ...options,
  };

  // 1. Insert a "creating" placeholder shipment FIRST
  const shipmentId = internalOptions?.shipmentId ?? nanoid();

  await db.insert(deliveryShipments).values({
    id: shipmentId,
    orderId,
    providerId,
    providerType: provider.type,
    status: "creating",
    rawStatus: "creating",
    metadata: JSON.stringify({ initiatedAt: new Date().toISOString() }),
    createdAt: sql`unixepoch()`,
    updatedAt: sql`unixepoch()`,
  });

  try {
    // 2. Call provider API
    const providerInstance = await createProvider(provider, encryptionKey, db);
    const shipmentResult = await providerInstance.createShipment(
      order,
      enrichedOptions,
    );

    if (shipmentResult.success && shipmentResult.data) {
      // 3. On success: update the record with external tracking info
      try {
        await db
          .update(deliveryShipments)
          .set({
            externalId: shipmentResult.data.externalId,
            trackingId: shipmentResult.data.trackingId,
            status: shipmentResult.data.status || "pending",
            rawStatus:
              (shipmentResult.data.metadata?.order_status as string) ||
              (shipmentResult.data.metadata?.status as string) ||
              "pending",
            metadata: JSON.stringify(shipmentResult.data.metadata || {}),
            updatedAt: sql`unixepoch()`,
          })
          .where(eq(deliveryShipments.id, shipmentId));

        return { ...shipmentResult, shipmentId };
      } catch (error: unknown) {
        await markShipmentReconciliationRequired(
          db,
          shipmentId,
          "shipment_success_persist_failed",
          shipmentResult.data,
          error,
        );

        return {
          ...shipmentResult,
          shipmentId,
          reconciliationRequired: true,
          message: `${shipmentResult.message} Local shipment reconciliation is required.`,
        };
      }
    }

    // 4. Provider returned a non-success response
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
  } catch (error: unknown) {
    // 5. Exception during provider call — mark record as failed
    const errorMsg = error instanceof Error ? error.message : String(error);

    await db
      .update(deliveryShipments)
      .set({
        status: "failed",
        rawStatus: "exception",
        metadata: JSON.stringify({ error: errorMsg }),
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(deliveryShipments.id, shipmentId));

    return {
      success: false,
      message: `Failed to create shipment: ${errorMsg}`,
      shipmentId,
    };
  }
}

/**
 * Get shipment by ID
 */
export async function getShipment(db: Database, id: string) {
  const [shipment] = await db
    .select()
    .from(deliveryShipments)
    .where(eq(deliveryShipments.id, id));

  return shipment;
}

/**
 * Get latest shipment for an order
 */
export async function getLatestShipment(db: Database, orderId: string) {
  const shipments = await db
    .select()
    .from(deliveryShipments)
    .where(eq(deliveryShipments.orderId, orderId))
    .orderBy(desc(deliveryShipments.createdAt))
    .limit(1);

  return shipments[0];
}

/**
 * Get all shipments for an order
 */
export async function getShipments(db: Database, orderId: string) {
  return db
    .select()
    .from(deliveryShipments)
    .where(eq(deliveryShipments.orderId, orderId))
    .orderBy(desc(deliveryShipments.createdAt));
}

/**
 * Check and update shipment status
 */
export async function checkShipmentStatus(db: Database, shipmentId: string, encryptionKey?: string) {
  // Get shipment
  const [shipment] = await db
    .select()
    .from(deliveryShipments)
    .where(eq(deliveryShipments.id, shipmentId));

  if (!shipment) {
    throw new NotFoundError(`Shipment with ID ${shipmentId} not found`);
  }
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

  if (!shipment.externalId) {
    throw new ValidationError(`Shipment ${shipmentId} has no external ID (not yet submitted to provider)`);
  }

  try {
    // Create provider instance
    const providerInstance = await createProvider(provider, encryptionKey, db);

    // Check status
    const statusResult = await providerInstance.checkShipmentStatus(
      shipment.externalId,
    );

    // Update shipment in database
    await db
      .update(deliveryShipments)
      .set({
        status: statusResult.status,
        rawStatus: statusResult.rawStatus,
        updatedAt: sql`unixepoch()`,
        metadata: JSON.stringify(statusResult.metadata || {}),
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

  await db.delete(deliveryShipments).where(eq(deliveryShipments.id, id));

  return true;
}
