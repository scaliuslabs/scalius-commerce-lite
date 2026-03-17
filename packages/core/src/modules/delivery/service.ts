import { db } from "@scalius/database/client";
import { deliveryProviders, deliveryShipments, orders, orderItems, products } from "@scalius/database/schema";
import { createProvider } from "./factory";
import { encryptCredentials } from "@scalius/core/utils/credential-encryption";

import type { ShipmentOptions, ShipmentResult } from "./types";
import { eq, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { NotFoundError, ValidationError, ServiceUnavailableError } from "@scalius/core/errors";

/**
 * Service for managing delivery providers and shipments
 */
export class DeliveryService {
  /**
   * Get all providers from the database
   */
  async getProviders() {
    return db
      .select()
      .from(deliveryProviders)
      .orderBy(desc(deliveryProviders.updatedAt));
  }

  /**
   * Get active providers from the database
   */
  async getActiveProviders() {
    return db
      .select()
      .from(deliveryProviders)
      .where(eq(deliveryProviders.isActive, true))
      .orderBy(desc(deliveryProviders.updatedAt));
  }

  /**
   * Get provider by ID
   */
  async getProvider(id: string) {
    const [provider] = await db
      .select()
      .from(deliveryProviders)
      .where(eq(deliveryProviders.id, id));

    return provider;
  }

  /**
   * Save provider to database (create or update)
   */
  async saveProvider(
    provider: {
      id: string;
      name: string;
      type: string;
      isActive: boolean;
      credentials: Record<string, unknown> | string;
      config: Record<string, unknown> | string;
    },
    encryptionKey?: string,
  ) {
    const providerId = provider.id || nanoid();
    const now = new Date();

    // Convert objects to JSON strings
    let credentials =
      typeof provider.credentials === "string"
        ? provider.credentials
        : JSON.stringify(provider.credentials);

    const config =
      typeof provider.config === "string"
        ? provider.config
        : JSON.stringify(provider.config);

    // Encrypt credentials if an encryption key is available
    if (encryptionKey) {
      credentials = await encryptCredentials(credentials, encryptionKey);
    }

    // Check if provider exists
    const existingProvider = await this.getProvider(providerId);

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
          updatedAt: now,
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
        createdAt: now,
        updatedAt: now,
      });
    }

    return { ...provider, id: providerId };
  }

  /**
   * Delete provider from database
   */
  async deleteProvider(id: string) {
    await db.delete(deliveryProviders).where(eq(deliveryProviders.id, id));

    return true;
  }

  /**
   * Test provider connection
   */
  async testProvider(id: string) {
    const provider = await this.getProvider(id);
    if (!provider) {
      throw new NotFoundError(`Provider with ID ${id} not found`);
    }

    try {
      const providerInstance = await createProvider(provider);
      return await providerInstance.testConnection();
    } catch (error) {
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
  async createShipment(
    orderId: string,
    providerId: string,
    options?: ShipmentOptions,
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
    const provider = await this.getProvider(providerId);
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
    const shipmentId = nanoid();
    const now = new Date();

    await db.insert(deliveryShipments).values({
      id: shipmentId,
      orderId,
      providerId,
      providerType: provider.type,
      status: "creating",
      rawStatus: "creating",
      metadata: JSON.stringify({ initiatedAt: now.toISOString() }),
      createdAt: now,
      updatedAt: now,
    });

    try {
      // 2. Call provider API
      const providerInstance = await createProvider(provider);
      const shipmentResult = await providerInstance.createShipment(
        order,
        enrichedOptions,
      );

      if (shipmentResult.success && shipmentResult.data) {
        // 3. On success: update the record with external tracking info
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
            updatedAt: new Date(),
          })
          .where(eq(deliveryShipments.id, shipmentId));

        return shipmentResult;
      }

      // 4. Provider returned a non-success response
      await db
        .update(deliveryShipments)
        .set({
          status: "failed",
          rawStatus: "provider_rejected",
          metadata: JSON.stringify({ error: shipmentResult.message }),
          updatedAt: new Date(),
        })
        .where(eq(deliveryShipments.id, shipmentId));

      return shipmentResult;
    } catch (error) {
      // 5. Exception during provider call — mark record as failed
      const errorMsg = error instanceof Error ? error.message : String(error);

      await db
        .update(deliveryShipments)
        .set({
          status: "failed",
          rawStatus: "exception",
          metadata: JSON.stringify({ error: errorMsg }),
          updatedAt: new Date(),
        })
        .where(eq(deliveryShipments.id, shipmentId));

      return {
        success: false,
        message: `Failed to create shipment: ${errorMsg}`,
      };
    }
  }

  /**
   * Get shipment by ID
   */
  async getShipment(id: string) {
    const [shipment] = await db
      .select()
      .from(deliveryShipments)
      .where(eq(deliveryShipments.id, id));

    return shipment;
  }

  /**
   * Get latest shipment for an order
   */
  async getLatestShipment(orderId: string) {
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
  async getShipments(orderId: string) {
    return db
      .select()
      .from(deliveryShipments)
      .where(eq(deliveryShipments.orderId, orderId))
      .orderBy(desc(deliveryShipments.createdAt));
  }

  /**
   * Check and update shipment status
   */
  async checkShipmentStatus(shipmentId: string) {
    // Get shipment
    const [shipment] = await db
      .select()
      .from(deliveryShipments)
      .where(eq(deliveryShipments.id, shipmentId));

    if (!shipment) {
      throw new NotFoundError(`Shipment with ID ${shipmentId} not found`);
    }

    // Get provider
    if (!shipment.providerId) {
      throw new ValidationError(`Shipment ${shipmentId} has no provider (manual shipment)`);
    }
    const provider = await this.getProvider(shipment.providerId);
    if (!provider) {
      throw new NotFoundError(`Provider with ID ${shipment.providerId} not found`);
    }

    try {
      // Create provider instance
      const providerInstance = await createProvider(provider);

      // Check status
      const statusResult = await providerInstance.checkShipmentStatus(
        shipment.externalId as string,
      );

      // Update shipment in database
      await db
        .update(deliveryShipments)
        .set({
          status: statusResult.status,
          rawStatus: statusResult.rawStatus,
          updatedAt: new Date(),
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
    } catch (error) {
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
  async deleteShipment(id: string) {
    await db.delete(deliveryShipments).where(eq(deliveryShipments.id, id));

    return true;
  }
}
