// packages/core/src/providers/delivery/types.ts
// Delivery provider interface.
//
// ============================================================================
// HOW TO ADD A NEW DELIVERY PROVIDER
// ============================================================================
//
// 1. Create a new file: providers/delivery/my-courier.ts
//
// 2. Implement the DeliveryProvider interface:
//
//    import { z } from "zod";
//    import type { DeliveryProvider, ShipmentData, ShipmentResult, TrackingStatus } from "../delivery/types";
//    import { registerProvider } from "../registry";
//
//    const myCourierSettingsSchema = z.object({
//      apiKey: z.string().min(1),
//      baseUrl: z.string().url(),
//      sandbox: z.boolean().default(false),
//    });
//    type MyCourierSettings = z.infer<typeof myCourierSettingsSchema>;
//
//    export class MyCourierProvider implements DeliveryProvider {
//      constructor(private settings: MyCourierSettings) {}
//
//      async initialize() { /* exchange tokens, etc. */ }
//      async healthCheck() {
//        // Ping the API to check connectivity
//        return { healthy: true, message: "API reachable" };
//      }
//
//      async createShipment(data: ShipmentData): Promise<ShipmentResult> {
//        // Call your courier API to create a shipment
//        return {
//          externalId: "...",
//          trackingId: "...",
//          status: "pending",
//        };
//      }
//
//      async trackShipment(trackingId: string): Promise<TrackingStatus> {
//        return {
//          status: "in_transit",
//          rawStatus: "ON_THE_WAY",
//          updatedAt: new Date(),
//        };
//      }
//    }
//
// 3. Register the provider:
//
//    registerProvider(
//      {
//        id: "my-courier",
//        name: "My Courier Service",
//        type: "delivery",
//        version: "1.0.0",
//        settingsSchema: myCourierSettingsSchema,
//        description: "Ship packages via My Courier",
//      },
//      (settings) => new MyCourierProvider(settings),
//    );
//
// 4. Import your file from providers/delivery/index.ts to ensure registration runs.
//
// 5. Done. Available via getProvider("delivery", "my-courier", settings).
//
// ============================================================================

import type { ProviderLifecycle, HealthCheckResult } from "../types";

// ---------------------------------------------------------------------------
// Delivery-specific types
// ---------------------------------------------------------------------------

/**
 * Standardized shipment statuses shared across all delivery providers.
 */
export type ShipmentStatusCode =
  | "pending"
  | "picked_up"
  | "in_transit"
  | "delivered"
  | "failed"
  | "cancelled"
  | "returned"
  | "unknown";

/**
 * Data needed to create a shipment.
 * Provider implementations map these to their API-specific formats.
 */
export interface ShipmentData {
  /** Internal order ID */
  orderId: string;
  /** Recipient full name */
  recipientName: string;
  /** Recipient phone number */
  recipientPhone: string;
  /** Full shipping address string */
  recipientAddress: string;
  /** City name or ID */
  city?: string;
  /** Zone / district name or ID */
  zone?: string;
  /** Area / sub-district name or ID */
  area?: string | null;
  /** Cash on delivery amount (0 if prepaid) */
  codAmount?: number;
  /** Total item weight in kg */
  weight?: number;
  /** Number of items / parcels */
  itemCount?: number;
  /** Special delivery instructions */
  notes?: string;
  /** Additional provider-specific options */
  metadata?: Record<string, unknown>;
}

/**
 * Result of creating a shipment.
 */
export interface ShipmentResult {
  /** Provider-assigned consignment / shipment ID */
  externalId: string;
  /** Tracking ID (may differ from externalId for some providers) */
  trackingId?: string;
  /** Initial shipment status */
  status: ShipmentStatusCode;
  /** Provider-specific raw response data */
  metadata?: Record<string, unknown>;
}

/**
 * Current tracking status of a shipment.
 */
export interface TrackingStatus {
  /** Normalized status code */
  status: ShipmentStatusCode;
  /** Provider's raw status string */
  rawStatus: string;
  /** When the status was last updated */
  updatedAt: Date;
  /** Provider-specific tracking metadata */
  metadata?: Record<string, unknown>;
}

/**
 * A location with optional provider-specific external ID.
 */
export interface DeliveryLocation {
  /** Internal location ID */
  id: string;
  /** Location name */
  name: string;
  /** Location type */
  type: "city" | "zone" | "area";
  /** Provider-specific external ID (numeric for Pathao, string for others) */
  externalId?: string | number;
}

/**
 * Shipping rate calculation result.
 */
export interface RateResult {
  /** Shipping cost in smallest currency unit */
  amount: number;
  /** ISO 4217 currency code */
  currency: string;
  /** Estimated delivery time in hours */
  estimatedHours?: number;
  /** Human-readable delivery time (e.g. "2-3 business days") */
  estimatedDelivery?: string;
}

// ---------------------------------------------------------------------------
// DeliveryProvider interface
// ---------------------------------------------------------------------------

/**
 * Contract that every delivery / courier provider must implement.
 *
 * Required: createShipment, trackShipment.
 * Optional: cancelShipment, calculateRate, getTrackingUrl.
 */
export interface DeliveryProvider extends ProviderLifecycle {
  /**
   * Create a shipment for an order.
   * Maps internal order data to the provider's API format and creates the shipment.
   */
  createShipment(data: ShipmentData): Promise<ShipmentResult>;

  /**
   * Get the current tracking status of a shipment.
   * @param externalId - The provider-assigned consignment/shipment ID
   */
  trackShipment(externalId: string): Promise<TrackingStatus>;

  /**
   * Cancel a shipment that hasn't been picked up yet.
   * Optional -- not all providers support cancellation.
   * @returns true if successfully cancelled
   */
  cancelShipment?(externalId: string): Promise<boolean>;

  /**
   * Calculate the shipping rate for a given route and weight.
   * Optional -- not all providers expose rate APIs.
   */
  calculateRate?(data: {
    originCity: string;
    destinationCity: string;
    weight: number;
    codAmount?: number;
  }): Promise<RateResult>;

  /**
   * Get the public tracking URL for a shipment.
   * Optional -- returns null if the provider doesn't have a public tracking page.
   */
  getTrackingUrl?(trackingId: string): string | null;
}

// Re-export lifecycle types for convenience
export type { ProviderLifecycle, HealthCheckResult };
