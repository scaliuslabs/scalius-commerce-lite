// Pathao: an OAuth2 password-grant token per call, numeric location IDs
// mapped on the store's delivery locations (`external_ids.pathao`) and
// whole-taka cash on delivery. Pathao has no verified lookup by the merchant
// order id (no findShipment), and its tracking pushes keep their own route
// (routes/webhooks/pathao.ts: the integration handshake answers with a header).

import type { Database } from "@scalius/database/client";
import { formatPhoneForProvider } from "@scalius/shared/customer-utils";
import { fromMinor, toMinor } from "@scalius/shared/money";
import {
  ProviderError,
  type CourierShipmentInput,
  type CourierShipmentStatus,
  type CourierTracking,
} from "@scalius/shared/plugins/providers";
import { ServiceUnavailableError } from "@scalius/core/errors";
import { getExternalLocationIds, isPositiveIntegerExternalLocationId } from "../locations";
import { mapProviderStatus } from "../status-mapper";
import type {
  PathaoConfig,
  PathaoCredentials,
  PathaoOrderResponse,
  PathaoStatusResponse,
  PathaoTokenResponse,
} from "../types";
import type { Courier } from "./port";
import { readRowCourierSetup } from "./row-setup";

export interface PathaoSettings {
  credentials: PathaoCredentials;
  config: PathaoConfig;
}

type Details = NonNullable<CourierTracking["details"]>;

// ponytail: Bound store-list setup calls; prefer provider-side lookup before raising this ceiling.
const MAX_PATHAO_STORE_PAGES = 10;

const OUTCOME_UNKNOWN = "Pathao shipment outcome is unknown. Check the courier account for confirmation before another shipment is created.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function status(rawStatus: string): CourierShipmentStatus {
  return mapProviderStatus("pathao", rawStatus) as CourierShipmentStatus;
}

/** Pathao quotes its fee in taka. */
function feeMinor(fee: unknown, decimalPlaces: number): number | null {
  if (typeof fee !== "number" || !Number.isFinite(fee) || fee < 0) return null;
  try {
    return toMinor(fee, decimalPlaces);
  } catch {
    return null;
  }
}

async function accessToken(credentials: PathaoCredentials): Promise<string> {
  try {
    const response = await fetch(`${credentials.baseUrl}/aladdin/api/v1/issue-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        grant_type: "password",
        username: credentials.username,
        password: credentials.password,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as Record<string, unknown>;
      throw new ServiceUnavailableError(`Failed to get access token: ${errorData.message || response.statusText}`);
    }
    const data: PathaoTokenResponse = await response.json();
    return data.access_token;
  } catch (error: unknown) {
    throw new ServiceUnavailableError(
      `Failed to obtain Pathao access token: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The order's Pathao city and zone (and area, when mapped), or why they are missing. */
async function pathaoLocations(
  db: Database,
  recipient: CourierShipmentInput["recipient"],
  missingMessage: (missing: string) => string,
): Promise<{ ids: Awaited<ReturnType<typeof getExternalLocationIds>> } | { refusal: string }> {
  if (!recipient.cityId || !recipient.zoneId) {
    return {
      refusal: `Missing required location information: ${[!recipient.cityId && "city", !recipient.zoneId && "zone"].filter(Boolean).join(", ")}`,
    };
  }
  const ids = await getExternalLocationIds(
    db,
    { city: recipient.cityId, zone: recipient.zoneId, area: recipient.areaId },
    "pathao",
  );
  const missing = [
    !isPositiveIntegerExternalLocationId(ids.city) && "city",
    !isPositiveIntegerExternalLocationId(ids.zone) && "zone",
  ].filter(Boolean);
  return missing.length === 0 ? { ids } : { refusal: missingMessage(missing.join(", ")) };
}

export const pathaoCourier: Courier<PathaoSettings> = {
  id: "pathao",
  label: "Pathao",
  // A Bangladesh courier: its booking API takes Bangladesh's City/Thana/Area.
  countries: ["BD"],

  setup: (provider, encryptionKey) => readRowCourierSetup(provider, encryptionKey, (credentials, config) => ({
    credentials: credentials as PathaoCredentials,
    config: config as PathaoConfig,
  })),

  // Mapped city and zone before a placeholder or a token: area stays optional.
  async preflight(recipient, db) {
    const locations = await pathaoLocations(
      db,
      recipient,
      (missing) => `Pathao requires mapped numeric location IDs before shipment creation. Missing mapping for: ${missing}. Configure Pathao IDs in Delivery Locations settings.`,
    );
    return "refusal" in locations ? locations.refusal : null;
  },

  async testConnection(_input, { settings: { credentials, config } }) {
    try {
      const token = await accessToken(credentials);
      if (!config.storeId) return { ok: true, message: "Connection successful" };

      let expectedLastPage: number | null = null;
      for (let page = 1; page <= MAX_PATHAO_STORE_PAGES; page += 1) {
        const storesUrl = new URL(`${credentials.baseUrl.replace(/\/$/, "")}/aladdin/api/v1/stores`);
        if (page > 1) storesUrl.searchParams.set("page", String(page));
        const response = await fetch(storesUrl.toString(), {
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        });
        if (!response.ok) return { ok: false, message: "Connection failed" };

        const data: unknown = await response.json();
        if (!isRecord(data) || !isRecord(data.data)) return { ok: false, message: "Connection failed" };
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
          return { ok: false, message: "Connection failed" };
        }
        if (expectedLastPage === null) {
          expectedLastPage = lastPage;
        } else if (lastPage !== expectedLastPage) {
          return { ok: false, message: "Connection failed" };
        }

        const configuredStore = stores.find((store) => {
          const storeId = store.store_id;
          return (typeof storeId === "string" || typeof storeId === "number") && String(storeId) === config.storeId;
        });
        if (configuredStore) {
          if (configuredStore.is_active === 1) return { ok: true, message: "Connection successful" };
          if (configuredStore.is_active === 0) {
            return { ok: false, message: "Selected Pathao store is inactive. Choose an active store and test again." };
          }
          return { ok: false, message: "Connection failed" };
        }
        if (page === lastPage) return { ok: false, message: "Connection failed" };
      }
      return { ok: false, message: "Connection failed" };
    } catch {
      return { ok: false, message: "Connection failed" };
    }
  },

  async createShipment(input, { settings: { credentials, config }, db }) {
    let request: { body: string; token: string };
    try {
      const amountToCollect = fromMinor(input.codAmountMinor, input.decimalPlaces);
      if (!Number.isSafeInteger(amountToCollect) || amountToCollect < 0) {
        throw new ProviderError("declined", "Pathao requires a whole-taka COD amount. Use another courier for this balance.", { code: "pathao.cod_fraction" });
      }
      const token = await accessToken(credentials);
      const locations = await pathaoLocations(
        db,
        input.recipient,
        (missing) => `Pathao requires precisely mapped numeric location IDs. Missing mapping for: ${missing}. Please configure these in the Delivery Locations settings.`,
      );
      if ("refusal" in locations) throw new ProviderError("declined", locations.refusal, { code: "pathao.locations" });
      request = {
        token,
        body: JSON.stringify({
          store_id: parseInt(config.storeId),
          merchant_order_id: input.orderId,
          recipient_name: input.recipient.name,
          recipient_phone: formatPhoneForProvider(input.recipient.phone),
          recipient_address: input.recipient.address || null,
          recipient_city: locations.ids.city,
          recipient_zone: locations.ids.zone,
          recipient_area: locations.ids.area,
          delivery_type: input.options.deliveryType || config.defaultDeliveryType,
          item_type: input.options.itemType || config.defaultItemType,
          special_instruction: input.note || undefined,
          item_quantity: input.itemCount || 1,
          item_weight: input.options.itemWeightKg || config.defaultItemWeight,
          item_description: input.itemDescription || undefined,
          amount_to_collect: amountToCollect,
        }),
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      // Nothing was sent: correcting the setup and booking again is safe.
      throw new ProviderError(
        "retryable",
        "Pathao shipment could not be prepared. Check the provider settings and delivery location mappings before retrying.",
        { code: "pathao.prepare_failed" },
      );
    }

    let response: Response;
    let responseData: PathaoOrderResponse;
    try {
      response = await fetch(`${credentials.baseUrl}/aladdin/api/v1/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${request.token}` },
        body: request.body,
      });
      responseData = await response.json();
    } catch {
      throw new ProviderError("retryable", OUTCOME_UNKNOWN, { uncertain: true, code: "pathao.outcome_unknown" });
    }

    const data = responseData?.data;
    if (
      response.ok && responseData?.code === 200 &&
      typeof data?.consignment_id === "string" && data.consignment_id.trim() &&
      typeof data.order_status === "string"
    ) {
      const extra = data as unknown as Record<string, unknown>;
      return {
        externalId: data.consignment_id,
        trackingId: data.consignment_id,
        status: status(data.order_status),
        rawStatus: data.order_status || (typeof extra.status === "string" ? extra.status : "") || "pending",
        chargeMinor: feeMinor(data.delivery_fee, input.decimalPlaces),
        label: null,
        details: extra as Details,
      };
    }
    // Only explicit rejection proves that creating a corrected shipment is safe.
    if ([400, 401, 403, 404, 422].includes(responseData?.code) && (response.ok || response.status === responseData.code)) {
      throw new ProviderError(
        "declined",
        `Pathao rejected the shipment (HTTP ${response.status}). Check the shipment details and provider settings before retrying.`,
        { code: "pathao.rejected" },
      );
    }
    throw new ProviderError("retryable", OUTCOME_UNKNOWN, { uncertain: true, code: "pathao.outcome_unknown" });
  },

  async trackShipment({ externalId }, { settings: { credentials } }) {
    try {
      const token = await accessToken(credentials);
      const response = await fetch(`${credentials.baseUrl}/aladdin/api/v1/orders/${externalId}/info`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });

      let responseData: PathaoStatusResponse;
      const responseText = await response.text();
      try {
        responseData = JSON.parse(responseText);
      } catch {
        // Pathao answers some failures with an HTML page.
        let errorMessage = `Pathao API returned non-JSON (status ${response.status})`;
        if (responseText.includes("<html") || responseText.includes("<!DOCTYPE")) {
          const titleMatch = responseText.match(/<title>(.*?)<\/title>/);
          if (titleMatch?.[1]) errorMessage = `Pathao server error: ${titleMatch[1]}`;
        }
        throw new ServiceUnavailableError(errorMessage);
      }
      if (!response.ok || responseData.code !== 200) {
        throw new ServiceUnavailableError(`Failed to check status: ${responseData.message || response.statusText}`);
      }
      return {
        status: status(responseData.data.order_status),
        rawStatus: responseData.data.order_status,
        updatedAt: new Date().toISOString(),
        details: responseData.data as unknown as Details,
      };
    } catch (error: unknown) {
      throw new ProviderError("retryable", error instanceof Error ? error.message : String(error), { code: "pathao.tracking_failed" });
    }
  },
};
