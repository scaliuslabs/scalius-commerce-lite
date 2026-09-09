import type { DeliveryProviderType, Order } from "@scalius/database/schema";
import type {
  SteadfastCredentials,
  SteadfastConfig,
  ShipmentResult,
  ShipmentStatus,
  ShipmentOptions,
  SteadfastOrderResponse,
  SteadfastStatusResponse,
  MerchantOrderShipmentLookup,
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
      const testUrl = `${baseUrl}/get_balance`;

      const response = await fetch(testUrl, {
        method: "GET",
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        return { success: false, message: "Connection failed" };
      }
      const data: unknown = await response.json();
      if (
        data !== null
        && typeof data === "object"
        && !Array.isArray(data)
        && (data as Record<string, unknown>).status === 200
      ) {
        return { success: true, message: "Connection successful" };
      }
      return { success: false, message: "Connection failed" };
    } catch {
      return { success: false, message: "Connection failed" };
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

      const headers = this.getHeaders();
      const body = JSON.stringify(payload);
      let response: Response;
      let responseData: SteadfastOrderResponse;
      try {
        response = await fetch(createOrderUrl, { method: "POST", headers, body });
        responseData = await response.json();
      } catch {
        return {
          success: false,
          reconciliationRequired: true,
          message: "Steadfast shipment outcome is unknown. Check the courier account for confirmation before another shipment is created.",
        };
      }

      if (
        response.ok && responseData?.status === 200 &&
        Number.isSafeInteger(responseData.consignment?.consignment_id) && responseData.consignment.consignment_id > 0 &&
        typeof responseData.consignment.status === "string"
      ) {
        return {
          success: true,
          message: "Steadfast shipment created.",
          data: {
            externalId: responseData.consignment.consignment_id.toString(),
            trackingId: responseData.consignment.tracking_code,
            status: mapProviderStatus(this.getType(), responseData.consignment.status),
            metadata: responseData.consignment,
          },
        };
      }
      if ([400, 401, 403, 404, 422].includes(responseData?.status) &&
        (response.ok || response.status === responseData.status)) {
        return {
          success: false,
          message: `Steadfast rejected the shipment (HTTP ${response.status}). Check the shipment details and provider settings before retrying.`,
        };
      }
      return {
        success: false,
        reconciliationRequired: true,
        message: "Steadfast shipment outcome is unknown. Check the courier account for confirmation before another shipment is created.",
      };
    } catch {
      return {
        success: false,
        message: "Steadfast shipment could not be prepared. Check the provider settings and shipment details before retrying.",
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

  async lookupShipmentByMerchantOrderId(
    merchantOrderId: string,
  ): Promise<MerchantOrderShipmentLookup> {
    try {
      const response = await fetch(
        `${this.credentials.baseUrl.replace(/\/$/, "")}/status_by_invoice/${encodeURIComponent(merchantOrderId)}`,
        { method: "GET", headers: this.getHeaders() },
      );
      if (!response.ok) {
        return {
          confirmed: false,
          message: "Steadfast did not confirm a shipment for this order. The recovery lock remains active.",
        };
      }
      const data = await response.json() as SteadfastStatusResponse;
      if (data.status !== 200 || typeof data.delivery_status !== "string" || !data.delivery_status.trim()) {
        return {
          confirmed: false,
          message: "Steadfast returned no usable shipment confirmation. The recovery lock remains active.",
        };
      }
      return {
        confirmed: true,
        status: mapProviderStatus(this.getType(), data.delivery_status),
        rawStatus: data.delivery_status,
      };
    } catch {
      return {
        confirmed: false,
        message: "Steadfast lookup could not be completed. The recovery lock remains active.",
      };
    }
  }
}
