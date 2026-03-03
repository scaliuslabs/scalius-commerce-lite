import type { DeliveryProviderType, Order } from "@/db/schema";
import type { ShipmentResult, ShipmentStatus, ShipmentOptions } from "./types";

/**
 * Interface that all delivery providers must implement
 */
export interface DeliveryProviderInterface {
  /**
   * Get the display name of the provider
   */
  getName(): string;

  /**
   * Get the provider type identifier (pathao, steadfast, etc.)
   */
  getType(): DeliveryProviderType;

  /**
   * Test the provider credentials and connection
   */
  testConnection(): Promise<{ success: boolean; message: string }>;

  /**
   * Create a shipment for an order
   * @param order Order to create shipment for
   * @param options Additional options for the shipment
   */
  createShipment(
    order: Order,
    options?: ShipmentOptions,
  ): Promise<ShipmentResult>;

  /**
   * Check the status of a shipment by its external ID
   * @param externalId External ID (typically the consignment ID from the provider)
   */
  checkShipmentStatus(externalId: string): Promise<ShipmentStatus>;
}
