// src/lib/meta/conversions-api.ts

import { sha256, hashEmail, hashPhone } from "./crypto-utils";
import { getCapiSettings, logCapiEvent } from "../../modules/analytics/meta.service";
import { type Database } from "@scalius/database/client";

// Fallback retention used when settings row doesn't exist yet
const DEFAULT_LOG_RETENTION_DAYS = 30;

export const META_GRAPH_API_VERSION = "v25.0";

// --- META API TYPES ---
interface UserData {
  em?: string[];
  ph?: string[];
  fn?: string;
  ln?: string;
  ge?: string;
  db?: string;
  ct?: string;
  st?: string;
  zp?: string;
  country?: string;
  external_id?: string[];
  client_ip_address?: string;
  client_user_agent?: string;
  fbc?: string;
  fbp?: string;
  subscription_id?: string;
  fb_login_id?: number;
  lead_id?: number;
}
interface Content {
  id: string;
  quantity: number;
  item_price?: number;
  delivery_category?: "in_store" | "curbside" | "home_delivery";
}
interface CustomData {
  value?: number;
  currency?: string;
  content_name?: string;
  content_category?: string;
  content_ids?: string[];
  contents?: Content[];
  content_type?: "product" | "product_group";
  order_id?: string;
  predicted_ltv?: number;
  num_items?: number;
  search_string?: string;
  status?: string;
}
interface ServerEvent {
  event_name: string;
  event_time: number;
  event_source_url: string;
  opt_out?: boolean;
  event_id: string;
  action_source: // Keep original type union
  | "website"
  | "app"
  | "offline"
  | "chat"
  | "physical_store"
  | "system_generated"
  | "business_messaging"
  | "other";
  user_data: UserData;
  custom_data?: CustomData;
  data_processing_options?: string[];
}
interface CapiPayload {
  data: ServerEvent[];
  test_event_code?: string;
}

interface SendCapiEventOptions {
  encryptionKey?: string;
}

function sanitizeEventSourceUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

function redactUserDataForLog(
  userData: object | undefined,
): Record<string, unknown> {
  if (!userData) {
    return {};
  }

  return Object.fromEntries(
    Object.keys(userData).map((key) => [key, "[redacted]"]),
  );
}

export function redactCapiPayloadForLog(payload: CapiPayload): Record<string, unknown> {
  return {
    data: payload.data.map((event) => ({
      ...event,
      event_source_url: sanitizeEventSourceUrl(event.event_source_url),
      user_data: redactUserDataForLog(event.user_data),
    })),
    ...(payload.test_event_code ? { test_event_code: "[redacted]" } : {}),
  };
}

/**
 * Hashes user data fields as required by Meta.
 * @param userData The raw user data from the client.
 * @returns The user data with required fields hashed.
 */
async function prepareUserData(
  userData: Record<string, unknown>,
): Promise<UserData> {
  const prepared: UserData = {};

  // Copy non-hashed fields directly
  if (userData.client_ip_address)
    prepared.client_ip_address = userData.client_ip_address as string;
  if (userData.client_user_agent)
    prepared.client_user_agent = userData.client_user_agent as string;
  if (userData.fbc) prepared.fbc = userData.fbc as string;
  if (userData.fbp) prepared.fbp = userData.fbp as string;
  if (userData.subscription_id)
    prepared.subscription_id = userData.subscription_id as string;
  if (userData.lead_id) prepared.lead_id = userData.lead_id as number;
  if (userData.external_id)
    prepared.external_id = Array.isArray(userData.external_id)
      ? userData.external_id as string[]
      : [userData.external_id as string];

  // Hash PII fields according to Meta's formatting rules
  if (userData.em) prepared.em = [await hashEmail(userData.em as string)];
  if (userData.ph) prepared.ph = [await hashPhone(userData.ph as string)];

  // Name fields
  if (userData.fn) prepared.fn = await sha256((userData.fn as string).trim().toLowerCase());
  if (userData.ln) prepared.ln = await sha256((userData.ln as string).trim().toLowerCase());

  // Gender
  if (userData.ge && ["f", "m"].includes((userData.ge as string).toLowerCase()))
    prepared.ge = await sha256((userData.ge as string).toLowerCase());

  // Date of Birth - normalize to YYYYMMDD
  if (userData.db) prepared.db = await sha256((userData.db as string).replace(/\D/g, ""));

  // Location data
  if (userData.ct)
    prepared.ct = await sha256(
      (userData.ct as string).toLowerCase().replace(/[^a-z]/g, ""),
    );
  if (userData.st)
    prepared.st = await sha256(
      (userData.st as string).toLowerCase().replace(/[^a-z]/g, ""),
    );
  if (userData.zp)
    prepared.zp = await sha256(
      (userData.zp as string).toLowerCase().replace(/[^a-z0-9]/g, ""),
    );
  if (userData.country)
    prepared.country = await sha256((userData.country as string).trim().toLowerCase());

  return prepared;
}

export async function sendCapiEvent(
  db: Database,
  event: Omit<ServerEvent, "user_data"> & { user_data: Record<string, unknown> },
  options: SendCapiEventOptions = {},
) {
  const settings = await getCapiSettings(db, options.encryptionKey);
  if (!settings || !settings.isEnabled || !settings.pixelId || !settings.accessToken) {
    // FIX: Write a diagnostic log so admin can see skipped events
    let errorMessage = "CAPI integration is disabled in settings.";
    if (!settings) {
      errorMessage = "CAPI settings not found in database (id='singleton').";
    } else if (!settings.pixelId || !settings.accessToken) {
      errorMessage = "Missing Pixel ID or Access Token in CAPI settings.";
    }

    const fallbackRetentionHours = (settings?.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS) * 24;
    await logCapiEvent(db, {
      eventId: event.event_id,
      eventName: event.event_name,
      status: "failed",
      requestPayload: JSON.stringify(
        redactCapiPayloadForLog({ data: [{ ...event, user_data: {} }] }),
        null,
        2,
      ),
      errorMessage: errorMessage,
      eventTime: event.event_time,
    }, fallbackRetentionHours);

    console.log("Meta CAPI is disabled or not configured. Skipping event.", { reason: errorMessage });
    return { success: false, error: "CAPI not configured" };
  }

  const retentionHours = settings.logRetentionDays * 24;
  const { pixelId, accessToken, testEventCode } = settings;
  const url = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${pixelId}/events?access_token=${accessToken}`;

  const preparedUserData = await prepareUserData(event.user_data);
  const finalEvent: ServerEvent = { ...event, user_data: preparedUserData };
  const payload: CapiPayload = { data: [finalEvent] };
  if (testEventCode) payload.test_event_code = testEventCode;

  const logPayload = {
    eventId: event.event_id,
    eventName: event.event_name,
    requestPayload: JSON.stringify(redactCapiPayloadForLog(payload), null, 2),
    eventTime: event.event_time,
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const responseData = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const errorObj = responseData.error as Record<string, unknown> | undefined;
      const errorMessage = String(errorObj?.message || `HTTP Error: ${response.status}`);
      throw new Error(errorMessage);
    }
    await logCapiEvent(db, {
      ...logPayload,
      status: "success",
      responsePayload: JSON.stringify(responseData, null, 2),
    }, retentionHours);
    console.log(`Successfully sent '${event.event_name}' event to Meta CAPI.`);
    return { success: true, response: responseData };
  } catch (error: unknown) {
    console.error(
      `Failed to send '${event.event_name}' event to Meta CAPI:`,
      error,
    );
    await logCapiEvent(db, {
      ...logPayload,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      responsePayload: (error as { response?: Response }).response
        ? JSON.stringify(await (error as { response: Response }).response.json())
        : "",
    }, retentionHours);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
