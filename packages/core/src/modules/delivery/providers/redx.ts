import type { DeliveryProviderType, Order } from "@scalius/database/schema";
import type {
  RedXCredentials,
  RedXConfig,
  ShipmentResult,
  ShipmentStatus,
  ShipmentOptions,
  RedXCreateParcelResponse,
  RedXParcelInfoResponse,
} from "../types";
import type { DeliveryProviderInterface } from "../provider";
import { mapProviderStatus } from "../status-mapper";

const REDX_BASE_URLS = {
  sandbox: "https://sandbox.redx.com.bd/v1.0.0-beta",
  production: "https://openapi.redx.com.bd/v1.0.0-beta",
} as const;

/**
 * Implementation of the RedX delivery provider
 */
export class RedXProvider implements DeliveryProviderInterface {
  private credentials: RedXCredentials;
  private config: RedXConfig;
  private baseUrl: string;

  constructor(credentials: RedXCredentials, config: RedXConfig) {
    this.credentials = credentials;
    this.config = config;
    this.baseUrl = config.sandbox
      ? REDX_BASE_URLS.sandbox
      : REDX_BASE_URLS.production;
  }

  getName(): string {
    return "RedX";
  }

  getType(): DeliveryProviderType {
    return "redx";
  }

  /**
   * Get request headers for RedX API calls
   */
  private getHeaders(): HeadersInit {
    return {
      "API-ACCESS-TOKEN": `Bearer ${this.credentials.apiToken.trim()}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Test the provider credentials and connection
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/pickup/stores`, {
        method: "GET",
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        return {
          success: false,
          message: `Connection failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
        };
      }

      const data = await response.json() as { pickup_stores?: unknown[] };

      if (this.config.pickupStoreId) {
        const stores = (data.pickup_stores || []) as { id?: number }[];
        const storeExists = stores.some(
          (store) => store.id === this.config.pickupStoreId,
        );
        if (!storeExists) {
          return {
            success: false,
            message: `Pickup Store ID ${this.config.pickupStoreId} not found in your account.`,
          };
        }
      }

      return { success: true, message: "Connection successful" };
    } catch (error) {
      return {
        success: false,
        message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Create a shipment for an order
   */
  async createShipment(
    order: Order,
    options?: ShipmentOptions,
  ): Promise<ShipmentResult> {
    try {
      const amountToCollect =
        options?.codAmount !== undefined
          ? options.codAmount
          : (order.balanceDue ?? (order.totalAmount - (order.paidAmount || 0)));

      // Build full address from available parts
      const addressParts = [
        order.shippingAddress,
        order.areaName,
        order.zoneName,
        order.cityName,
      ].filter(Boolean);
      const fullAddress = addressParts.join(", ");

      // RedX Create Parcel API — field types from docs + sample request:
      // delivery_area_id: integer (RedX area ID, NOT our internal ID)
      // cash_collection_amount: string
      // parcel_weight: number (in grams)
      // value: number (declared value for compensation)
      // pickup_store_id: number (optional)
      //
      // IMPORTANT: delivery_area_id must be a RedX area ID from their /areas endpoint.
      // Our internal order.area may not match. If we can't resolve it, we omit it
      // and let RedX auto-detect from the address.
      const weight = options?.itemWeight || this.config.defaultParcelWeight || 500;

      // Try to parse area as RedX area ID; if it's our internal UUID, skip it
      const areaId = order.area ? parseInt(order.area, 10) : undefined;
      const hasValidAreaId = areaId && !isNaN(areaId) && areaId > 0;

      const payload: Record<string, unknown> = {
        customer_name: order.customerName || "Customer",
        customer_phone: order.customerPhone,
        delivery_area: order.areaName || order.zoneName || order.cityName || "Dhaka",
        customer_address: fullAddress || order.shippingAddress || "N/A",
        merchant_invoice_id: String(order.id),
        cash_collection_amount: String(Math.round(amountToCollect)),
        parcel_weight: weight,
        value: Math.round(amountToCollect),
      };

      // Only include delivery_area_id if it's a valid RedX area ID (integer > 0)
      if (hasValidAreaId) {
        payload.delivery_area_id = areaId;
      }

      // Only include pickup_store_id if configured
      if (this.config.pickupStoreId) {
        payload.pickup_store_id = Number(this.config.pickupStoreId);
      }

      // Include instruction if present
      const instruction = options?.note || order.notes;
      if (instruction) {
        payload.instruction = instruction;
      }

      console.log(`[RedX] Creating parcel with payload:`, JSON.stringify(payload));

      const response = await fetch(`${this.baseUrl}/parcel`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
      });

      let responseData: RedXCreateParcelResponse;
      try {
        const responseText = await response.text();
        try {
          responseData = JSON.parse(responseText);
        } catch (jsonError) {
          let errorMessage = "Invalid JSON response";
          if (responseText.includes("<!DOCTYPE html>") || responseText.includes("<html")) {
            const titleMatch = responseText.match(/<title>(.*?)<\/title>/);
            if (titleMatch && titleMatch[1]) {
              errorMessage = `HTML Server Error: ${titleMatch[1]}`;
            }
          }
          console.error(`[RedXAPI] Shipment failed. Error:`, responseText);
          return {
            success: false,
            message: errorMessage,
          };
        }
      } catch (parseError) {
        return {
          success: false,
          message: `Failed to parse API response: ${response.statusText}`,
        };
      }

      if (response.ok && responseData.tracking_id) {
        const mappedStatus = mapProviderStatus(this.getType(), "pickup-pending");

        return {
          success: true,
          message: "Parcel created successfully",
          data: {
            externalId: responseData.tracking_id,
            trackingId: responseData.tracking_id,
            status: mappedStatus,
            metadata: responseData as unknown as Record<string, unknown>,
          },
        };
      } else {
        // Log full error response for debugging
        console.error(`[RedX] Create parcel failed. Status: ${response.status}, Response:`, JSON.stringify(responseData));
        const errorMsg = (responseData as any)?.message || (responseData as any)?.error || "Unknown error";
        const errorDetails = (responseData as any)?.errors ? JSON.stringify((responseData as any).errors) : "";
        return {
          success: false,
          message: `API Error: ${errorMsg}${errorDetails ? ` — Details: ${errorDetails}` : ""}`,
        };
      }
    } catch (error) {
      return {
        success: false,
        message: `Failed to create shipment: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Check the status of a shipment by tracking ID
   */
  async checkShipmentStatus(externalId: string): Promise<ShipmentStatus> {
    try {
      const response = await fetch(
        `${this.baseUrl}/parcel/info/${externalId}`,
        {
          method: "GET",
          headers: this.getHeaders(),
        },
      );

      if (!response.ok) {
        throw new Error(
          `Failed to check status: ${response.statusText}`,
        );
      }

      const responseData: RedXParcelInfoResponse = await response.json();

      if (!responseData.parcel) {
        throw new Error("Invalid response: missing parcel data");
      }

      const mappedStatus = mapProviderStatus(
        this.getType(),
        responseData.parcel.status,
      );

      return {
        status: mappedStatus,
        rawStatus: responseData.parcel.status,
        updatedAt: new Date(),
        metadata: responseData.parcel as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return {
        status: "unknown",
        rawStatus: "error",
        updatedAt: new Date(),
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
