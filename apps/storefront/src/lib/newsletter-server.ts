// Server side of the newsletter: the signup endpoint's form reading and API
// call, the e-mail confirmation and the signed unsubscribe link. Everything
// goes to the API's storefront marketing routes with the system JWT, through
// the service binding, never the read batch. Phone numbers, e-mails and
// tokens travel only in POST bodies; a URL carries an outcome flag at most.
// Nothing here logs a body, a contact or a token.
import {
  NEWSLETTER_HONEYPOT_FIELD,
  MARKETING_CONTACT_CHANNELS,
  isMarketingChannel,
  type MarketingChannel,
} from "@scalius/shared/customer-marketing";
import { apiFetch } from "@/lib/api/transport";
import { PRIVATE_NO_STORE_CACHE_CONTROL } from "@/lib/cache-policy";
import {
  newsletterLanguage,
  type NewsletterLanguage,
  type NewsletterStatus,
} from "@/lib/newsletter-copy";
import { newsletterResultPath } from "@/lib/newsletter-form";
import { isOneClickJson, readBoundedText } from "@/lib/newsletter-one-click";
import { buyerIpHeaders } from "@/lib/order-lookup-api";

const API_TIMEOUT_MS = 8_000;
/** A signup or link form is a few hundred bytes; anything larger is not one. */
export const NEWSLETTER_MAX_BODY_BYTES = 4 * 1024;

/** Headers for pages and answers that carry a token: never cached, never sent on as a referrer. */
export const NEWSLETTER_TOKEN_PAGE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": PRIVATE_NO_STORE_CACHE_CONTROL,
  "Referrer-Policy": "no-referrer",
};

const OPT_IN_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UNSUBSCRIBE_TOKEN = /^u1\.[A-Za-z0-9_-]{1,200}\.(?:email|sms|whatsapp|push)\.[A-Za-z0-9_-]{43}$/;

/** A double opt-in confirmation token's shape (the API decides whether it is live). */
export function isNewsletterConfirmToken(value: unknown): value is string {
  return typeof value === "string" && OPT_IN_TOKEN.test(value);
}

/** A signed unsubscribe token's shape (the API checks the signature). */
export function isNewsletterUnsubscribeToken(value: unknown): value is string {
  return typeof value === "string" && value.length <= 400 && UNSUBSCRIBE_TOKEN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentTypeOf(request: Request): string {
  return request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** A small form post (urlencoded or multipart), or null when it is not one. */
export async function readNewsletterForm(request: Request): Promise<FormData | null> {
  const type = contentTypeOf(request);
  if (type !== "application/x-www-form-urlencoded" && type !== "multipart/form-data") return null;
  const body = await readBoundedText(request, NEWSLETTER_MAX_BODY_BYTES);
  if (body === null) return null;
  try {
    if (type === "application/x-www-form-urlencoded") {
      const form = new FormData();
      for (const [key, value] of new URLSearchParams(body)) form.append(key, value);
      return form;
    }
    return await new Response(body, { headers: { "Content-Type": request.headers.get("Content-Type")! } }).formData();
  } catch {
    return null;
  }
}

function field(form: FormData, name: string, max: number): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export interface NewsletterSignup {
  /** The off-screen field people never see was filled: a bot. */
  honeypot: boolean;
  phone: string;
  email: string;
  /** The form had an e-mail field (it posts one, empty or not). */
  emailOffered: boolean;
  whatsapp: boolean;
  channels: Array<(typeof MARKETING_CONTACT_CHANNELS)[number]>;
  language: NewsletterLanguage;
}

export function readNewsletterSignup(form: FormData): NewsletterSignup {
  return {
    honeypot: field(form, NEWSLETTER_HONEYPOT_FIELD, 200) !== "",
    phone: field(form, "phone", 32),
    email: field(form, "email", 254),
    emailOffered: form.has("email"),
    whatsapp: form.getAll("channel").includes("whatsapp"),
    channels: MARKETING_CONTACT_CHANNELS.filter((channel) => form.getAll("channel").includes(channel)),
    language: newsletterLanguage(field(form, "language", 16)),
  };
}

export interface NewsletterOutcome {
  status: NewsletterStatus;
  /** The field the API refused (`invalid` only). */
  field?: "phone" | "email" | "channel";
  retryAfterSeconds?: number;
}

interface ApiAnswer {
  status: number;
  data: Record<string, unknown> | null;
  details: Record<string, unknown>;
  retryAfter: string | null;
}

async function postMarketingApi(request: Request, path: string, body: Record<string, unknown>): Promise<ApiAnswer | null> {
  try {
    const response = await apiFetch(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...buyerIpHeaders(request) },
        body: JSON.stringify(body),
        cache: "no-store",
      },
      { retries: 0, timeout: API_TIMEOUT_MS, auth: true },
    );
    const json: unknown = await response.json().catch(() => null);
    const ok = response.ok && isRecord(json) && json.success !== false;
    const error = isRecord(json) && isRecord(json.error) ? json.error : {};
    return {
      status: response.ok && !ok ? 502 : response.status,
      data: ok && isRecord(json.data) ? json.data : null,
      details: isRecord(error.details) ? error.details : {},
      retryAfter: response.headers.get("Retry-After"),
    };
  } catch (error) {
    console.error("[newsletter] API request failed:", error instanceof Error ? error.name : typeof error);
    return null;
  }
}

function retrySeconds(answer: ApiAnswer): number | undefined {
  const value = Number(answer.details.retryAfterSeconds ?? answer.retryAfter);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}

/** A failed answer as a status: too many tries, refused input, or anything else. */
function failure(answer: ApiAnswer | null, refused: NewsletterStatus): NewsletterOutcome {
  if (answer?.status === 429) {
    const retryAfterSeconds = retrySeconds(answer);
    return { status: "rate_limited", ...(retryAfterSeconds ? { retryAfterSeconds } : {}) };
  }
  if (answer?.status === 400 || answer?.status === 422) {
    const field = answer.details.field;
    return { status: refused, ...(field === "phone" || field === "email" || field === "channel" ? { field } : {}) };
  }
  return { status: "error" };
}

/**
 * A signup: the honeypot answers like a success and calls nothing; an empty
 * phone is refused here; the rest goes to the API with only the fields it
 * accepts and the consent text the form showed.
 */
export async function subscribeToNewsletter(request: Request, signup: NewsletterSignup): Promise<NewsletterOutcome> {
  if (signup.honeypot) return { status: "subscribed" };
  if (!signup.phone) return { status: "invalid", field: "phone" };
  if (!signup.channels.length) return { status: "invalid", field: "channel" };
  const answer = await postMarketingApi(request, "/marketing/subscribe", {
    phone: signup.phone,
    ...(signup.email ? { email: signup.email } : {}),
    channels: signup.channels,
    language: signup.language,

  });
  if (answer?.status === 200 && answer.data) {
    return { status: answer.data.result === "pending" ? "pending" : "subscribed" };
  }
  return failure(answer, "invalid");
}

/** Confirms an e-mail subscription with the link's token. */
export async function confirmNewsletterSubscription(request: Request, token: unknown): Promise<NewsletterOutcome> {
  if (!isNewsletterConfirmToken(token)) return { status: "link_invalid" };
  const answer = await postMarketingApi(request, "/marketing/confirm", { token });
  if (answer?.status === 200 && answer.data) {
    return { status: answer.data.status === "confirmed" ? "confirmed" : "link_invalid" };
  }
  return failure(answer, "link_invalid");
}

export interface UnsubscribePreview {
  channel: MarketingChannel;
  /** "a•••@example.com" / "+880 17•••••678". */
  contactMasked: string;
  /** Already off for this address: nothing to unsubscribe. */
  alreadyOff: boolean;
}

/** What a signed link would unsubscribe (changes nothing); `invalid` for a dead link, null when the API is unreachable. */
export async function previewNewsletterUnsubscribe(
  request: Request,
  token: unknown,
): Promise<UnsubscribePreview | "invalid" | "rate_limited" | null> {
  if (!isNewsletterUnsubscribeToken(token)) return "invalid";
  const answer = await postMarketingApi(request, "/marketing/unsubscribe/preview", { token });
  if (answer?.status === 429) return "rate_limited";
  if (answer?.status === 400 || answer?.status === 422) return "invalid";
  if (answer?.status !== 200 || !answer.data) return null;
  const { valid, channel, contactMasked, status } = answer.data;
  if (valid !== true || !isMarketingChannel(channel) || typeof contactMasked !== "string" || !contactMasked) return "invalid";
  return { channel, contactMasked, alreadyOff: status === "unsubscribed" || status === "not_subscribed" };
}

/** Unsubscribes the channel a signed link names (idempotent). */
export async function unsubscribeFromNewsletter(request: Request, token: unknown): Promise<NewsletterOutcome> {
  if (!isNewsletterUnsubscribeToken(token)) return { status: "link_invalid" };
  const answer = await postMarketingApi(request, "/marketing/unsubscribe", { token });
  if (answer?.status === 200 && answer.data) {
    return { status: answer.data.status === "unsubscribed" ? "unsubscribed" : "link_invalid" };
  }
  return failure(answer, "link_invalid");
}

// ── Answers ────────────────────────────────────────────────────────────────

/** An enhanced (fetch) post asks for JSON; a plain form post gets a redirect. */
export function wantsNewsletterJson(request: Request): boolean {
  return request.headers.get("Accept")?.toLowerCase().includes("application/json") ?? false;
}

const JSON_STATUS: Partial<Record<NewsletterStatus, number>> = {
  invalid: 400,
  link_invalid: 400,
  rate_limited: 429,
  error: 502,
};

export function newsletterJson(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": PRIVATE_NO_STORE_CACHE_CONTROL },
  });
}

/** 303 to the result page: the outcome flag is the only thing in the URL. */
export function newsletterRedirect(status: NewsletterStatus, extra: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: newsletterResultPath(status), "Cache-Control": PRIVATE_NO_STORE_CACHE_CONTROL, ...extra },
  });
}

/** The answer to a signup post: JSON with the outcome for the script, else a 303. */
export function respondToNewsletterPost(request: Request, outcome: NewsletterOutcome): Response {
  if (!wantsNewsletterJson(request)) return newsletterRedirect(outcome.status);
  const ok = !(outcome.status in JSON_STATUS);
  return newsletterJson({
    success: ok,
    status: outcome.status,
    ...(outcome.field ? { field: outcome.field } : {}),
    ...(outcome.retryAfterSeconds ? { retryAfterSeconds: outcome.retryAfterSeconds } : {}),
  }, JSON_STATUS[outcome.status] ?? 200);
}

/**
 * Whether a post comes from another site. A form post from this store
 * carries its own Origin; a post with none (an old browser, a non-browser
 * client) is allowed, as on the store's other form endpoints.
 */
export function isCrossOriginPost(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin !== new URL(request.url).origin;
  } catch {
    return true;
  }
}

export function newsletterForbidden(request: Request): Response {
  return wantsNewsletterJson(request)
    ? newsletterJson({ success: false, status: "error" }, 403)
    : new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": PRIVATE_NO_STORE_CACHE_CONTROL } });
}

// ── RFC 8058 one-click unsubscribe ─────────────────────────────────────────

/** Whether a JSON post is exactly the one-click body (as the gateway hands it on). */
export async function isOneClickPost(request: Request): Promise<boolean> {
  const text = await readBoundedText(request, 512);
  if (!text) return false;
  try {
    return isOneClickJson(JSON.parse(text));
  } catch {
    return false;
  }
}

/** The plain-text answer a mail client gets for a one-click unsubscribe. */
export function oneClickText(text: string, status: number): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...NEWSLETTER_TOKEN_PAGE_HEADERS },
  });
}
