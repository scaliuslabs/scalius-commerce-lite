// src/lib/meta/conversions-api.ts

import { db } from "@/db";
import {
  metaConversionsSettings,
  metaConversionsLogs,
  type MetaConversionsSettings,
} from "@/db/schema";
import { createId } from "@paralleldrive/cuid2";
import { sha256, hashEmail, hashPhone } from "./crypto-utils";
import { eq, lt } from "drizzle-orm";

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
  action_source:
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

// --- SERVICE LOGIC ---
let settingsCache: {
  settings: MetaConversionsSettings;
  timestamp: number;
} | null = null;
const SETTINGS_CACHE_TTL = 60 * 1000;

// Cache for last cleanup check to avoid excessive DB operations
let lastCleanupCheck: number | null = null;

/**
 * Clears the cached CAPI settings.
 * This should be called after settings are updated in the admin panel.
 */
export function clearCapiSettingsCache() {
  settingsCache = null;
  console.log("Meta CAPI settings cache cleared.");
}

async function getCapiSettings(): Promise<MetaConversionsSettings | null> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.timestamp < SETTINGS_CACHE_TTL) {
    return settingsCache.settings;
  }
  try {
    const settings = await db
      .select()
      .from(metaConversionsSettings)
      .where(eq(metaConversionsSettings.id, "singleton"))
      .get();
    if (settings) { // Cache even if disabled, to avoid DB hits
      settingsCache = { settings, timestamp: now };
      return settings;
    }
    return null;
  } catch (error) {
    console.error("Error fetching Meta CAPI settings:", error);
    return null;
  }
}

/**
 * Performs automatic log cleanup based on configurable retention period.
 * This function is designed for serverless platforms and runs lazily.
 */
async function performLogCleanup(): Promise<void> {
  const now = Date.now();
  const cleanupIntervalMs = CLEANUP_CHECK_INTERVAL_HOURS * 60 * 60 * 1000;

  // Skip if cleanup was checked recently
  if (lastCleanupCheck && now - lastCleanupCheck < cleanupIntervalMs) {
    return;
  }

  try {
    // Update last cleanup check timestamp
    lastCleanupCheck = now;
    
    // Actually perform the cleanup
    const retentionMs = LOG_RETENTION_HOURS * 60 * 60 * 1000;
    const cutoffTime = new Date(now - retentionMs);

    await db
      .delete(metaConversionsLogs)
      .where(lt(metaConversionsLogs.createdAt, cutoffTime));

    console.log(
      `Meta CAPI log cleanup completed. Retention: ${LOG_RETENTION_HOURS}h.`,
    );
  } catch (error) {
    console.error("Error during Meta CAPI log cleanup:", error);
  }
}

async function logCapiEvent(logData: {
  eventId: string;
  eventName: string;
  status: "success" | "failed";
  requestPayload: string;
  responsePayload?: string;
  errorMessage?: string;
  eventTime: number;
}) {
  try {
    const { eventTime, ...restOfLogData } = logData;
    await db.insert(metaConversionsLogs).values({
      id: createId(),
      ...restOfLogData,
      eventTime: new Date(eventTime * 1000),
    });

    // Trigger lazy cleanup after logging
    await performLogCleanup();
  } catch (error) {
    console.error("Failed to write to Meta CAPI log:", error);
  }
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
  event: Omit<ServerEvent, "user_data"> & { user_data: Record<string, any> },
) {
  const settings = await getCapiSettings();
  if (!settings || !settings.isEnabled || !settings.pixelId || !settings.accessToken) {
    // FIX: Write a diagnostic log so admin can see skipped events
    let errorMessage = "CAPI integration is disabled in settings.";
    if (!settings) {
      errorMessage = "CAPI settings not found in database (id='singleton').";
    } else if (!settings.pixelId || !settings.accessToken) {
      errorMessage = "Missing Pixel ID or Access Token in CAPI settings.";
    }
    
    await logCapiEvent({
      eventId: event.event_id,
      eventName: event.event_name,
      status: "failed",
      requestPayload: JSON.stringify({ data: [{ ...event, user_data: {} }] }, null, 2),
      errorMessage: errorMessage,
      eventTime: event.event_time,
    });
    
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
    await logCapiEvent({
      ...logPayload,
      status: "success",
      responsePayload: JSON.stringify(responseData, null, 2),
    });
    console.log(`Successfully sent '${event.event_name}' event to Meta CAPI.`);
    return { success: true, response: responseData };
  } catch (error: any) {
    console.error(
      `Failed to send '${event.event_name}' event to Meta CAPI:`,
      error,
    );
    await logCapiEvent({
      ...logPayload,
      status: "failed",
      errorMessage: error.message,
      responsePayload: error.response
        ? JSON.stringify(await error.response.json())
        : "",
    });
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

/**
 * Manually trigger log cleanup (for admin use).
 * This bypasses the cleanup check interval.
 */
export async function manualLogCleanup(): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    const now = Date.now();
    const retentionMs = LOG_RETENTION_HOURS * 60 * 60 * 1000;
    const cutoffTime = new Date(now - retentionMs);

    await   db
      .delete(metaConversionsLogs)
      .where(lt(metaConversionsLogs.createdAt, cutoffTime));

    lastCleanupCheck = now;

    return {
      success: true,
      message: `Log cleanup completed. Retention period: ${LOG_RETENTION_HOURS} hours.`,
    };
  } catch (error: any) {
    console.error("Error during manual Meta CAPI log cleanup:", error);
    return {
      success: false,
      message: `Log cleanup failed: ${error.message}`,
    };
  }
}