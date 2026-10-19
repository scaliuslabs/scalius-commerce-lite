// What the checkout proxy forwards about tracking (audit spec S4): the buyer's
// stored consent choice, Global Privacy Control and the first-party match
// signals, read from the buyer's own request on the storefront's origin. The
// API keeps only what the consent allows; nothing here is required.
import {
  CONSENT_COOKIE,
  parseConsentCookieValue,
  readCookie,
  readTrackingSignalCookies,
  requestHasGpc,
} from "@scalius/shared/tracking-consent";

export interface CheckoutTrackingSignals {
  consent: { analytics: boolean; marketing: boolean; saleOfData: boolean } | null;
  gpc: boolean;
  fbp: string | null;
  fbc: string | null;
  ttp: string | null;
  ttclid: string | null;
  gaClientId: string | null;
  gaSessionId: string | null;
  gclid: string | null;
  clientIp: string | null;
  userAgent: string | null;
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:.]{2,45}$/i;

export function checkoutTrackingSignals(request: Request): CheckoutTrackingSignals {
  const cookie = request.headers.get("cookie");
  const stored = parseConsentCookieValue(readCookie(cookie, CONSENT_COOKIE));
  const ip = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  const userAgent = request.headers.get("user-agent")?.trim() ?? "";
  return {
    consent: stored ? { analytics: stored.analytics, marketing: stored.marketing, saleOfData: stored.saleOfData } : null,
    gpc: requestHasGpc(request.headers.get("sec-gpc")),
    ...readTrackingSignalCookies(cookie),
    clientIp: IPV4.test(ip) || (ip.includes(":") && IPV6.test(ip)) ? ip : null,
    userAgent: userAgent ? userAgent.slice(0, 512) : null,
  };
}
