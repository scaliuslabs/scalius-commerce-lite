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
import { getExternalLocationIds, isPositiveIntegerExternalLocationId } from "../locations";
import { formatPhoneForProvider } from "@scalius/shared/customer-utils";

// ponytail: Bound store-list setup calls; prefer provider-side lookup before raising this ceiling.
const MAX_PATHAO_STORE_PAGES = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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
      const token = await this.getAccessToken();

      if (this.config.storeId) {
        let expectedLastPage: number | null = null;
        for (let page = 1; page <= MAX_PATHAO_STORE_PAGES; page += 1) {
          const storesUrl = new URL(
            `${this.credentials.baseUrl.replace(/\/$/, "")}/aladdin/api/v1/stores`,
          );
          if (page > 1) storesUrl.searchParams.set("page", String(page));
          const response = await fetch(
            storesUrl.toString(),
            {
              method: "GET",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
            },
          );

          if (!response.ok) {
            return { success: false, message: "Connection failed" };
          }

          const data: unknown = await response.json();
          if (!isRecord(data) || !isRecord(data.data)) {
            return { success: false, message: "Connection failed" };
          }
          const pageData = data.data;
          const currentPage = pageData.current_page;
          const lastPage = pageData.last_page;
          const stores = pageData.data;
          if (
            typeof currentPage !== "number"
            || !Number.isInteger(currentPage)
            || currentPage !== page
            || typeof lastPage !== "number"
            || !Number.isInteger(lastPage)
            || lastPage < page
            || !Array.isArray(stores)
            || !stores.every(isRecord)
          ) {
            return { success: false, message: "Connection failed" };
          }
          if (expectedLastPage === null) {
            expectedLastPage = lastPage;
          } else if (lastPage !== expectedLastPage) {
            return { success: false, message: "Connection failed" };
          }

          const configuredStore = stores.find((store) => {
            const storeId = store.store_id;
            return (typeof storeId === "string" || typeof storeId === "number")
              && String(storeId) === this.config.storeId;
          });
          if (configuredStore) {
            if (configuredStore.is_active === 1) {
              return { success: true, message: "Connection successful" };
            }
            if (configuredStore.is_active === 0) {
              return {
                success: false,
                message: "Selected Pathao store is inactive. Choose an active store and test again.",
              };
            }
            return { success: false, message: "Connection failed" };
          }
          if (page === lastPage) {
            return { success: false, message: "Connection failed" };
          }
        }
        return { success: false, message: "Connection failed" };
      }

      return { success: true, message: "Connection successful" };
    } catch {
      return { success: false, message: "Connection failed" };
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

      if (
        !isPositiveIntegerExternalLocationId(externalLocationIds.city) ||
        !isPositiveIntegerExternalLocationId(externalLocationIds.zone)
      ) {
        return {
          success: false,
          message: `Pathao requires precisely mapped numeric location IDs. Missing mapping for: ${[!isPositiveIntegerExternalLocationId(externalLocationIds.city) && "city", !isPositiveIntegerExternalLocationId(externalLocationIds.zone) && "zone"].filter(Boolean).join(", ")}. Please configure these in the Delivery Locations settings.`,
        };
      }

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
      const body = JSON.stringify(payload);
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      let response: Response;
      let responseData: PathaoOrderResponse;
      try {
        response = await fetch(`${this.credentials.baseUrl}/aladdin/api/v1/orders`, {
          method: "POST",
          headers,
          body,
        });
        responseData = await response.json();
      } catch {
        return {
          success: false,
          reconciliationRequired: true,
          message: "Pathao shipment outcome is unknown. Check the courier account for confirmation before another shipment is created.",
        };
      }

      if (
        response.ok && responseData?.code === 200 &&
        typeof responseData.data?.consignment_id === "string" && responseData.data.consignment_id.trim() &&
        typeof responseData.data.order_status === "string"
      ) {
        return {
          success: true,
          message: "Pathao shipment created.",
          data: {
            externalId: responseData.data.consignment_id,
            trackingId: responseData.data.consignment_id,
            status: mapProviderStatus(this.getType(), responseData.data.order_status),
            metadata: responseData.data,
          },
        };
      }
      // Only explicit rejection proves that creating a corrected shipment is safe.
      if ([400, 401, 403, 404, 422].includes(responseData?.code) &&
        (response.ok || response.status === responseData.code)) {
        return {
          success: false,
          message: `Pathao rejected the shipment (HTTP ${response.status}). Check the shipment details and provider settings before retrying.`,
        };
      }
      return {
        success: false,
        reconciliationRequired: true,
        message: "Pathao shipment outcome is unknown. Check the courier account for confirmation before another shipment is created.",
      };
    } catch {
      return {
        success: false,
        message: "Pathao shipment could not be prepared. Check the provider settings and delivery location mappings before retrying.",
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
