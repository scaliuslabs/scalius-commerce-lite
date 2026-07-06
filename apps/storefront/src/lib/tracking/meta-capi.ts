// src/lib/tracking/meta-capi.ts

/**
 * Client-side dispatcher for Meta Conversions API
 */
import {
  sendMetaCapiEvent,
  type MetaCapiEventPayload,
} from "../api/tracking";
export { createMetaEventId } from "./meta-event-id";

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
  } catch (e: unknown) {
    console.warn("Could not access sessionStorage:", e);
    return null;
  }
}

function getBrowserUserData(): Partial<MetaCapiEventPayload["userData"]> {
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

  return userData;
}

function sanitizeEventSourceUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const sensitiveParams = new Set([
      "token",
      "tokenhash",
      "receipttoken",
      "paymentintent",
      "paymentintentclientsecret",
      "redirectstatus",
      "sessionid",
      "valid",
      "tranid",
    ]);

    for (const param of Array.from(parsed.searchParams.keys())) {
      const normalizedParam = param.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (
        !sensitiveParams.has(normalizedParam) &&
        !normalizedParam.startsWith("receipttoken")
      ) {
        continue;
      }
      parsed.searchParams.delete(param);
    }

    return parsed.toString();
  } catch {
    return url;
  }
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
  if (window.__META_CAPI_BROWSER_EVENTS_ENABLED__ !== true) {
    return;
  }

  // Construct the full payload
  const fullPayload: MetaCapiEventPayload = {
    eventId: event.eventId,
    eventName: event.eventName,
    eventSourceUrl: sanitizeEventSourceUrl(window.location.href),
    userData: {
      ...getBrowserUserData(),
      ...(event.userData || {}),
    },
    customData: event.customData,
  };

  try {
    sendMetaCapiEvent(fullPayload);
  } catch (error: unknown) {
    console.error(
      `[Meta CAPI] Failed to dispatch event '${event.eventName}':`,
      error,
    );
  }
}
