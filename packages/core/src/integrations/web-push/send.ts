// Web Push delivery (RFC 8030). Never logs endpoints, keys or payloads.

import { encryptWebPushPayload, type WebPushKeys } from "./encrypt";
import { vapidAuthorization, type VapidKeys } from "./vapid";

export interface WebPushSubscription {
  endpoint: string;
  keys: WebPushKeys;
}

export type WebPushOutcome = "sent" | "gone" | "retry" | "rejected";

export interface WebPushResult {
  outcome: WebPushOutcome;
  httpStatus: number | null;
}

export interface SendWebPushInput {
  subscription: WebPushSubscription;
  payload: string | Uint8Array | null;
  vapid: VapidKeys;
  subject: string;
  ttlSeconds?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  topic?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

const DEFAULT_TTL_SECONDS = 86_400;
const MAX_TTL_SECONDS = 2_419_200;

const EXACT_PUSH_HOSTS = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  "android.googleapis.com",
  "jmt17.google.com",
]);
const PUSH_HOST_SUFFIXES = [".push.apple.com", ".notify.windows.com"];

/**
 * Only known browser push services may be called. This stops a forged
 * subscription from making the Worker request an arbitrary host.
 */
export function isAllowedPushEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return EXACT_PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function classify(status: number): WebPushOutcome {
  if (status === 201 || status === 202) return "sent";
  if (status === 404 || status === 410) return "gone";
  if (status === 429 || status >= 500) return "retry";
  return "rejected";
}

const refused: WebPushResult = { outcome: "rejected", httpStatus: null };

/**
 * Sends one push message. Encryption and key errors throw `WebPushError`;
 * every delivery result, including network failure, is a `WebPushResult`.
 */
export async function sendWebPush(input: SendWebPushInput): Promise<WebPushResult> {
  const { subscription } = input;
  if (!isAllowedPushEndpoint(subscription.endpoint)) return refused;
  if (input.topic !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(input.topic)) return refused;

  const ttl = Math.min(
    Math.max(Math.floor(input.ttlSeconds ?? DEFAULT_TTL_SECONDS), 0),
    MAX_TTL_SECONDS,
  );
  const headers: Record<string, string> = {
    TTL: String(ttl),
    Authorization: await vapidAuthorization(input.vapid, subscription.endpoint, input.subject),
  };
  if (input.urgency) headers.Urgency = input.urgency;
  if (input.topic) headers.Topic = input.topic;

  let body: Uint8Array | undefined;
  if (input.payload !== null) {
    const plaintext =
      typeof input.payload === "string" ? new TextEncoder().encode(input.payload) : input.payload;
    body = await encryptWebPushPayload(subscription.keys, plaintext);
    headers["Content-Encoding"] = "aes128gcm";
    headers["Content-Type"] = "application/octet-stream";
  }

  try {
    const response = await (input.fetch ?? fetch)(subscription.endpoint, {
      method: "POST",
      headers,
      body: body as BodyInit | undefined,
      redirect: "manual",
      signal: input.signal,
    });
    // Release the connection. The response body is not used.
    await response.body?.cancel().catch(() => undefined);
    return { outcome: classify(response.status), httpStatus: response.status };
  } catch {
    return { outcome: "retry", httpStatus: null };
  }
}
