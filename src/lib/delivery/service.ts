import { db } from "@/db";
import { deliveryProviders, deliveryShipments, orders } from "@/db/schema";
import { createProvider } from "./factory";

import type { ShipmentOptions, ShipmentResult } from "./types";
import { eq, desc } from "drizzle-orm";
import { nanoid } from "nanoid";

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
  async saveProvider(provider: {
    id: string;
    name: string;
    type: string;
    isActive: boolean;
    credentials: any;
    config: any;
  }) {
    const providerId = provider.id || nanoid();
    const now = new Date();

    // Convert objects to JSON strings
    const credentials =
      typeof provider.credentials === "string"
        ? provider.credentials
        : JSON.stringify(provider.credentials);

    const config =
      typeof provider.config === "string"
        ? provider.config
        : JSON.stringify(provider.config);

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
      throw new Error(`Provider with ID ${id} not found`);
    }

    try {
      const providerInstance = createProvider(provider);
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

    try {
      // Create provider instance
      const providerInstance = createProvider(provider);

      // Create shipment
      const shipmentResult = await providerInstance.createShipment(
        order,
        options,
      );

      // If successful, save the shipment to our database
      if (shipmentResult.success && shipmentResult.data) {
        const shipmentId = nanoid();
        const now = new Date();

        await db.insert(deliveryShipments).values({
          id: shipmentId,
          orderId,
          providerId,
          providerType: provider.type,
          externalId: shipmentResult.data.externalId,
          trackingId: shipmentResult.data.trackingId,
          status: shipmentResult.data.status || "pending",
          rawStatus:
            shipmentResult.data.metadata?.order_status ||
            shipmentResult.data.metadata?.status ||
            "pending",
          metadata: JSON.stringify(shipmentResult.data.metadata || {}),
          createdAt: now,
          updatedAt: now,
        });

        // Return the result with shipment ID
        return shipmentResult;
      }

      return shipmentResult;
    } catch (error) {
      return {
        success: false,
        message: `Failed to create shipment: ${error instanceof Error ? error.message : String(error)}`,
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
      throw new Error(`Shipment with ID ${shipmentId} not found`);
    }

    // Get provider
    const provider = await this.getProvider(shipment.providerId);
    if (!provider) {
      throw new Error(`Provider with ID ${shipment.providerId} not found`);
    }

    try {
      // Create provider instance
      const providerInstance = createProvider(provider);

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
      throw new Error(
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
