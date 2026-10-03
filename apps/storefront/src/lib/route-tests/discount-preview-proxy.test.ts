// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock("@/lib/api/transport", () => mocks);

import { POST } from "../../pages/api/checkout/discount-preview";

const ORIGIN = "https://storefront.example.test";
const BODY = JSON.stringify({ codes: ["QA-OCT3-VIP"], items: [{ id: "prod_1", price: 500, quantity: 1, variantId: "var_1" }] });

function call(init: { body?: string; cookie?: string; origin?: string; contentType?: string } = {}) {
  const headers: Record<string, string> = {
    Origin: init.origin ?? ORIGIN,
    "Content-Type": init.contentType ?? "application/json",
  };
  if (init.cookie) headers.Cookie = init.cookie;
  return POST({
    request: new Request(`${ORIGIN}/api/checkout/discount-preview`, { method: "POST", headers, body: init.body ?? BODY }),
  } as never);
}

describe("signed-in discount preview proxy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("previews with the buyer's httpOnly session, so segment-limited codes price as checkout will", async () => {
    const preview = { success: true, data: { totalDiscount: 50, discounts: [], offers: [], rejectedCodes: [] } };
    mocks.apiFetch.mockResolvedValue(Response.json(preview));

    const response = await call({ cookie: "theme=dark; cs_tok=session%2Btoken; cs_auth=1" });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(await response.json()).toEqual(preview);
    const [path, init, policy] = mocks.apiFetch.mock.calls[0]!;
    expect(path).toBe("/discounts/validate");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Customer-Session"]).toBe("session+token");
    expect(JSON.parse(init.body)).toEqual(JSON.parse(BODY));
    expect(policy).toMatchObject({ auth: false, retries: 0 });
  });

  it("previews a buyer without a session as a guest", async () => {
    mocks.apiFetch.mockResolvedValue(Response.json({ success: true, data: { totalDiscount: 0 } }));
    await call();
    expect(mocks.apiFetch.mock.calls[0]![1].headers["X-Customer-Session"]).toBeUndefined();
  });

  it("passes the API's refusal through and hides other failures", async () => {
    mocks.apiFetch.mockResolvedValueOnce(Response.json({ success: false, error: { message: "Refresh the cart before applying a discount." } }, { status: 400 }));
    const refused = await call({ cookie: "cs_tok=t" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { message: "Refresh the cart before applying a discount." } });

    mocks.apiFetch.mockResolvedValueOnce(new Response("upstream exploded", { status: 500 }));
    expect((await call({ cookie: "cs_tok=t" })).status).toBe(502);
  });

  it("refuses cross-origin, non-JSON, malformed and oversized requests before calling the API", async () => {
    expect((await call({ origin: "https://evil.example" })).status).toBe(403);
    expect((await call({ contentType: "text/plain" })).status).toBe(415);
    expect((await call({ body: "{not json" })).status).toBe(400);
    expect((await call({ body: JSON.stringify({ codes: ["x".repeat(70 * 1024)] }) })).status).toBe(413);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});
