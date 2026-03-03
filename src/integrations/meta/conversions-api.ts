// src/lib/meta/conversions-api.ts

import { createId } from "@paralleldrive/cuid2";
import { sha256, hashEmail, hashPhone } from "./crypto-utils";
import { MetaService } from "@/modules/analytics/meta.service";
import { type Database } from "@/db";

// --- CONFIGURABLE LOG RETENTION ---
// Change this value to adjust retention period (in hours)
const LOG_RETENTION_HOURS = 12;
// Check cleanup only once per this period (in hours)
const CLEANUP_CHECK_INTERVAL_HOURS = 11;

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

/**
 * Hashes user data fields as required by Meta.
 * @param userData The raw user data from the client.
 * @returns The user data with required fields hashed.
 */
async function prepareUserData(
  userData: Record<string, any>,
): Promise<UserData> {
  const prepared: UserData = {};

  // Copy non-hashed fields directly
  if (userData.client_ip_address)
    prepared.client_ip_address = userData.client_ip_address;
  if (userData.client_user_agent)
    prepared.client_user_agent = userData.client_user_agent;
  if (userData.fbc) prepared.fbc = userData.fbc;
  if (userData.fbp) prepared.fbp = userData.fbp;
  if (userData.subscription_id)
    prepared.subscription_id = userData.subscription_id;
  if (userData.lead_id) prepared.lead_id = userData.lead_id;
  if (userData.external_id)
    prepared.external_id = Array.isArray(userData.external_id)
      ? userData.external_id
      : [userData.external_id];

  // Hash PII fields according to Meta's formatting rules
  if (userData.em) prepared.em = [await hashEmail(userData.em)];
  if (userData.ph) prepared.ph = [await hashPhone(userData.ph)];

  // Name fields
  if (userData.fn) prepared.fn = await sha256(userData.fn.trim().toLowerCase());
  if (userData.ln) prepared.ln = await sha256(userData.ln.trim().toLowerCase());

  // Gender
  if (userData.ge && ["f", "m"].includes(userData.ge.toLowerCase()))
    prepared.ge = await sha256(userData.ge.toLowerCase());

  // Date of Birth - normalize to YYYYMMDD
  if (userData.db) prepared.db = await sha256(userData.db.replace(/\D/g, ""));

  // Location data
  if (userData.ct)
    prepared.ct = await sha256(
      userData.ct.toLowerCase().replace(/[^a-z]/g, ""),
    );
  if (userData.st)
    prepared.st = await sha256(
      userData.st.toLowerCase().replace(/[^a-z]/g, ""),
    );
  if (userData.zp)
    prepared.zp = await sha256(
      userData.zp.toLowerCase().replace(/[^a-z0-9]/g, ""),
    );
  if (userData.country)
    prepared.country = await sha256(userData.country.trim().toLowerCase());

  return prepared;
}

export async function sendCapiEvent(
  db: Database,
  event: Omit<ServerEvent, "user_data"> & { user_data: Record<string, any> },
) {
  const settings = await MetaService.getCapiSettings(db);
  if (!settings || !settings.isEnabled || !settings.pixelId || !settings.accessToken) {
    // FIX: Write a diagnostic log so admin can see skipped events
    let errorMessage = "CAPI integration is disabled in settings.";
    if (!settings) {
      errorMessage = "CAPI settings not found in database (id='singleton').";
    } else if (!settings.pixelId || !settings.accessToken) {
      errorMessage = "Missing Pixel ID or Access Token in CAPI settings.";
    }

    await MetaService.logCapiEvent(db, {
      eventId: event.event_id,
      eventName: event.event_name,
      status: "failed",
      requestPayload: JSON.stringify({ data: [{ ...event, user_data: {} }] }, null, 2),
      errorMessage: errorMessage,
      eventTime: event.event_time,
    }, LOG_RETENTION_HOURS);

    console.log("Meta CAPI is disabled or not configured. Skipping event.", { reason: errorMessage });
    return { success: false, error: "CAPI not configured" };
  }

  const { pixelId, accessToken, testEventCode } = settings;
  const version = "v19.0";
  const url = `https://graph.facebook.com/${version}/${pixelId}/events?access_token=${accessToken}`;

  const preparedUserData = await prepareUserData(event.user_data);
  const finalEvent: ServerEvent = { ...event, user_data: preparedUserData };
  const payload: CapiPayload = { data: [finalEvent] };
  if (testEventCode) payload.test_event_code = testEventCode;

  const logPayload = {
    eventId: event.event_id,
    eventName: event.event_name,
    requestPayload: JSON.stringify(payload, null, 2),
    eventTime: event.event_time,
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const responseData = await response.json();
    if (!response.ok) {
      const errorMessage =
        responseData.error?.message || `HTTP Error: ${response.status}`;
      throw new Error(errorMessage);
    }
    await MetaService.logCapiEvent(db, {
      ...logPayload,
      status: "success",
      responsePayload: JSON.stringify(responseData, null, 2),
    }, LOG_RETENTION_HOURS);
    console.log(`Successfully sent '${event.event_name}' event to Meta CAPI.`);
    return { success: true, response: responseData };
  } catch (error: any) {
    console.error(
      `Failed to send '${event.event_name}' event to Meta CAPI:`,
      error,
    );
    await MetaService.logCapiEvent(db, {
      ...logPayload,
      status: "failed",
      errorMessage: error.message,
      responsePayload: error.response
        ? JSON.stringify(await error.response.json())
        : "",
    }, LOG_RETENTION_HOURS);
    return { success: false, error: error.message };
  }
}

/**
 * Gets the configured log retention period in hours.
 * This is used by the UI to display retention information.
 */
export function getLogRetentionHours(): number {
  return LOG_RETENTION_HOURS;
}

/**
 * Gets the cleanup check interval in hours.
 * This is used by the UI to display cleanup frequency information.
 */
export function getCleanupCheckIntervalHours(): number {
  return CLEANUP_CHECK_INTERVAL_HOURS;
}