// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/lib/api/transport", () => ({
  resolveBackendTarget: (apiPath: string) => ({
    url: `https://api.example.test${apiPath}`,
    fetch: mocks.fetch,
    viaServiceBinding: true,
  }),
}));

import { ALL } from "../../../pages/api/customer-auth/[...path]";

const call = (path: string) => ALL({
  request: new Request(`https://storefront.example.test/api/customer-auth/${path}`, { method: "POST" }),
  params: { path },
} as never) as Promise<Response>;

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }));
});

describe("customer auth proxy", () => {
  it.each(["phone/send-code", "phone/verify"])("forwards %s to the API", async (path) => {
    const response = await call(path);

    expect(response.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledWith(
      `https://api.example.test/api/v1/customer-auth/${path}`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("forwards record paths whose ids carry underscores", async () => {
    const response = await call("orders/ord_V1a-x_9/payment-session");

    expect(response.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/customer-auth/orders/ord_V1a-x_9/payment-session",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("forwards the query string, so the next page of orders is the next page", async () => {
    const response = await ALL({
      request: new Request("https://storefront.example.test/api/customer-auth/orders?cursor=c_2&limit=5"),
      params: { path: "orders" },
    } as never) as Response;

    expect(response.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/customer-auth/orders?cursor=c_2&limit=5",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it.each(["phone/../admin", "orders/a.b/verify", "orders/a%2F/verify"])("rejects %s", async (path) => {
    const response = await call(path);

    expect(response.status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});


it("forwards an origin-less SW session GET, preserving the authoritative customerId and no-store headers", async () => {
  const body = { success: true, data: { authenticated: true, customer: { customerId: "cust_A", name: "Fixture buyer" } } };
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } }));
  const response = await ALL({ request: new Request("https://storefront.example.test/api/customer-auth/me", {
    headers: { Cookie: "cs_tok=fictional-test-cookie", "Sec-Fetch-Site": "same-origin" },
  }), params: { path: "me" } } as never) as Response;
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(await response.json()).toEqual(body);
  const [url, options] = mocks.fetch.mock.calls[0]!;
  expect(url).toBe("https://api.example.test/api/v1/customer-auth/me");
  expect(options.method).toBe("GET");
  expect(options.headers.get("Cookie")).toBe("cs_tok=fictional-test-cookie");
});
