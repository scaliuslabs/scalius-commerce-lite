// GA4 Measurement Protocol (developers.google.com/analytics/devguides/collection/protocol/ga4/reference).
// Server `purchase` and `refund` events for orders. Consent rides in the
// request (`consent.ad_user_data` / `ad_personalization`); a request with
// analytics denied is never built (the delivery is skipped). `debugMode`
// sends to the validation server, which answers with validation messages
// and records nothing, so a merchant or agent can check a setup.

import { fromMinor } from "@scalius/shared/money";
import { sha256Hex } from "@scalius/shared/hash";

export const GA4_COLLECT_URL = "https://www.google-analytics.com/mp/collect";
export const GA4_DEBUG_URL = "https://www.google-analytics.com/debug/mp/collect";
/** The Measurement Protocol accepts `timestamp_micros` up to 72 hours back. */
export const GA4_MAX_BACKDATE_SECONDS = 72 * 60 * 60;

export interface Ga4OrderFacts {
  id: string;
  customerId: string | null;
  currencyCode: string;
  currencyDecimalPlaces: number;
  totalAmountMinor: number;
  taxAmountMinor: number;
  shippingAmountMinor: number;
  /** Epoch seconds of the commit. */
  committedAt: number;
}

export interface Ga4OrderItem {
  productId: string;
  variantId: string | null;
  productName: string | null;
  variantLabel: string | null;
  quantity: number;
  unitPriceMinor: number;
}

export interface Ga4Identity {
  /** `_ga` client id; null builds a stable per-order id (no browser id was available). */
  clientId: string | null;
  sessionId: string | null;
  /** Ads consent (marketing): `ad_user_data` and `ad_personalization`. */
  adsConsent: boolean;
}

export interface Ga4Payload {
  client_id: string;
  user_id?: string;
  timestamp_micros?: number;
  consent: { ad_user_data: "GRANTED" | "DENIED"; ad_personalization: "GRANTED" | "DENIED" };
  events: Array<{ name: "purchase" | "refund"; params: Record<string, unknown> }>;
}

/** A per-order id in the `_ga` shape (`<number>.<seconds>`), the same for its purchase and refunds. */
export async function ga4FallbackClientId(orderId: string, committedAt: number): Promise<string> {
  const digest = await sha256Hex(`scalius-ga4:${orderId}`);
  return `${Number.parseInt(digest.slice(0, 8), 16)}.${committedAt}`;
}

function items(order: Ga4OrderFacts, lines: readonly Ga4OrderItem[]) {
  return lines.map((line) => ({
    item_id: line.variantId || line.productId,
    ...(line.productName ? { item_name: line.productName.slice(0, 100) } : {}),
    ...(line.variantLabel ? { item_variant: line.variantLabel.slice(0, 100) } : {}),
    price: fromMinor(line.unitPriceMinor, order.currencyDecimalPlaces),
    quantity: line.quantity,
  }));
}

async function envelope(order: Ga4OrderFacts, identity: Ga4Identity, nowSeconds: number): Promise<Omit<Ga4Payload, "events">> {
  const consent = identity.adsConsent ? "GRANTED" as const : "DENIED" as const;
  const backdated = nowSeconds - order.committedAt;
  return {
    client_id: identity.clientId ?? await ga4FallbackClientId(order.id, order.committedAt),
    ...(order.customerId ? { user_id: order.customerId } : {}),
    // The commit time when GA4 still accepts it, else GA4 stamps the receipt.
    ...(backdated >= 0 && backdated <= GA4_MAX_BACKDATE_SECONDS ? { timestamp_micros: order.committedAt * 1_000_000 } : {}),
    consent: { ad_user_data: consent, ad_personalization: consent },
  };
}

export async function buildGa4PurchasePayload(
  order: Ga4OrderFacts,
  lines: readonly Ga4OrderItem[],
  identity: Ga4Identity,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<Ga4Payload> {
  const amount = (minor: number) => fromMinor(minor, order.currencyDecimalPlaces);
  return {
    ...await envelope(order, identity, nowSeconds),
    events: [{
      name: "purchase",
      params: {
        transaction_id: order.id,
        currency: order.currencyCode,
        value: amount(order.totalAmountMinor),
        tax: amount(order.taxAmountMinor),
        shipping: amount(order.shippingAmountMinor),
        items: items(order, lines),
        ...(identity.sessionId ? { session_id: identity.sessionId } : {}),
        engagement_time_msec: 1,
      },
    }],
  };
}

/** A confirmed refund of `amountMinor` in the order currency (GA4 matches it by transaction id). */
export async function buildGa4RefundPayload(
  order: Ga4OrderFacts,
  amountMinor: number,
  identity: Ga4Identity,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<Ga4Payload> {
  const base = await envelope(order, identity, nowSeconds);
  delete base.timestamp_micros;
  return {
    ...base,
    events: [{
      name: "refund",
      params: {
        transaction_id: order.id,
        currency: order.currencyCode,
        value: fromMinor(amountMinor, order.currencyDecimalPlaces),
        engagement_time_msec: 1,
      },
    }],
  };
}

export interface Ga4SendResult {
  ok: boolean;
  retryable: boolean;
  /** Debug mode: the validation server's messages (field paths and descriptions only). */
  validationMessages?: Array<{ fieldPath?: string; description?: string; validationCode?: string }>;
  status: number;
  error?: string;
}

export async function sendGa4Payload(
  payload: Ga4Payload,
  settings: { measurementId: string; apiSecret: string; debugMode: boolean },
  fetcher: typeof fetch = fetch,
): Promise<Ga4SendResult> {
  const url = new URL(settings.debugMode ? GA4_DEBUG_URL : GA4_COLLECT_URL);
  url.searchParams.set("measurement_id", settings.measurementId);
  url.searchParams.set("api_secret", settings.apiSecret);
  let response: Response;
  try {
    response = await fetcher(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return { ok: false, retryable: true, status: 0, error: "network_error: GA4 could not be reached." };
  }
  if (settings.debugMode) {
    const body = await response.json().catch(() => null) as { validationMessages?: Ga4SendResult["validationMessages"] } | null;
    const validationMessages = (body?.validationMessages ?? []).slice(0, 10).map((message) => ({
      fieldPath: typeof message.fieldPath === "string" ? message.fieldPath.slice(0, 120) : undefined,
      description: typeof message.description === "string" ? message.description.slice(0, 300) : undefined,
      validationCode: typeof message.validationCode === "string" ? message.validationCode.slice(0, 60) : undefined,
    }));
    if (!response.ok) return { ok: false, retryable: response.status >= 500 || response.status === 429, status: response.status, error: `http_${response.status}`, validationMessages };
    return { ok: validationMessages.length === 0, retryable: false, status: response.status, validationMessages, ...(validationMessages.length ? { error: "validation_failed: GA4 rejected the event (debug mode)." } : {}) };
  }
  await response.body?.cancel();
  if (response.ok) return { ok: true, retryable: false, status: response.status };
  return {
    ok: false,
    retryable: response.status >= 500 || response.status === 429,
    status: response.status,
    error: `http_${response.status}: GA4 refused the request.`,
  };
}

/** The match signals a GA4 event carried, for tracking_health. */
export function ga4MatchSignals(identity: Ga4Identity, userId: string | null): string[] {
  return [
    ...(identity.clientId ? ["client_id"] : []),
    ...(identity.sessionId ? ["session_id"] : []),
    ...(userId ? ["user_id"] : []),
  ];
}
