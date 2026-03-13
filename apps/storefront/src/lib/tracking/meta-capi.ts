// src/lib/tracking/meta-capi.ts

/**
 * Client-side dispatcher for Meta Conversions API
 */
import {
  sendMetaCapiEvent,
  type MetaCapiEventPayload,
} from "@/lib/api/tracking";

function getCookie(name: string): string {
  if (typeof document === "undefined") {
    return "";
  }
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) {
    return parts.pop()?.split(";").shift() || "";
  }
  return "";
}

function getFromSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch (e) {
    console.warn("Could not access sessionStorage:", e);
    return null;
  }
}

function getStandardUserData(): Partial<MetaCapiEventPayload["userData"]> {
  if (typeof window === "undefined") {
    return {};
  }

  const fbc = getCookie("_fbc") || getFromSession("scalius_fbc") || undefined;
  const fbp = getCookie("_fbp") || undefined;

  const userData: Partial<MetaCapiEventPayload["userData"]> = {
    client_user_agent: navigator.userAgent,
    fbp: fbp,
    fbc: fbc,
  };

  const userPhone = getFromSession("scalius_user_phone");
  // Meta expects phone numbers to contain only digits, with country code. We will let the backend handle strict hashing if needed, or pass it raw here.
  if (userPhone) userData.ph = userPhone.replace(/[^\d+]/g, "");

  const userEmail = getFromSession("scalius_user_email");
  if (userEmail) userData.em = userEmail.toLowerCase().trim();

  const userName = getFromSession("scalius_user_name");
  if (userName) {
    const parts = userName.trim().split(/\s+/);
    if (parts.length > 0) userData.fn = parts[0].toLowerCase();
    if (parts.length > 1) userData.ln = parts.slice(1).join(" ").toLowerCase();
  }

  const userCity = getFromSession("scalius_user_city");
  if (userCity) userData.ct = userCity.toLowerCase().trim();

  // We only send explicitly collected user data (no hardcoded fallbacks for country, let Meta infer from IP if not provided by user checkout)

  return userData;
}

/**
 * Sends a server-side event to Meta's CAPI.
 */
export function sendServerEvent(
  event: Omit<MetaCapiEventPayload, "eventSourceUrl" | "userData"> & {
    userData?: Partial<MetaCapiEventPayload["userData"]>;
  },
) {
  if (typeof window === "undefined") {
    return;
  }

  // Construct the full payload
  const fullPayload: MetaCapiEventPayload = {
    eventName: event.eventName,
    eventSourceUrl: window.location.href,
    userData: {
      ...getStandardUserData(), // Automatically include browser and session data
      ...(event.userData || {}), // Merge with any event-specific user data
    },
    customData: event.customData,
  };

  try {
    sendMetaCapiEvent(fullPayload);
  } catch (error) {
    console.error(
      `[Meta CAPI] Failed to dispatch event '${event.eventName}':`,
      error,
    );
  }
}
