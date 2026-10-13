// @vitest-environment node
// Account → Profile → News and offers: the posted form sends only the
// channels the buyer changed, through the account API with the session
// cookie; the outcome comes back as a flag in the URL, never a contact.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountMarketingConsentText } from "@scalius/shared/customer-marketing";
import { newsletterCopy, newsletterLanguage } from "./newsletter-copy";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api/transport", () => ({
  resolveBackendTarget: (path: string) => ({
    url: `https://api.internal${path}`,
    fetch: api.fetch,
    viaServiceBinding: true,
  }),
}));

import {
  accountMarketingLocation,
  accountMarketingOn,
  readAccountMarketingFlag,
  readAccountMarketingForm,
} from "./account-marketing";
import { readAccountMarketing, saveAccountMarketing } from "./account-server";

const SESSION = "cs_tok=session-token-value";

function signedIn(): Request {
  return new Request("https://shop.example.test/account/profile", { method: "POST", headers: { Cookie: SESSION } });
}

function form(fields: Array<[string, string]>): FormData {
  const data = new FormData();
  for (const [key, value] of fields) data.append(key, value);
  return data;
}

function answer(status: number, body: unknown) {
  api.fetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

const CHANNELS = [
  { channel: "email", status: "pending", available: true },
  { channel: "sms", status: "subscribed", available: true },
  { channel: "whatsapp", status: "not_subscribed", available: true },
];

beforeEach(() => {
  api.fetch.mockReset();
});

describe("account consent wording", () => {
  it.each(["en", "bn", "bn-BD", "BN", "fr"])("records the heading, explanation and selected label rendered in %s", (language) => {
    const copy = newsletterCopy(newsletterLanguage(language)).account;
    for (const channel of ["email", "sms", "whatsapp", "push"] as const) {
      expect(accountMarketingConsentText(language, channel)).toBe(`${copy.heading}: ${copy.text} [${copy.channelLabel[channel]}]`);
    }
  });
});

describe("account marketing preferences form", () => {
  it("sends only the channels the buyer changed", () => {
    // Shown: email on (pending), SMS on, WhatsApp off. Posted: SMS off, WhatsApp on, email left on.
    const posted = form([
      ["intent", "marketing"],
      ["was_email", "on"], ["was_sms", "on"], ["was_whatsapp", "off"],
      ["channel", "email"], ["channel", "whatsapp"],
    ]);
    expect(readAccountMarketingForm(posted)).toEqual({ sms: false, whatsapp: true });
    // A channel the form did not show (no address for it) is never sent.
    expect(readAccountMarketingForm(form([["channel", "email"]]))).toEqual({});
  });

  it("ticks subscribed and pending channels", () => {
    expect(CHANNELS.map((row) => accountMarketingOn(row as never))).toEqual([true, true, false]);
  });

  it("puts only an outcome flag in the URL", () => {
    expect(accountMarketingLocation("confirm")).toBe("/account/profile?marketing=confirm#marketing");
    expect(readAccountMarketingFlag(new URLSearchParams("marketing=saved"))).toBe("saved");
    expect(readAccountMarketingFlag(new URLSearchParams("marketing=rina@example.com"))).toBeNull();
  });
});

describe("account marketing API", () => {
  it("reads and saves through the account API with the session cookie only", async () => {
    answer(200, { success: true, data: { channels: [...CHANNELS, { channel: "fax", status: "subscribed", available: true }] } });
    expect(await readAccountMarketing(signedIn())).toEqual({ ok: true, data: CHANNELS });
    const [readUrl, readInit] = api.fetch.mock.calls[0]!;
    expect(readUrl).toBe("https://api.internal/api/v1/customer-auth/marketing");
    expect(new Headers(readInit.headers).get("Cookie")).toBe(SESSION);

    answer(200, { success: true, data: { channels: CHANNELS, confirmationRequested: true } });
    expect(await saveAccountMarketing(signedIn(), { email: true, language: "bn" }))
      .toEqual({ ok: true, channels: CHANNELS, confirmationRequested: true });
    const [, saveInit] = api.fetch.mock.calls[1]!;
    expect(saveInit.method).toBe("PUT");
    expect(JSON.parse(String(saveInit.body))).toEqual({ email: true, language: "bn" });
  });

  it("tells a signed-out buyer, a refusal and an outage apart", async () => {
    expect(await readAccountMarketing(new Request("https://shop.example.test/account/profile"))).toEqual({ ok: false, reason: "signed_out" });
    expect(api.fetch).not.toHaveBeenCalled();
    answer(400, { success: false, error: { message: "Add an email address first." } });
    expect(await saveAccountMarketing(signedIn(), { email: true })).toEqual({ ok: false, reason: "invalid", message: "Add an email address first." });
    answer(503, { success: false, error: { message: "Down" } });
    expect(await saveAccountMarketing(signedIn(), { sms: false })).toEqual({ ok: false, reason: "unavailable", message: null });
  });
});
