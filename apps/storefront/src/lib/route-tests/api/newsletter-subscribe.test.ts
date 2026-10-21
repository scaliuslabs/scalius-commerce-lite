// @vitest-environment node
// POST /api/newsletter/subscribe: the signup form's endpoint. A plain form
// post gets a 303 to /newsletter with the outcome flag only (never the phone
// or e-mail); the form's script gets JSON. Only the API's fields go out.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/transport", () => ({ apiFetch: mocks.apiFetch }));

import { POST } from "../../../pages/api/newsletter/subscribe";

const PHONE = "01712345678";
const EMAIL = "rina@example.com";

function post(fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request("https://shop.example/api/newsletter/subscribe", {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://shop.example", ...headers },
  });
}

function api(status: number, body: unknown) {
  mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

const call = (request: Request) => POST({ request } as never) as Promise<Response>;

beforeEach(() => {
  mocks.apiFetch.mockReset();
});

describe("newsletter signup endpoint", () => {
  it("forwards the signup and redirects with only the outcome", async () => {
    api(200, { success: true, data: { result: "pending" } });
    const response = await call(post({ phone: PHONE, email: EMAIL, language: "en", channel: "email", company_website: "" }));

    expect(response.status).toBe(303);
    const location = response.headers.get("Location")!;
    expect(location).toBe("/newsletter?status=pending");
    expect(location).not.toContain(PHONE);
    expect(location).not.toContain("rina");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const [path, init, policy] = mocks.apiFetch.mock.calls[0]!;
    expect(path).toBe("/marketing/subscribe");
    expect(policy).toMatchObject({ auth: true, retries: 0 });
    expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual(["channels", "email", "language", "phone"]);
  });

  it("answers the enhanced form with JSON", async () => {
    api(200, { success: true, data: { result: "subscribed" } });
    const response = await call(post({ phone: PHONE, channel: "whatsapp", language: "bn" }, { Accept: "application/json" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, status: "subscribed" });
    expect(JSON.parse(String(mocks.apiFetch.mock.calls[0]![1].body))).toMatchObject({ channels: ["whatsapp"], language: "bn" });
  });

  it("pretends success for a filled honeypot and calls nothing", async () => {
    const plain = await call(post({ phone: PHONE, company_website: "buy-now.example" }));
    expect([plain.status, plain.headers.get("Location")]).toEqual([303, "/newsletter?status=subscribed"]);
    const enhanced = await call(post({ phone: PHONE, company_website: "x" }, { Accept: "application/json" }));
    expect(await enhanced.json()).toEqual({ success: true, status: "subscribed" });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it.each([
    [400, { success: false, error: { code: "validation_error", details: { field: "phone" } } }, "invalid"],
    [429, { success: false, error: { code: "rate_limited", details: { retryAfterSeconds: 60 } } }, "rate_limited"],
    [500, { success: false, error: { code: "INTERNAL" } }, "error"],
  ])("maps an API %s to ?status=%s", async (status, body, flag) => {
    api(status, body);
    const response = await call(post({ phone: PHONE, channel: "sms" }));
    expect(response.headers.get("Location")).toBe(`/newsletter?status=${flag}`);
  });

  it("refuses a cross-site post and an unreadable body before calling the API", async () => {
    const crossSite = await call(post({ phone: PHONE }, { Origin: "https://evil.example" }));
    expect(crossSite.status).toBe(403);
    const json = await call(new Request("https://shop.example/api/newsletter/subscribe", {
      method: "POST",
      body: JSON.stringify({ phone: PHONE }),
      headers: { "Content-Type": "application/json" },
    }));
    expect(json.headers.get("Location")).toBe("/newsletter?status=invalid");
    const empty = await call(post({ phone: "" }));
    expect(empty.headers.get("Location")).toBe("/newsletter?status=invalid");
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});
