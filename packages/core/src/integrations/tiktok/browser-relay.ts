// Browser funnel events relayed to the TikTok Events API (audit spec §3.10):
// the storefront posts one event to `POST /api/v1/meta/events`, which sends it
// to Meta CAPI and, when TikTok's Events API is on, here. The event id is the
// one the pixels used, so TikTok dedupes the browser and server copies.

import type { Database } from "@scalius/database/client";
import { tiktokEventsDocument, tiktokServerEnabled } from "../tracking/settings";
import { sendTikTokPayload, tiktokMatchSignals, tiktokUser, type TikTokStandardEvent } from "./events-api";

/** Meta's browser event names and TikTok's standard ones. */
const TIKTOK_EVENT_FOR_META: Record<string, TikTokStandardEvent> = {
  ViewContent: "ViewContent",
  Search: "Search",
  AddToCart: "AddToCart",
  InitiateCheckout: "InitiateCheckout",
  AddPaymentInfo: "AddPaymentInfo",
  Lead: "SubmitForm",
  CompleteRegistration: "CompleteRegistration",
};

export function tiktokEventForMetaEvent(eventName: string): TikTokStandardEvent | null {
  return TIKTOK_EVENT_FOR_META[eventName] ?? null;
}

export interface TikTokBrowserRelayInput {
  /** Meta's name; Purchase is the server outbox's alone and never relayed. */
  eventName: string;
  eventId: string;
  eventTime: number;
  eventSourceUrl: string;
  userData: {
    em?: string;
    ph?: string;
    external_id?: string | string[];
    ttp?: string;
    ttclid?: string;
    client_ip_address?: string;
    client_user_agent?: string;
  };
  customData?: Record<string, unknown>;
  limitedDataUse?: boolean;
}

export interface TikTokRelayResult {
  success: boolean;
  skipped?: boolean;
  retryable?: boolean;
  error?: string;
  matchSignals?: string[];
}

function properties(customData: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!customData) return undefined;
  const contents = Array.isArray(customData.contents)
    ? (customData.contents as Array<Record<string, unknown>>).slice(0, 100).map((item) => ({
      content_id: String(item.id ?? ""),
      quantity: typeof item.quantity === "number" ? item.quantity : 1,
      ...(typeof item.item_price === "number" ? { price: item.item_price } : {}),
    })).filter((item) => item.content_id)
    : undefined;
  const props: Record<string, unknown> = {};
  if (typeof customData.currency === "string") props.currency = customData.currency;
  if (typeof customData.value === "number") props.value = customData.value;
  if (typeof customData.search_string === "string") props.query = customData.search_string.slice(0, 200);
  if (contents?.length) {
    props.contents = contents;
    props.content_type = "product";
  }
  return Object.keys(props).length > 0 ? props : undefined;
}

export async function sendTikTokBrowserEvent(
  db: Database,
  input: TikTokBrowserRelayInput,
  options: { encryptionKey?: string; fetcher?: typeof fetch },
): Promise<TikTokRelayResult> {
  const event = tiktokEventForMetaEvent(input.eventName);
  if (!event) return { success: false, skipped: true, retryable: true, error: "not_relayed" };
  const read = await tiktokEventsDocument.readDetailed(db, { encryptionKey: options.encryptionKey });
  if (!tiktokServerEnabled(read) || !read.value.accessToken) {
    return { success: false, skipped: true, retryable: false, error: "not_configured: TikTok Events API is off or has no readable access token." };
  }
  const externalId = Array.isArray(input.userData.external_id) ? input.userData.external_id[0] : input.userData.external_id;
  const user = await tiktokUser({
    email: input.userData.em,
    phone: input.userData.ph,
    externalId,
    ttp: input.userData.ttp,
    ttclid: input.userData.ttclid,
    ip: input.userData.client_ip_address,
    userAgent: input.userData.client_user_agent,
  });
  const sent = await sendTikTokPayload({
    event_source: "web",
    event_source_id: read.value.pixelCode,
    ...(read.value.testEventCode ? { test_event_code: read.value.testEventCode } : {}),
    data: [{
      event,
      event_time: input.eventTime,
      event_id: input.eventId,
      user,
      page: { url: input.eventSourceUrl },
      ...(properties(input.customData) ? { properties: properties(input.customData) } : {}),
      ...(input.limitedDataUse ? { limited_data_use: true } : {}),
    }],
  }, read.value.accessToken, options.fetcher);
  return sent.ok
    ? { success: true, matchSignals: tiktokMatchSignals(user) }
    : { success: false, retryable: sent.retryable, error: sent.error };
}
