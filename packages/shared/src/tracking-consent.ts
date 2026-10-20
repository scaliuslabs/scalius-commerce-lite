// Tracking consent: the one rule every pixel, tag and server sender follows
// (audit spec §3.10, lead decision D6). Pure and browser-safe: the storefront
// banner, the checkout proxy and the API's server senders all import it.
//
// - A market that sells to the EEA, the UK or Switzerland is opt-in: nothing
//   that needs consent runs until the buyer grants it.
// - Other markets follow the merchant's `otherRegions` setting: a notice
//   banner (default; granted until the buyer says no), opt-in like the EEA,
//   or only the "Your privacy choices" link.
// - Global Privacy Control denies marketing and the sale or sharing of data.
// - Google tags load with Consent Mode v2 defaults; Meta and TikTok load only
//   when marketing is granted.

export type ConsentRegime = "opt_in" | "notice" | "link_only";
export type ConsentSource = "banner" | "default" | "gpc";

export interface ConsentState {
  /** Measurement (GA4, Tag Manager). */
  analytics: boolean;
  /** Advertising pixels and their server events (Meta, TikTok). */
  marketing: boolean;
  /** Sharing data with advertising partners (US "sale or sharing"; Meta LDU). */
  saleOfData: boolean;
  source: ConsentSource;
}

export interface TrackingConsentSettings {
  /** The banner of markets outside the EEA, the UK and Switzerland. */
  otherRegions: ConsentRegime;
}

export const DEFAULT_TRACKING_CONSENT_SETTINGS: TrackingConsentSettings = { otherRegions: "notice" };

export const CONSENT_REGIMES: readonly ConsentRegime[] = ["opt_in", "notice", "link_only"];

/** EEA (EU 27 + Iceland, Liechtenstein, Norway), the United Kingdom and Switzerland. */
export const OPT_IN_COUNTRIES: ReadonlySet<string> = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "IS", "LI", "NO",
  "GB", "CH",
]);

/** The consent cookie: first-party, strictly necessary, never a cache key. */
export const CONSENT_COOKIE = "scalius_consent";
/** 180 days, the usual re-prompt interval. */
export const CONSENT_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

/** Which category a destination needs. */
export type ConsentCategory = "analytics" | "marketing";

export function normalizeConsentRegime(value: unknown): ConsentRegime {
  return CONSENT_REGIMES.includes(value as ConsentRegime) ? value as ConsentRegime : DEFAULT_TRACKING_CONSENT_SETTINGS.otherRegions;
}

/**
 * The regime of a market (its countries) or of one order country: opt-in when
 * any country is in the EEA, the UK or Switzerland, else the merchant's choice.
 * No country at all is the merchant's choice too.
 */
export function consentRegimeFor(
  countries: readonly (string | null | undefined)[],
  settings: Partial<TrackingConsentSettings> | null | undefined,
): ConsentRegime {
  if (countries.some((country) => typeof country === "string" && OPT_IN_COUNTRIES.has(country.trim().toUpperCase()))) {
    return "opt_in";
  }
  return normalizeConsentRegime(settings?.otherRegions);
}

/** The state before the buyer chooses: denied under opt-in, granted otherwise; GPC applied. */
export function defaultConsent(regime: ConsentRegime, gpc = false): ConsentState {
  const granted = regime !== "opt_in";
  return applyGpc({ analytics: granted, marketing: granted, saleOfData: granted, source: "default" }, gpc);
}

/** GPC denies marketing and sale of data whatever else was chosen. */
export function applyGpc(state: ConsentState, gpc: boolean): ConsentState {
  if (!gpc || (!state.marketing && !state.saleOfData)) return state;
  return { ...state, marketing: false, saleOfData: false, source: "gpc" };
}

/** `v1-a1-m0-s0`: version, then one digit per category. */
export function serializeConsentCookieValue(state: Pick<ConsentState, "analytics" | "marketing" | "saleOfData">): string {
  return `v1-a${state.analytics ? 1 : 0}-m${state.marketing ? 1 : 0}-s${state.saleOfData ? 1 : 0}`;
}

const CONSENT_VALUE = /^v1-a([01])-m([01])-s([01])$/;

/** The buyer's stored choice, or null when there is none (or it is unreadable). */
export function parseConsentCookieValue(value: string | null | undefined): ConsentState | null {
  const match = typeof value === "string" ? CONSENT_VALUE.exec(value.trim()) : null;
  if (!match) return null;
  return { analytics: match[1] === "1", marketing: match[2] === "1", saleOfData: match[3] === "1", source: "banner" };
}

/** One cookie's value from a Cookie header (first match), decoded; null when absent. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * The consent that holds for one request: the stored choice, else the
 * regime's default; GPC applied to both.
 */
export function resolveConsent(options: {
  stored: ConsentState | null;
  regime: ConsentRegime;
  gpc: boolean;
}): ConsentState {
  return options.stored ? applyGpc(options.stored, options.gpc) : defaultConsent(options.regime, options.gpc);
}

export function consentAllows(state: Pick<ConsentState, ConsentCategory>, category: ConsentCategory): boolean {
  return state[category] === true;
}

/** Google Consent Mode v2 parameters for a state (`gtag('consent', 'default' | 'update', ...)`). */
export function gtagConsentParameters(state: Pick<ConsentState, "analytics" | "marketing">): {
  ad_storage: "granted" | "denied";
  analytics_storage: "granted" | "denied";
  ad_user_data: "granted" | "denied";
  ad_personalization: "granted" | "denied";
} {
  const flag = (value: boolean) => (value ? "granted" : "denied") as "granted" | "denied";
  return {
    ad_storage: flag(state.marketing),
    analytics_storage: flag(state.analytics),
    ad_user_data: flag(state.marketing),
    ad_personalization: flag(state.marketing),
  };
}

/**
 * The consent a stored analytics script needs before it may load. Google tags
 * load under Consent Mode (their defaults deny storage until granted), so they
 * need none; Meta and TikTok pixels, and custom snippets that load either,
 * need marketing. Cloudflare Web Analytics is cookieless.
 */
export function analyticsScriptConsentCategory(script: { type: string; config: string }): "marketing" | null {
  const type = script.type.trim().toLowerCase();
  if (type === "facebook_pixel" || type === "tiktok_pixel") return "marketing";
  if (type !== "custom") return null;
  return MARKETING_SNIPPET.test(script.config) ? "marketing" : null;
}

const MARKETING_SNIPPET = /\bfbq\s*\(|connect\.facebook\.net|analytics\.tiktok\.com|TiktokAnalyticsObject|\bttq\.(?:load|page|track)\s*\(/i;

// --- Match signals (first-party identifiers the server senders need) -------

export interface BrowserTrackingSignals {
  fbp: string | null;
  fbc: string | null;
  ttp: string | null;
  ttclid: string | null;
  gaClientId: string | null;
  gaSessionId: string | null;
  gclid: string | null;
}

/** First-party cookies the storefront itself writes when consent allows (click ids from the landing URL). */
export const CLICK_ID_COOKIES = { fbc: "_fbc", ttclid: "scalius_ttclid", gclid: "scalius_gclid" } as const;
/** 90 days, Meta's `_fbc` lifetime. */
export const CLICK_ID_COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

const FBP = /^fb\.\d\.\d{10,16}\.\d{1,20}$/;
const FBC = /^fb\.\d\.\d{10,16}\.[A-Za-z0-9_-]{8,500}$/;
const CLICK_ID = /^[A-Za-z0-9_.-]{8,500}$/;
const TTP = /^[A-Za-z0-9_.-]{8,128}$/;

/** `fb.1.<ms>.<fbclid>` (Meta's documented format). */
export function fbcFromClickId(fbclid: string, nowMs: number): string | null {
  const id = fbclid.trim();
  return CLICK_ID.test(id) ? `fb.1.${Math.floor(nowMs)}.${id}` : null;
}

/** `GA1.1.<random>.<seconds>` → `<random>.<seconds>`. */
export function gaClientIdFromCookie(value: string | null | undefined): string | null {
  const match = typeof value === "string" ? /^GA\d\.\d+\.(\d{1,20}\.\d{1,12})$/.exec(value.trim()) : null;
  return match ? match[1]! : null;
}

/** The session id of a `_ga_<container>` cookie: `GS1.1.<session>.…` or `GS2.1.s<session>$…`. */
export function gaSessionIdFromCookie(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  const gs1 = /^GS1\.\d+\.(\d{6,12})\./.exec(text);
  if (gs1) return gs1[1]!;
  const gs2 = /^GS2\.\d+\.s(\d{6,12})(?:\$|$)/.exec(text);
  return gs2 ? gs2[1]! : null;
}

function firstGaSessionCookie(cookieHeader: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (/^_ga_[A-Z0-9]{4,20}$/.test(name)) return part.slice(index + 1).trim();
  }
  return null;
}

/**
 * The match signals of a buyer request, from first-party cookies only. Each
 * value is shape-checked, so a forged or oversized cookie becomes null.
 */
export function readTrackingSignalCookies(cookieHeader: string | null | undefined): BrowserTrackingSignals {
  const header = cookieHeader ?? "";
  const pick = (name: string, pattern: RegExp) => {
    const value = readCookie(header, name)?.trim() ?? "";
    return pattern.test(value) ? value : null;
  };
  return {
    fbp: pick("_fbp", FBP),
    fbc: pick(CLICK_ID_COOKIES.fbc, FBC),
    ttp: pick("_ttp", TTP),
    ttclid: pick(CLICK_ID_COOKIES.ttclid, CLICK_ID),
    gaClientId: gaClientIdFromCookie(readCookie(header, "_ga")),
    gaSessionId: gaSessionIdFromCookie(firstGaSessionCookie(header)),
    gclid: pick(CLICK_ID_COOKIES.gclid, CLICK_ID),
  };
}

/** Whether a request carries Global Privacy Control (`Sec-GPC: 1`). */
export function requestHasGpc(headerValue: string | null | undefined): boolean {
  return typeof headerValue === "string" && headerValue.trim() === "1";
}

/**
 * The signals a sender may use under a consent state: advertising ids only
 * with marketing, GA ids only with analytics. A denied category stores none.
 */
export function signalsAllowedBy(state: Pick<ConsentState, "analytics" | "marketing">, signals: BrowserTrackingSignals): BrowserTrackingSignals {
  return {
    fbp: state.marketing ? signals.fbp : null,
    fbc: state.marketing ? signals.fbc : null,
    ttp: state.marketing ? signals.ttp : null,
    ttclid: state.marketing ? signals.ttclid : null,
    gclid: state.marketing ? signals.gclid : null,
    gaClientId: state.analytics ? signals.gaClientId : null,
    gaSessionId: state.analytics ? signals.gaSessionId : null,
  };
}

/** What a storefront order commits about tracking (order_tracking_signals, audit spec 3.10). */
export interface OrderTrackingSnapshot {
  consent: ConsentState;
  signals: BrowserTrackingSignals;
  clientIp: string | null;
  userAgent: string | null;
  /** The server purchase deliveries the order owes (GA4 and TikTok; Meta has its own outbox). */
  deliveries: Array<"ga4" | "tiktok">;
}

/**
 * The shared browser/server event id (Meta `eventID`/`event_id`, TikTok
 * `event_id`): `<Event>:<stable key>`. Purchase uses the order id, so the
 * pixel, CAPI and the Events API dedupe the same purchase.
 */
export function trackingEventId(eventName: string, stableKey: string): string {
  return `${eventName}:${stableKey}`;
}
