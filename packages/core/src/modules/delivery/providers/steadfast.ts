import type { DeliveryProviderType, Order } from "@scalius/database/schema";
import type {
  SteadfastCredentials,
  SteadfastConfig,
  ShipmentResult,
  ShipmentStatus,
  ShipmentOptions,
  SteadfastOrderResponse,
  SteadfastStatusResponse,
} from "../types";
import type { DeliveryProviderInterface } from "../provider";
import { mapProviderStatus } from "../status-mapper";
import { formatPhoneForProvider } from "@scalius/shared/customer-utils";

/**
 * Implementation of the Steadfast delivery provider
 */
export class SteadfastProvider implements DeliveryProviderInterface {
  private credentials: SteadfastCredentials;

  constructor(credentials: SteadfastCredentials, _config: SteadfastConfig) {
    this.credentials = credentials;
  }

  getName(): string {
    return "Steadfast";
  }

  getType(): DeliveryProviderType {
    return "steadfast";
  }

  // -- ProviderLifecycle --------------------------------------------------

  async initialize(_settings: unknown): Promise<void> {
    /* no-op — Steadfast uses API key auth, no initialization needed */
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    const result = await this.testConnection();
    return { healthy: result.success, message: result.message };
  }

  async dispose(): Promise<void> {
    /* no-op */
  }

  /**
   * Test the provider credentials and connection
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const trimmedApiKey = this.credentials.apiKey.trim();
      const trimmedSecretKey = this.credentials.secretKey.trim();

      this.credentials = {
        ...this.credentials,
        apiKey: trimmedApiKey,
        secretKey: trimmedSecretKey,
        baseUrl: this.credentials.baseUrl.trim(),
      };

      const baseUrl = this.credentials.baseUrl.replace(/\/$/, "");
      const testUrl = `${baseUrl}/status_by_invoice/test`;

      const response = await fetch(testUrl, {
        method: "GET",
        headers: this.getHeaders(),
      });

      if (response.status === 200 || response.status === 404) {
        return { success: true, message: "Connection successful" };
      } else {
        try {
          const data = await response.json() as Record<string, unknown>;
          return {
            success: false,
            message: `Connection failed: ${data.message || response.statusText}`,
          };
        } catch {
          return {
            success: false,
            message: `Connection failed with status: ${response.status} ${response.statusText}`,
          };
        }
      }
    } catch (error: unknown) {
      return {
        success: false,
        message: `Connection failed: ${error instanceof Error ? error.message : String(error)
          }`,
      };
    }
  }

  /**
   * Helper to get request headers
   */
  private getHeaders(): HeadersInit {
    const apiKey = this.credentials.apiKey.trim();
    const secretKey = this.credentials.secretKey.trim();

    return {
      "Api-Key": apiKey,
      "Secret-Key": secretKey,
      "Content-Type": "application/json",
    };
  }

  /**
   * Create a shipment for an order
   */
  async createShipment(
    order: Order,
    options?: ShipmentOptions,
  ): Promise<ShipmentResult> {
    try {
      const codAmount =
        options?.codAmount !== undefined
          ? options.codAmount
          : (order.balanceDue ?? (order.totalAmount - (order.paidAmount || 0)));

      // Construct the full address
      const addressParts = [
        order.shippingAddress,
        order.areaName,
        order.zoneName,
        order.cityName,
      ].filter(Boolean); // filter out null, undefined, ''
      const fullAddress = addressParts.join(", ");

      const payload = {
        invoice: order.id,
        recipient_name: order.customerName,
        recipient_phone: formatPhoneForProvider(order.customerPhone),
        recipient_address: fullAddress, // Use the full address
        cod_amount: codAmount,
        note: options?.note || order.notes || undefined,
      };

      // Ensure baseUrl does not eagerly have a trailing slash, or handle it cleanly.
      const baseUrl = this.credentials.baseUrl.replace(/\/$/, "");
      const createOrderUrl = `${baseUrl}/create_order`;

      const response = await fetch(createOrderUrl, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
      });

      let responseData: SteadfastOrderResponse;
      try {
        const responseText = await response.text();
        try {
          responseData = JSON.parse(responseText);
        } catch {
          console.error("[SteadfastAPI] Shipment returned an unreadable response", {
            status: response.status,
            contentType: response.headers.get("content-type"),
            responseLength: responseText.length,
          });
          return {
            success: false,
            message: `Steadfast returned an unreadable response (HTTP ${response.status})`,
          };
        }
      } catch {
        return {
          success: false,
          message: `Failed to parse API response: ${response.statusText}`,
        };
      }

      if (response.ok && responseData.status === 200) {
        const mappedStatus = mapProviderStatus(
          this.getType(),
          responseData.consignment.status,
        );

        return {
          success: true,
          message: responseData.message,
          data: {
            externalId: responseData.consignment.consignment_id.toString(),
            trackingId: responseData.consignment.tracking_code,
            status: mappedStatus,
            metadata: responseData.consignment,
          },
        };
      } else {
        // Provider validation bodies may echo recipient/order values. Surface
        // only field names and status; never pass raw provider payloads into
        // logs or persisted shipment diagnostics.
        const fields = responseData.errors && typeof responseData.errors === "object"
          ? Object.keys(responseData.errors).slice(0, 12)
          : [];
        return {
          success: false,
          message: `Steadfast rejected the shipment (HTTP ${response.status})${fields.length > 0 ? `; check: ${fields.join(", ")}` : ""}`,
        };
      }
    } catch (error: unknown) {
      return {
        success: false,
        message: `Failed to create shipment: ${error instanceof Error ? error.message : String(error)
          }`,
      };
    }
  }

  /**
   * Check the status of a shipment by external ID (consignment ID)
   */
  async checkShipmentStatus(externalId: string): Promise<ShipmentStatus> {
    try {
      const response = await fetch(
        `${this.credentials.baseUrl.replace(/\/$/, "")}/status_by_cid/${externalId}`,
        {
          method: "GET",
          headers: this.getHeaders(),
        },
      );

      if (!response.ok) {
        throw new Error(`API Error: ${response.statusText}`);
      }

      let responseData: SteadfastStatusResponse;
      try {
        responseData = await response.json();
      } catch (parseError: unknown) {
        throw new Error(`Failed to parse API response: ${parseError}`);
      }

      const mappedStatus = mapProviderStatus(
        this.getType(),
        responseData.delivery_status,
      );

      return {
        status: mappedStatus,
        rawStatus: responseData.delivery_status,
        updatedAt: new Date(),
        metadata: responseData as unknown as Record<string, unknown>,
      };
    } catch (error: unknown) {
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
