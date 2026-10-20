import { describe, expect, it } from "vitest";
import {
  analyticsScriptConsentCategory,
  consentRegimeFor,
  defaultConsent,
  fbcFromClickId,
  gaClientIdFromCookie,
  gaSessionIdFromCookie,
  gtagConsentParameters,
  parseConsentCookieValue,
  readTrackingSignalCookies,
  resolveConsent,
  serializeConsentCookieValue,
  signalsAllowedBy,
  trackingEventId,
} from "./tracking-consent";

describe("tracking consent rules (audit spec 3.10, lead decision D6)", () => {
  it("makes any market selling to the EEA, the UK or Switzerland opt-in, whatever the merchant chose", () => {
    expect(consentRegimeFor(["DE"], { otherRegions: "link_only" })).toBe("opt_in");
    expect(consentRegimeFor(["BD", "gb"], { otherRegions: "notice" })).toBe("opt_in");
    expect(consentRegimeFor(["CH"], null)).toBe("opt_in");
    expect(consentRegimeFor(["NO"], null)).toBe("opt_in");
    expect(consentRegimeFor(["BD", "IN"], null)).toBe("notice");
    expect(consentRegimeFor(["US"], { otherRegions: "opt_in" })).toBe("opt_in");
    expect(consentRegimeFor([], { otherRegions: "link_only" })).toBe("link_only");
    expect(consentRegimeFor(["US"], { otherRegions: "bogus" as never })).toBe("notice");
  });

  it("denies by default under opt-in and grants otherwise; GPC denies marketing and sale of data", () => {
    expect(defaultConsent("opt_in")).toEqual({ analytics: false, marketing: false, saleOfData: false, source: "default" });
    expect(defaultConsent("notice")).toEqual({ analytics: true, marketing: true, saleOfData: true, source: "default" });
    expect(defaultConsent("notice", true)).toEqual({ analytics: true, marketing: false, saleOfData: false, source: "gpc" });
    const stored = parseConsentCookieValue("v1-a1-m1-s1")!;
    expect(resolveConsent({ stored, regime: "opt_in", gpc: true })).toMatchObject({ analytics: true, marketing: false, saleOfData: false, source: "gpc" });
    expect(resolveConsent({ stored: null, regime: "opt_in", gpc: false }).marketing).toBe(false);
  });

  it("round-trips the cookie and refuses anything else", () => {
    const value = serializeConsentCookieValue({ analytics: true, marketing: false, saleOfData: false });
    expect(value).toBe("v1-a1-m0-s0");
    expect(parseConsentCookieValue(value)).toEqual({ analytics: true, marketing: false, saleOfData: false, source: "banner" });
    for (const bad of ["", "v2-a1-m1-s1", "v1-a1-m1", "v1-a2-m1-s1", null]) expect(parseConsentCookieValue(bad)).toBeNull();
  });

  it("maps a state to Consent Mode v2", () => {
    expect(gtagConsentParameters({ analytics: true, marketing: false })).toEqual({
      ad_storage: "denied",
      analytics_storage: "granted",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
  });

  it("gates Meta and TikTok snippets (and custom ones that load them) on marketing; Google and Cloudflare need none", () => {
    expect(analyticsScriptConsentCategory({ type: "facebook_pixel", config: "" })).toBe("marketing");
    expect(analyticsScriptConsentCategory({ type: "tiktok_pixel", config: "" })).toBe("marketing");
    expect(analyticsScriptConsentCategory({ type: "custom", config: "<script>fbq('init','1')</script>" })).toBe("marketing");
    expect(analyticsScriptConsentCategory({ type: "custom", config: "<script>console.log(1)</script>" })).toBeNull();
    expect(analyticsScriptConsentCategory({ type: "google_analytics", config: "gtag('config','G-1')" })).toBeNull();
    expect(analyticsScriptConsentCategory({ type: "cloudflare_web_analytics", config: "" })).toBeNull();
  });

  it("reads only well-formed first-party signals and keeps only what consent allows", () => {
    const cookie = [
      "_fbp=fb.1.1790000000000.1234567890",
      "_fbc=fb.1.1790000000000.IwAR0abcdefgh",
      "_ttp=ttp_abcdefgh123",
      "scalius_ttclid=E.C.P.abcdefgh12345",
      "_ga=GA1.1.1234567890.1790000000",
      "_ga_ABC123XYZ=GS2.1.s1790000123$o1$g1$t1790000200",
      "scalius_gclid=" + "x".repeat(600),
    ].join("; ");
    const signals = readTrackingSignalCookies(cookie);
    expect(signals).toEqual({
      fbp: "fb.1.1790000000000.1234567890",
      fbc: "fb.1.1790000000000.IwAR0abcdefgh",
      ttp: "ttp_abcdefgh123",
      ttclid: "E.C.P.abcdefgh12345",
      gaClientId: "1234567890.1790000000",
      gaSessionId: "1790000123",
      gclid: null,
    });
    expect(readTrackingSignalCookies("_fbp=<script>").fbp).toBeNull();
    expect(gaSessionIdFromCookie("GS1.1.1790000123.4.1.1790000200.0.0.0")).toBe("1790000123");
    expect(gaClientIdFromCookie("GA1.2.99.1700000000")).toBe("99.1700000000");
    expect(signalsAllowedBy({ analytics: true, marketing: false }, signals)).toMatchObject({ fbp: null, fbc: null, ttp: null, gaClientId: "1234567890.1790000000" });
    expect(fbcFromClickId("IwAR0abcdefgh", 1_790_000_000_000)).toBe("fb.1.1790000000000.IwAR0abcdefgh");
  });

  it("shares one event id between the browser and the server senders (Meta and TikTok)", () => {
    expect(trackingEventId("Purchase", "ord_1")).toBe("Purchase:ord_1");
  });
});
