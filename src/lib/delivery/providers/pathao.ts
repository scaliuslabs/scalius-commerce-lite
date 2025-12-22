import type { DeliveryProviderType, Order } from "@/db/schema";
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
import { getExternalLocationIds } from "../locations";

/**
 * Implementation of the Pathao delivery provider
 */
export class PathaoProvider implements DeliveryProviderInterface {
  private credentials: PathaoCredentials;
  private config: PathaoConfig;
  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;

  constructor(credentials: PathaoCredentials, config: PathaoConfig) {
    this.credentials = credentials;
    this.config = config;
  }

  getName(): string {
    return "Pathao";
  }

  getType(): DeliveryProviderType {
    return "pathao";
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
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `Failed to get access token: ${
            errorData.message || response.statusText
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
    } catch (error) {
      throw new Error(
        `Failed to obtain Pathao access token: ${
          error instanceof Error ? error.message : String(error)
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

        const data = await response.json();
        const stores = data.data?.data || [];
        const storeExists = stores.some(
          (store: any) => store.store_id?.toString() === this.config.storeId,
        );

        if (!storeExists) {
          return {
            success: false,
            message: `Store ID ${this.config.storeId} not found in your account.`,
          };
        }
      }

      return { success: true, message: "Connection successful" };
    } catch (error) {
      return {
        success: false,
        message: `Connection failed: ${
          error instanceof Error ? error.message : String(error)
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
          : order.totalAmount +
            order.shippingCharge -
            (order.discountAmount || 0);

      if (!order.city || !order.zone) {
        return {
          success: false,
          message: `Missing required location information: ${!order.city ? "city" : ""} ${!order.zone ? "zone" : ""}`,
        };
      }

      const externalLocationIds = await getExternalLocationIds(
        {
          city: order.city,
          zone: order.zone,
          area: order.area,
        },
        "pathao",
      );

      if (!externalLocationIds.city || !externalLocationIds.zone) {
        return {
          success: false,
          message: `Missing external location IDs: ${!externalLocationIds.city ? "city" : ""} ${!externalLocationIds.zone ? "zone" : ""}`,
        };
      }

      try {
        const payload = {
          store_id: parseInt(this.config.storeId),
          merchant_order_id: order.id,
          recipient_name: order.customerName,
          recipient_phone: order.customerPhone,
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
          return {
            success: false,
            message: `API Error: ${responseData.message || "Unknown error"}`,
          };
        }
      } catch (parseError) {
        return {
          success: false,
          message: `Error preparing shipment request: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        };
      }
    } catch (error) {
      return {
        success: false,
        message: `Failed to create shipment: ${
          error instanceof Error ? error.message : String(error)
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

      const responseData: PathaoStatusResponse = await response.json();

      if (!response.ok || responseData.code !== 200) {
        throw new Error(
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
