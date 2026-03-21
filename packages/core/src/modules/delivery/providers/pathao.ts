import type { DeliveryProviderType, Order } from "@scalius/database/schema";
import { ServiceUnavailableError } from "@scalius/core/errors";
import type {
  PathaoCredentials,
  PathaoConfig,
  ShipmentResult,
  ShipmentStatus,
  ShipmentOptions,
  PathaoTokenResponse,
  PathaoOrderResponse,
  PathaoStatusResponse,
} from "../types";
import type { DeliveryProviderInterface } from "../provider";
import { mapProviderStatus } from "../status-mapper";
import type { Database } from "@scalius/database/client";
import { getExternalLocationIds } from "../locations";
import { formatPhoneForProvider } from "@scalius/shared/customer-utils";

/**
 * Implementation of the Pathao delivery provider
 */
export class PathaoProvider implements DeliveryProviderInterface {
  private credentials: PathaoCredentials;
  private config: PathaoConfig;
  private db: Database;
  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;

  constructor(credentials: PathaoCredentials, config: PathaoConfig, db: Database) {
    this.credentials = credentials;
    this.config = config;
    this.db = db;
  }

  getName(): string {
    return "Pathao";
  }

  getType(): DeliveryProviderType {
    return "pathao";
  }

  // -- ProviderLifecycle --------------------------------------------------

  async initialize(_settings: unknown): Promise<void> {
    /* no-op — Pathao authenticates lazily via getAccessToken() */
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    const result = await this.testConnection();
    return { healthy: result.success, message: result.message };
  }

  async dispose(): Promise<void> {
    /* no-op */
  }

  /**
   * Get a valid access token, refreshing if necessary
   */
  private async getAccessToken(): Promise<string> {
    const now = new Date();
    if (this.accessToken && this.tokenExpiry && this.tokenExpiry > now) {
      return this.accessToken;
    }

    try {
      const response = await fetch(
        `${this.credentials.baseUrl}/aladdin/api/v1/issue-token`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: this.credentials.clientId,
            client_secret: this.credentials.clientSecret,
            grant_type: "password",
            username: this.credentials.username,
            password: this.credentials.password,
          }),
        },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as Record<string, unknown>;
        throw new ServiceUnavailableError(
          `Failed to get access token: ${errorData.message || response.statusText
          }`,
        );
      }

      const data: PathaoTokenResponse = await response.json();

      this.accessToken = data.access_token;
      // Subtract 1 hour from expiry to be safe
      this.tokenExpiry = new Date(
        now.getTime() + (data.expires_in - 3600) * 1000,
      );

      return this.accessToken;
    } catch (error: unknown) {
      throw new ServiceUnavailableError(
        `Failed to obtain Pathao access token: ${error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Test the provider credentials and connection
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      await this.getAccessToken();

      if (this.config.storeId) {
        const token = await this.getAccessToken();
        const response = await fetch(
          `${this.credentials.baseUrl}/aladdin/api/v1/stores`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
          },
        );

        if (!response.ok) {
          return {
            success: false,
            message: `Failed to validate store ID: ${response.statusText}`,
          };
        }

        const data = await response.json() as Record<string, unknown>;
        const dataInner = data.data as Record<string, unknown> | undefined;
        const stores = (dataInner?.data || []) as Record<string, unknown>[];
        const storeExists = stores.some(
          (store: Record<string, unknown>) => (store as { store_id?: { toString(): string } }).store_id?.toString() === this.config.storeId,
        );

        if (!storeExists) {
          return {
            success: false,
            message: `Store ID ${this.config.storeId} not found in your account.`,
          };
        }
      }

      return { success: true, message: "Connection successful" };
    } catch (error: unknown) {
      return {
        success: false,
        message: `Connection failed: ${error instanceof Error ? error.message : String(error)
          }`,
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
      const token = await this.getAccessToken();

      const itemCount = options?.itemCount || 1;

      const amountToCollect =
        options?.codAmount !== undefined
          ? options.codAmount
          : (order.balanceDue ?? (order.totalAmount - (order.paidAmount || 0)));

      if (!order.city || !order.zone) {
        return {
          success: false,
          message: `Missing required location information: ${[!order.city && "city", !order.zone && "zone"].filter(Boolean).join(", ")}`,
        };
      }

      const externalLocationIds = await getExternalLocationIds(
        this.db,
        {
          city: order.city,
          zone: order.zone,
          area: order.area,
        },
        "pathao",
      );

      if (!externalLocationIds.city || !externalLocationIds.zone) {
        console.error(`[PathaoProvider] Missing external location mappings. City: ${order.city} -> ${externalLocationIds.city}, Zone: ${order.zone} -> ${externalLocationIds.zone}, Area: ${order.area} -> ${externalLocationIds.area}`);
        return {
          success: false,
          message: `Pathao requires precisely mapped numeric location IDs. Missing mapping for: ${[!externalLocationIds.city && "city", !externalLocationIds.zone && "zone"].filter(Boolean).join(", ")}. Please configure these in the Delivery Locations settings.`,
        };
      }

      try {
        const payload = {
          store_id: parseInt(this.config.storeId),
          merchant_order_id: order.id,
          recipient_name: order.customerName,
          recipient_phone: formatPhoneForProvider(order.customerPhone),
          recipient_address: order.shippingAddress,
          recipient_city: externalLocationIds.city,
          recipient_zone: externalLocationIds.zone,
          recipient_area: externalLocationIds.area,
          delivery_type:
            options?.deliveryType || this.config.defaultDeliveryType,
          item_type: options?.itemType || this.config.defaultItemType,
          special_instruction: options?.note || order.notes || undefined,
          item_quantity: itemCount,
          item_weight: options?.itemWeight || this.config.defaultItemWeight,
          item_description: options?.itemDescription || undefined,
          amount_to_collect: amountToCollect,
        };

        const response = await fetch(
          `${this.credentials.baseUrl}/aladdin/api/v1/orders`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(payload),
          },
        );

        const responseData: PathaoOrderResponse = await response.json();

        if (response.ok && responseData.code === 200) {
          const mappedStatus = mapProviderStatus(
            this.getType(),
            responseData.data.order_status,
          );
          return {
            success: true,
            message: responseData.message,
            data: {
              externalId: responseData.data.consignment_id,
              trackingId: responseData.data.consignment_id,
              status: mappedStatus,
              metadata: responseData.data,
            },
          };
        } else {
          // Include field-level validation errors from Pathao when available
          let errorDetail = responseData.message || "Unknown error";
          if (responseData.errors && typeof responseData.errors === "object") {
            const fieldErrors = Object.entries(responseData.errors)
              .map(([field, msgs]) => `${field}: ${Array.isArray(msgs) ? msgs.join(", ") : msgs}`)
              .join("; ");
            if (fieldErrors) {
              errorDetail = `${errorDetail} — ${fieldErrors}`;
            }
          }
          return {
            success: false,
            message: `Pathao: ${errorDetail}`,
          };
        }
      } catch (parseError: unknown) {
        return {
          success: false,
          message: `Error preparing shipment request: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
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
   * Check the status of a shipment by external ID
   */
  async checkShipmentStatus(externalId: string): Promise<ShipmentStatus> {
    try {
      const token = await this.getAccessToken();

      const response = await fetch(
        `${this.credentials.baseUrl}/aladdin/api/v1/orders/${externalId}/info`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      let responseData: PathaoStatusResponse;
      const responseText = await response.text();
      try {
        responseData = JSON.parse(responseText);
      } catch {
        // Handle HTML error pages from Pathao
        let errorMessage = `Pathao API returned non-JSON (status ${response.status})`;
        if (responseText.includes("<html") || responseText.includes("<!DOCTYPE")) {
          const titleMatch = responseText.match(/<title>(.*?)<\/title>/);
          if (titleMatch?.[1]) errorMessage = `Pathao server error: ${titleMatch[1]}`;
        }
        throw new ServiceUnavailableError(errorMessage);
      }

      if (!response.ok || responseData.code !== 200) {
        throw new ServiceUnavailableError(
          `Failed to check status: ${responseData.message || response.statusText}`,
        );
      }

      const mappedStatus = mapProviderStatus(
        this.getType(),
        responseData.data.order_status,
      );

      return {
        status: mappedStatus,
        rawStatus: responseData.data.order_status,
        updatedAt: new Date(),
        metadata: responseData.data,
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
