// TikTok Events API 2.0 (business-api.tiktok.com/open_api/v1.3/event/track/).
//
// Event names follow TikTok's current standard-event list ("About Standard
// Events in TikTok Ads Manager", ads.tiktok.com/help/article/standard-events-parameters):
// the purchase event is `Purchase` (`CompletePayment` is the retired name and
// no longer listed). A browser `ttq.track` and its server event dedupe when
// they share the event name and `event_id`; both use Meta's id
// (`Purchase:<orderId>`), so one id dedupes the purchase on both platforms.

import { fromMinor } from "@scalius/shared/money";
import { sha256Hex } from "@scalius/shared/hash";
import { phoneOrNull } from "@scalius/shared/customer-auth-policy";

export const TIKTOK_EVENTS_URL = "https://business-api.tiktok.com/open_api/v1.3/event/track/";

/** The TikTok standard events the storefront sends (browser and server). */
export const TIKTOK_STANDARD_EVENTS = [
  "ViewContent",
  "Search",
  "AddToCart",
  "InitiateCheckout",
  "AddPaymentInfo",
  "Purchase",
  "SubmitForm",
  "CompleteRegistration",
] as const;
export type TikTokStandardEvent = (typeof TIKTOK_STANDARD_EVENTS)[number];

export interface TikTokUser {
  email?: string[];
  phone?: string[];
  external_id?: string[];
  ttp?: string;
  ttclid?: string;
  ip?: string;
  user_agent?: string;
}

export interface TikTokEvent {
  event: TikTokStandardEvent;
  event_time: number;
  event_id: string;
  user: TikTokUser;
  page?: { url: string; referrer?: string };
  properties?: Record<string, unknown>;
  limited_data_use?: boolean;
}

export interface TikTokPayload {
  event_source: "web";
  event_source_id: string;
  test_event_code?: string;
  data: TikTokEvent[];
}

/** Raw identifiers; hashing follows TikTok's normalization (trimmed lowercase email, E.164 phone). */
export async function tiktokUser(input: {
  email?: string | null;
  phone?: string | null;
  externalId?: string | null;
  ttp?: string | null;
  ttclid?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<TikTokUser> {
  const user: TikTokUser = {};
  const email = input.email?.trim().toLowerCase();
  if (email) user.email = [await sha256Hex(email)];
  const phone = phoneOrNull(input.phone ?? null)?.replace(/[^\d+]/g, "");
  if (phone) user.phone = [await sha256Hex(phone.startsWith("+") ? phone : `+${phone}`)];
  const externalId = input.externalId?.trim().toLowerCase();
  if (externalId) user.external_id = [await sha256Hex(externalId)];
  if (input.ttp) user.ttp = input.ttp;
  if (input.ttclid) user.ttclid = input.ttclid;
  if (input.ip) user.ip = input.ip;
  if (input.userAgent) user.user_agent = input.userAgent;
  return user;
}

/** The names of the signals a user object carries, for tracking_health. */
export function tiktokMatchSignals(user: TikTokUser): string[] {
  const names: Array<[keyof TikTokUser, string]> = [
    ["email", "email"], ["phone", "phone"], ["external_id", "external_id"],
    ["ttp", "ttp"], ["ttclid", "ttclid"], ["ip", "ip"], ["user_agent", "user_agent"],
  ];
  return names.filter(([key]) => user[key] !== undefined).map(([, name]) => name);
}

export function buildTikTokPurchaseEvent(input: {
  order: { id: string; currencyCode: string; currencyDecimalPlaces: number; totalAmountMinor: number; committedAt: number };
  lines: ReadonlyArray<{ productId: string; variantId: string | null; productName: string | null; quantity: number; unitPriceMinor: number }>;
  user: TikTokUser;
  pageUrl: string;
  eventId: string;
  limitedDataUse: boolean;
}): TikTokEvent {
  const amount = (minor: number) => fromMinor(minor, input.order.currencyDecimalPlaces);
  return {
    event: "Purchase",
    event_time: input.order.committedAt,
    event_id: input.eventId,
    user: input.user,
    page: { url: input.pageUrl },
    properties: {
      currency: input.order.currencyCode,
      value: amount(input.order.totalAmountMinor),
      content_type: "product",
      order_id: input.order.id,
      contents: input.lines.map((line) => ({
        content_id: line.variantId || line.productId,
        ...(line.productName ? { content_name: line.productName.slice(0, 100) } : {}),
        quantity: line.quantity,
        price: amount(line.unitPriceMinor),
      })),
    },
    ...(input.limitedDataUse ? { limited_data_use: true } : {}),
  };
}

export interface TikTokSendResult {
  ok: boolean;
  retryable: boolean;
  status: number;
  code?: number;
  error?: string;
}

/** TikTok answers HTTP 200 with `code: 0` on success; other codes are errors (40xxx: request or auth). */
export async function sendTikTokPayload(
  payload: TikTokPayload,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<TikTokSendResult> {
  let response: Response;
  try {
    response = await fetcher(TIKTOK_EVENTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Access-Token": accessToken },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return { ok: false, retryable: true, status: 0, error: "network_error: TikTok could not be reached." };
  }
  const body = await response.json().catch(() => null) as { code?: unknown } | null;
  const code = typeof body?.code === "number" ? body.code : undefined;
  if (response.ok && code === 0) return { ok: true, retryable: false, status: response.status, code };
  const retryable = response.status === 429 || response.status >= 500 || (code !== undefined && code >= 50000);
  return {
    ok: false,
    retryable,
    status: response.status,
    ...(code !== undefined ? { code } : {}),
    error: `tiktok_error: HTTP ${response.status}${code !== undefined ? `, code ${code}` : ""}.`,
  };
}
