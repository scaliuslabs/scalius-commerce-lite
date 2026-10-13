// @vitest-environment node
// The newsletter's server side against a mocked API transport: only the
// fields the API accepts go out, with the system JWT and the buyer's IP;
// API answers map to outcome flags; tokens are checked for shape before any
// call; the one-click rewrite only ever matches the RFC 8058 body.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/transport", () => ({ apiFetch: mocks.apiFetch }));

import {
  confirmNewsletterSubscription,
  isNewsletterConfirmToken,
  isNewsletterUnsubscribeToken,
  previewNewsletterUnsubscribe,
  readNewsletterForm,
  readNewsletterSignup,
  respondToNewsletterPost,
  subscribeToNewsletter,
  unsubscribeFromNewsletter,
} from "./newsletter-server";
import { oneClickUnsubscribeRequest } from "./newsletter-one-click";
import { newsletterMarketingConsentText } from "@scalius/shared/customer-marketing";
import { isValidResourceCanonicalPath } from "@scalius/shared/seo-canonical";
import { isPrivateStorefrontPathname } from "./cache-policy";

const CONFIRM_TOKEN = "A".repeat(43);
const UNSUBSCRIBE_TOKEN = `u1.Y3VzdF8x.email.${"b".repeat(43)}`;

function api(status: number, body: unknown, headers: Record<string, string> = {}) {
  mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  }));
}

function buyer(): Request {
  return new Request("https://shop.example/api/newsletter/subscribe", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.7" },
  });
}

function signupForm(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

beforeEach(() => {
  mocks.apiFetch.mockReset();
});

describe("newsletter signup", () => {
  it("sends only the selected channels and accepted fields; core owns consent evidence", async () => {
    api(200, { success: true, data: { result: "pending" } });
    const signup = readNewsletterSignup(signupForm({
      phone: " 01712345678 ",
      email: "rina@example.com",
      channel: "whatsapp",
      language: "bn",
      company_website: "",
      utm_source: "fb",
      customerId: "cust_forged",
    }));
    const outcome = await subscribeToNewsletter(buyer(), signup);

    expect(outcome).toEqual({ status: "pending" });
    const [path, init, policy] = mocks.apiFetch.mock.calls[0]!;
    expect(path).toBe("/marketing/subscribe");
    expect(policy).toEqual({ retries: 0, timeout: 8000, auth: true });
    expect((init.headers as Record<string, string>)["cf-connecting-ip"]).toBe("203.0.113.7");
    expect(JSON.parse(String(init.body))).toEqual({
      phone: "01712345678",
      email: "rina@example.com",
      channels: ["whatsapp"],
      language: "bn",
    });
  });

  it("sends only the separately selected SMS channel and leaves an empty email out", async () => {
    api(200, { success: true, data: { result: "subscribed" } });
    await subscribeToNewsletter(buyer(), readNewsletterSignup(signupForm({ phone: "01712345678", email: "", language: "en", channel: "sms" })));
    expect(JSON.parse(String(mocks.apiFetch.mock.calls[0]![1].body))).toEqual({
      phone: "01712345678",
      channels: ["sms"],
      language: "en",
    });
    expect(newsletterMarketingConsentText("en", ["sms"])).toBe("Choose channels for news and offers. Unsubscribe anytime. [SMS]");
  });

  it("asks for a channel without contacting the API when none was selected", async () => {
    const outcome = await subscribeToNewsletter(buyer(), readNewsletterSignup(signupForm({ phone: "01712345678" })));
    expect(outcome).toEqual({ status: "invalid", field: "channel" });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it("answers a filled honeypot like a success and calls nothing", async () => {
    const outcome = await subscribeToNewsletter(buyer(), readNewsletterSignup(signupForm({
      phone: "01712345678",
      company_website: "https://spam.example",
    })));
    expect(outcome).toEqual({ status: "subscribed" });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it("refuses an empty phone without calling the API", async () => {
    expect(await subscribeToNewsletter(buyer(), readNewsletterSignup(signupForm({ phone: "  ", email: "a@b.co" }))))
      .toEqual({ status: "invalid", field: "phone" });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it("maps refusals, limits and failures to outcome flags", async () => {
    const signup = readNewsletterSignup(signupForm({ phone: "123", channel: "sms" }));
    api(400, { success: false, error: { code: "VALIDATION_ERROR", message: "Enter a valid phone number.", details: { field: "email" } } });
    expect(await subscribeToNewsletter(buyer(), signup)).toEqual({ status: "invalid", field: "email" });
    api(429, { success: false, error: { code: "RATE_LIMIT", details: { retryAfterSeconds: 42 } } });
    expect(await subscribeToNewsletter(buyer(), signup)).toEqual({ status: "rate_limited", retryAfterSeconds: 42 });
    api(503, { success: false, error: { code: "SERVICE_UNAVAILABLE" } });
    expect(await subscribeToNewsletter(buyer(), signup)).toEqual({ status: "error" });
    mocks.apiFetch.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await subscribeToNewsletter(buyer(), signup)).toEqual({ status: "error" });
  });

  it("redirects a plain post with only the outcome, and answers the script with JSON", async () => {
    const plain = respondToNewsletterPost(new Request("https://shop.example/api/newsletter/subscribe", { method: "POST" }), { status: "pending" });
    expect(plain.status).toBe(303);
    expect(plain.headers.get("Location")).toBe("/newsletter?status=pending");
    expect(plain.headers.get("Cache-Control")).toContain("no-store");

    const enhanced = new Request("https://shop.example/api/newsletter/subscribe", { method: "POST", headers: { Accept: "application/json" } });
    const ok = respondToNewsletterPost(enhanced, { status: "subscribed" });
    expect([ok.status, await ok.json()]).toEqual([200, { success: true, status: "subscribed" }]);
    const refused = respondToNewsletterPost(enhanced, { status: "invalid", field: "phone" });
    expect([refused.status, await refused.json()]).toEqual([400, { success: false, status: "invalid", field: "phone" }]);
    const limited = respondToNewsletterPost(enhanced, { status: "rate_limited", retryAfterSeconds: 30 });
    expect([limited.status, await limited.json()]).toEqual([429, { success: false, status: "rate_limited", retryAfterSeconds: 30 }]);
  });

  it("reads small urlencoded and multipart posts and nothing else", async () => {
    const post = (body: BodyInit, headers: Record<string, string>) =>
      new Request("https://shop.example/api/newsletter/subscribe", { method: "POST", body, headers });
    const urlencoded = await readNewsletterForm(post("phone=01712345678&email=", { "Content-Type": "application/x-www-form-urlencoded" }));
    expect(urlencoded?.get("phone")).toBe("01712345678");
    expect(urlencoded?.has("email")).toBe(true);
    const multipart = new FormData();
    multipart.set("phone", "01712345678");
    expect((await readNewsletterForm(new Request("https://shop.example/x", { method: "POST", body: multipart })))?.get("phone")).toBe("01712345678");
    expect(await readNewsletterForm(post(JSON.stringify({ phone: "1" }), { "Content-Type": "application/json" }))).toBeNull();
    expect(await readNewsletterForm(post(`phone=${"1".repeat(5000)}`, { "Content-Type": "application/x-www-form-urlencoded" }))).toBeNull();
  });
});

describe("newsletter links", () => {
  it("checks a token's shape before calling the API", async () => {
    expect(isNewsletterConfirmToken(CONFIRM_TOKEN)).toBe(true);
    expect(isNewsletterConfirmToken(`${CONFIRM_TOKEN}x`)).toBe(false);
    expect(isNewsletterUnsubscribeToken(UNSUBSCRIBE_TOKEN)).toBe(true);
    expect(isNewsletterUnsubscribeToken("u1.x.fax.sig")).toBe(false);
    expect(await confirmNewsletterSubscription(buyer(), "nope")).toEqual({ status: "link_invalid" });
    expect(await unsubscribeFromNewsletter(buyer(), null)).toEqual({ status: "link_invalid" });
    expect(await previewNewsletterUnsubscribe(buyer(), "u1.bad")).toBe("invalid");
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it("confirms with the token in the body and maps the answer", async () => {
    api(200, { success: true, data: { status: "confirmed" } });
    expect(await confirmNewsletterSubscription(buyer(), CONFIRM_TOKEN)).toEqual({ status: "confirmed" });
    const [path, init] = mocks.apiFetch.mock.calls[0]!;
    expect(path).toBe("/marketing/confirm");
    expect(JSON.parse(String(init.body))).toEqual({ token: CONFIRM_TOKEN });
    api(200, { success: true, data: { status: "invalid" } });
    expect(await confirmNewsletterSubscription(buyer(), CONFIRM_TOKEN)).toEqual({ status: "link_invalid" });
  });

  it("previews without unsubscribing, then unsubscribes", async () => {
    api(200, { success: true, data: { valid: true, channel: "email", status: "subscribed", contactMasked: "r•••@example.com" } });
    expect(await previewNewsletterUnsubscribe(buyer(), UNSUBSCRIBE_TOKEN)).toEqual({ channel: "email", contactMasked: "r•••@example.com", alreadyOff: false });
    expect(mocks.apiFetch.mock.calls[0]![0]).toBe("/marketing/unsubscribe/preview");
    api(200, { success: true, data: { valid: false, channel: null, status: null, contactMasked: null } });
    expect(await previewNewsletterUnsubscribe(buyer(), UNSUBSCRIBE_TOKEN)).toBe("invalid");
    api(200, { success: true, data: { status: "unsubscribed", channel: "email" } });
    expect(await unsubscribeFromNewsletter(buyer(), UNSUBSCRIBE_TOKEN)).toEqual({ status: "unsubscribed" });
    expect(mocks.apiFetch.mock.calls[2]![0]).toBe("/marketing/unsubscribe");
  });
});

describe("RFC 8058 one-click unsubscribe at the gateway", () => {
  const url = `https://shop.example/newsletter/unsubscribe?token=${UNSUBSCRIBE_TOKEN}`;

  it("hands a mail client's one-click POST on as JSON, keeping the URL and dropping cookies and Origin", async () => {
    const multipart = new FormData();
    multipart.set("List-Unsubscribe", "One-Click");
    const bodies: Array<{ body: BodyInit; headers: Record<string, string> }> = [
      { body: "List-Unsubscribe=One-Click", headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      { body: multipart, headers: {} },
    ];
    for (const init of bodies) {
      const incoming = new Request(url, {
        method: "POST",
        body: init.body,
        headers: { ...init.headers, Origin: "https://mail.example", Cookie: "cs_tok=x", "cf-connecting-ip": "198.51.100.4" },
      });
      const rewritten = await oneClickUnsubscribeRequest(incoming);
      expect(rewritten).not.toBeNull();
      expect(rewritten!.url).toBe(url);
      expect(rewritten!.headers.get("Content-Type")).toBe("application/json");
      expect(rewritten!.headers.has("Origin")).toBe(false);
      expect(rewritten!.headers.has("Cookie")).toBe(false);
      expect(rewritten!.headers.get("cf-connecting-ip")).toBe("198.51.100.4");
      expect(await rewritten!.json()).toEqual({ "List-Unsubscribe": "One-Click" });
    }
  });

  it("passes every other request through untouched", async () => {
    const post = (target: string, body: string, type = "application/x-www-form-urlencoded") =>
      new Request(target, { method: "POST", body, headers: { "Content-Type": type } });
    expect(await oneClickUnsubscribeRequest(post(url, "List-Unsubscribe=One-Click&token=x"))).toBeNull();
    expect(await oneClickUnsubscribeRequest(post(url, "token=x"))).toBeNull();
    expect(await oneClickUnsubscribeRequest(post("https://shop.example/newsletter/unsubscribe", "List-Unsubscribe=One-Click"))).toBeNull();
    expect(await oneClickUnsubscribeRequest(post("https://shop.example/newsletter/confirm?token=x", "List-Unsubscribe=One-Click"))).toBeNull();
    expect(await oneClickUnsubscribeRequest(new Request(url))).toBeNull();
    expect(await oneClickUnsubscribeRequest(post(url, `List-Unsubscribe=One-Click${" ".repeat(2000)}`))).toBeNull();
    // A request the gateway passes on keeps its body for the page.
    const page = post(url, "token=x");
    await oneClickUnsubscribeRequest(page);
    expect(await page.text()).toBe("token=x");
  });
});

describe("the newsletter's paths", () => {
  it("are private and no CMS page can take them", () => {
    for (const path of ["/newsletter", "/newsletter/confirm", "/newsletter/unsubscribe"]) {
      expect(isPrivateStorefrontPathname(path)).toBe(true);
    }
    expect(isValidResourceCanonicalPath("page", "/newsletter")).toBe(false);
    expect(isValidResourceCanonicalPath("page", "/newsletters")).toBe(true);
  });
});
