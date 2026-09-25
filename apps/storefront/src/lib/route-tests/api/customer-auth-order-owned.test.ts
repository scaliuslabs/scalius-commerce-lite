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

import { GET } from "../../../pages/api/customer-auth/orders/[id]/owned";

const call = (id: string, cookie = "cs_tok=session") => GET({
  request: new Request(`https://storefront.example.test/api/customer-auth/orders/${id}/owned`, {
    headers: { Cookie: cookie },
  }),
  params: { id },
} as never) as Promise<Response>;

beforeEach(() => mocks.fetch.mockReset());

describe("receipt ownership check", () => {
  it("says owned when the signed-in account can read the order, without passing the order on", async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ success: true, data: { order: { customerName: "STAB Buyer" } } })));

    const response = await call("ord_1");

    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/customer-auth/orders/ord_1",
      expect.objectContaining({ method: "GET" }),
    );
    expect((mocks.fetch.mock.calls[0]?.[1] as RequestInit).headers).toBeInstanceOf(Headers);
    expect(((mocks.fetch.mock.calls[0]?.[1] as RequestInit).headers as Headers).get("Cookie")).toBe("cs_tok=session");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ success: true, owned: true });
    expect(body).not.toContain("STAB Buyer");
  });

  it.each([401, 403, 404])("answers someone else's order (%i) as a normal 200 not-owned", async (status) => {
    mocks.fetch.mockResolvedValue(new Response("{}", { status }));

    const response = await call("ord_2");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, owned: false });
  });

  it("reports an API error as a failure, not as not-owned", async () => {
    mocks.fetch.mockResolvedValue(new Response("{}", { status: 500 }));
    const response = await call("ord_3");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ success: false, owned: false });
  });

  it("reports an unreachable API as a failure", async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError("offline"));
    const response = await call("ord_3").catch((error: unknown) => error);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(502);
  });

  it("never looks up an id that can't be an order", async () => {
    const response = await call("..%2Fme");

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ success: true, owned: false });
  });
});
