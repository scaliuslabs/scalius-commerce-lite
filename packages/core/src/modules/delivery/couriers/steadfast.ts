// Steadfast: API key and secret key headers, a full-text address, and a
// positive lookup by the merchant order id (its invoice), which recovers a
// booking whose answer was lost. Its tracking pushes keep their own route
// (routes/webhooks/steadfast.ts: invoice-bound recovery and tracking notes).

import { formatPhoneForProvider } from "@scalius/shared/customer-utils";
import { fromMinor } from "@scalius/shared/money";
import {
  ProviderError,
  type CourierShipmentStatus,
  type CourierTracking,
} from "@scalius/shared/plugins/providers";
import { mapProviderStatus } from "../status-mapper";
import type {
  SteadfastConfig,
  SteadfastCredentials,
  SteadfastOrderResponse,
  SteadfastStatusResponse,
} from "../types";
import type { Courier } from "./port";
import { readRowCourierSetup } from "./row-setup";

export interface SteadfastSettings {
  credentials: SteadfastCredentials;
  config: SteadfastConfig;
}

type Details = NonNullable<CourierTracking["details"]>;

const OUTCOME_UNKNOWN = "Steadfast shipment outcome is unknown. Check the courier account for confirmation before another shipment is created.";

function status(rawStatus: string): CourierShipmentStatus {
  return mapProviderStatus("steadfast", rawStatus) as CourierShipmentStatus;
}

function baseUrl(credentials: SteadfastCredentials): string {
  return credentials.baseUrl.replace(/\/$/, "");
}

function headers(credentials: SteadfastCredentials): HeadersInit {
  return {
    "Api-Key": credentials.apiKey.trim(),
    "Secret-Key": credentials.secretKey.trim(),
    "Content-Type": "application/json",
  };
}

export const steadfastCourier: Courier<SteadfastSettings> = {
  id: "steadfast",
  label: "Steadfast",
  // A Bangladesh courier: its booking API takes Bangladesh's City/Thana/Area.
  countries: ["BD"],

  setup: (provider, encryptionKey) => readRowCourierSetup(provider, encryptionKey, (credentials, config) => ({
    credentials: credentials as SteadfastCredentials,
    config: config as SteadfastConfig,
  })),

  async testConnection(_input, { settings }) {
    try {
      const credentials = {
        ...settings.credentials,
        apiKey: settings.credentials.apiKey.trim(),
        secretKey: settings.credentials.secretKey.trim(),
        baseUrl: settings.credentials.baseUrl.trim(),
      };
      const response = await fetch(`${baseUrl(credentials)}/get_balance`, { method: "GET", headers: headers(credentials) });
      if (!response.ok) return { ok: false, message: "Connection failed" };
      const data: unknown = await response.json();
      if (data !== null && typeof data === "object" && !Array.isArray(data) && (data as Record<string, unknown>).status === 200) {
        return { ok: true, message: "Connection successful" };
      }
      return { ok: false, message: "Connection failed" };
    } catch {
      return { ok: false, message: "Connection failed" };
    }
  },

  async createShipment(input, { settings: { credentials } }) {
    let body: string;
    try {
      const { recipient } = input;
      body = JSON.stringify({
        invoice: input.orderId,
        recipient_name: recipient.name,
        recipient_phone: formatPhoneForProvider(recipient.phone),
        recipient_address: [recipient.address, recipient.areaName, recipient.zoneName, recipient.cityName].filter(Boolean).join(", "),
        cod_amount: fromMinor(input.codAmountMinor, input.decimalPlaces),
        note: input.note || undefined,
      });
    } catch {
      throw new ProviderError(
        "retryable",
        "Steadfast shipment could not be prepared. Check the provider settings and shipment details before retrying.",
        { code: "steadfast.prepare_failed" },
      );
    }

    let response: Response;
    let responseData: SteadfastOrderResponse;
    try {
      response = await fetch(`${baseUrl(credentials)}/create_order`, { method: "POST", headers: headers(credentials), body });
      responseData = await response.json();
    } catch {
      throw new ProviderError("retryable", OUTCOME_UNKNOWN, { uncertain: true, code: "steadfast.outcome_unknown" });
    }

    const consignment = responseData?.consignment;
    if (
      response.ok && responseData?.status === 200 &&
      Number.isSafeInteger(consignment?.consignment_id) && consignment.consignment_id > 0 &&
      typeof consignment.status === "string"
    ) {
      return {
        externalId: consignment.consignment_id.toString(),
        trackingId: consignment.tracking_code,
        status: status(consignment.status),
        rawStatus: consignment.status || "pending",
        chargeMinor: null,
        label: null,
        details: consignment as unknown as Details,
      };
    }
    // Only explicit rejection proves that creating a corrected shipment is safe.
    if ([400, 401, 403, 404, 422].includes(responseData?.status) && (response.ok || response.status === responseData.status)) {
      throw new ProviderError(
        "declined",
        `Steadfast rejected the shipment (HTTP ${response.status}). Check the shipment details and provider settings before retrying.`,
        { code: "steadfast.rejected" },
      );
    }
    throw new ProviderError("retryable", OUTCOME_UNKNOWN, { uncertain: true, code: "steadfast.outcome_unknown" });
  },

  async trackShipment({ externalId }, { settings: { credentials } }) {
    try {
      const response = await fetch(`${baseUrl(credentials)}/status_by_cid/${externalId}`, { method: "GET", headers: headers(credentials) });
      if (!response.ok) throw new Error(`API Error: ${response.statusText}`);
      let responseData: SteadfastStatusResponse;
      try {
        responseData = await response.json();
      } catch (parseError: unknown) {
        throw new Error(`Failed to parse API response: ${parseError}`);
      }
      return {
        status: status(responseData.delivery_status),
        rawStatus: responseData.delivery_status,
        updatedAt: new Date().toISOString(),
        details: responseData as unknown as Details,
      };
    } catch (error: unknown) {
      throw new ProviderError("retryable", error instanceof Error ? error.message : String(error), { code: "steadfast.tracking_failed" });
    }
  },

  // Positive-only: a failed or empty lookup never means "not booked".
  async findShipment({ orderId }, { settings: { credentials } }) {
    try {
      const response = await fetch(`${baseUrl(credentials)}/status_by_invoice/${encodeURIComponent(orderId)}`, {
        method: "GET",
        headers: headers(credentials),
      });
      if (!response.ok) {
        return { found: false, message: "Steadfast did not confirm a shipment for this order. The recovery lock remains active." };
      }
      const data = await response.json() as SteadfastStatusResponse;
      if (data.status !== 200 || typeof data.delivery_status !== "string" || !data.delivery_status.trim()) {
        return { found: false, message: "Steadfast returned no usable shipment confirmation. The recovery lock remains active." };
      }
      return {
        found: true,
        externalId: null,
        tracking: { status: status(data.delivery_status), rawStatus: data.delivery_status, updatedAt: new Date().toISOString() },
      };
    } catch {
      return { found: false, message: "Steadfast lookup could not be completed. The recovery lock remains active." };
    }
  },
};
