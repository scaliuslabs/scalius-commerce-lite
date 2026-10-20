// dashboard.analytics.send_test_event (audit spec §3.10): one test event to a
// destination, answering with the provider's accepted/rejected summary, so a
// merchant or agent verifies a setup without the dashboard. Nothing reaches
// live data: Meta and TikTok need their test event code (Events Manager >
// Test events), GA4 always uses the Measurement Protocol validation server.

import type { Database } from "@scalius/database/client";
import { ConflictError } from "../../errors";
import { metaConversionsDocument } from "../settings";
import { sendCapiEvent } from "../../integrations/meta/conversions-api";
import { buildGa4PurchasePayload, sendGa4Payload } from "../../integrations/ga4/measurement-protocol";
import { sendTikTokPayload } from "../../integrations/tiktok/events-api";
import { ga4MeasurementDocument, ga4ServerEnabled, tiktokEventsDocument, tiktokServerEnabled } from "../../integrations/tracking/settings";

export type TrackingTestDestination = "meta" | "ga4" | "tiktok";

export interface TrackingTestResult {
  destination: TrackingTestDestination;
  accepted: boolean;
  /** Meta and TikTok: the test event code's Events Manager view; GA4: the validation server. */
  mode: "test_event_code" | "ga4_validation";
  eventId: string;
  /** Provider summary: HTTP status, error code and (GA4) validation messages. Never a token. */
  details: Record<string, unknown>;
}

export async function sendTrackingTestEvent(
  db: Database,
  destination: TrackingTestDestination,
  options: { encryptionKey?: string; storefrontUrl?: string | null; fetcher?: typeof fetch },
): Promise<TrackingTestResult> {
  const eventId = `Test:${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const pageUrl = safeOrigin(options.storefrontUrl) ?? "https://example.invalid";

  if (destination === "meta") {
    const read = await metaConversionsDocument.readDetailed(db, { encryptionKey: options.encryptionKey });
    if (!read.value.isEnabled || !read.value.pixelId || !read.value.accessToken) {
      throw new ConflictError("Meta Conversions API is off or has no readable access token.");
    }
    if (!read.value.testEventCode) {
      throw new ConflictError("Set a Meta test event code (Events Manager > Test events) before sending a test event.");
    }
    const result = await sendCapiEvent(db, {
      event_name: "ViewContent",
      event_time: now,
      event_source_url: `${pageUrl}/`,
      event_id: eventId,
      action_source: "website",
      user_data: { client_user_agent: "Scalius tracking test", client_ip_address: "192.0.2.1" },
      custom_data: { content_name: "Scalius test event" },
    }, { encryptionKey: options.encryptionKey });
    return {
      destination,
      accepted: result.success,
      mode: "test_event_code",
      eventId,
      details: result.success
        ? { eventsReceived: (result.response as { events_received?: unknown } | undefined)?.events_received ?? null }
        : { error: result.error ?? "Meta refused the event." },
    };
  }

  if (destination === "ga4") {
    const read = await ga4MeasurementDocument.readDetailed(db, { encryptionKey: options.encryptionKey });
    if (!ga4ServerEnabled(read) || !read.value.apiSecret) {
      throw new ConflictError("GA4 Measurement Protocol is off or has no readable API secret.");
    }
    const payload = await buildGa4PurchasePayload(
      { id: eventId, customerId: null, currencyCode: "USD", currencyDecimalPlaces: 2, totalAmountMinor: 100, taxAmountMinor: 0, shippingAmountMinor: 0, committedAt: now },
      [{ productId: "test-product", variantId: null, productName: "Scalius test product", variantLabel: null, quantity: 1, unitPriceMinor: 100 }],
      { clientId: null, sessionId: null, adsConsent: false },
      now,
    );
    const sent = await sendGa4Payload(payload, { ...read.value, debugMode: true }, options.fetcher);
    return {
      destination,
      accepted: sent.ok,
      mode: "ga4_validation",
      eventId,
      details: { status: sent.status, validationMessages: sent.validationMessages ?? [], ...(sent.error ? { error: sent.error } : {}) },
    };
  }

  const read = await tiktokEventsDocument.readDetailed(db, { encryptionKey: options.encryptionKey });
  if (!tiktokServerEnabled(read) || !read.value.accessToken) {
    throw new ConflictError("TikTok Events API is off or has no readable access token.");
  }
  if (!read.value.testEventCode) {
    throw new ConflictError("Set a TikTok test event code (Events Manager > Test events) before sending a test event.");
  }
  const sent = await sendTikTokPayload({
    event_source: "web",
    event_source_id: read.value.pixelCode,
    test_event_code: read.value.testEventCode,
    data: [{ event: "ViewContent", event_time: now, event_id: eventId, user: { user_agent: "Scalius tracking test" }, page: { url: `${pageUrl}/` } }],
  }, read.value.accessToken, options.fetcher);
  return {
    destination,
    accepted: sent.ok,
    mode: "test_event_code",
    eventId,
    details: { status: sent.status, ...(sent.code !== undefined ? { code: sent.code } : {}), ...(sent.error ? { error: sent.error } : {}) },
  };
}

function safeOrigin(value: string | null | undefined): string | null {
  try {
    return value?.trim() ? new URL(value).origin : null;
  } catch {
    return null;
  }
}
