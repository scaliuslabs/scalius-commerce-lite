// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER } from "@scalius/shared/storefront-chat-boundary";

const mocks = vi.hoisted(() => ({
  cfEnv: {} as { BACKEND_API?: { fetch: typeof fetch }; PUBLIC_API_BASE_URL?: string },
  shouldRejectCrossOriginCookieRequest: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.cfEnv }));
vi.mock("@scalius/shared/request-origin-guard", () => ({
  shouldRejectCrossOriginCookieRequest: mocks.shouldRejectCrossOriginCookieRequest,
}));

import { POST } from "../../../../pages/api/assistant/chat";

describe("storefront assistant chat proxy", () => {
  beforeEach(() => {
    delete mocks.cfEnv.BACKEND_API;
    delete mocks.cfEnv.PUBLIC_API_BASE_URL;
    mocks.shouldRejectCrossOriginCookieRequest.mockReset();
    mocks.shouldRejectCrossOriginCookieRequest.mockReturnValue(false);
    vi.unstubAllGlobals();
  });

  it("fails closed with no-store JSON when no backend chat route is configured", async () => {
    const response = await POST({
      request: new Request("https://store.example.test/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Can you help?" }),
      }),
    } as never);
    const body = (await response.json()) as { status?: string; reason?: string };

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toMatchObject({ status: "disabled", reason: "api-missing" });
  });

  it("rejects cross-origin cookie requests before backend work", async () => {
    const backendFetch = vi.fn();
    mocks.cfEnv.BACKEND_API = { fetch: backendFetch as typeof fetch };
    mocks.shouldRejectCrossOriginCookieRequest.mockReturnValue(true);

    const response = await POST({
      request: new Request("https://store.example.test/api/assistant/chat", {
        method: "POST",
        headers: {
          Cookie: "cs_tok=private-session",
          Origin: "https://evil.example.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: "Can you help?" }),
      }),
    } as never);

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("posts bounded sanitized chat payloads to the API without cookies or auth", async () => {
    const backendFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe("http://api.internal/api/v1/storefront/chat");
      expect(init?.method).toBe("POST");

      const headers = new Headers(init?.headers);
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.has("cookie")).toBe(false);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.get(STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER)).toBe(
        "2001:db8::1",
      );

      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
        pageContext: unknown;
      };
      const serialized = JSON.stringify(body);

      expect(body.messages).toHaveLength(7);
      expect(body.messages[0]?.content).toBe("History 2");
      expect(body.messages.at(-1)).toEqual({
        role: "user",
        content: "Find rice for [redacted-email] [redacted-token]",
      });
      expect(serialized).not.toContain("Current safe storefront context");
      expect(serialized).toContain("Rice [redacted-phone]");
      expect(serialized).toContain("Bearer [redacted-token]");
      expect(serialized).not.toContain("buyer@example.test");
      expect(serialized).not.toContain("01711111111");
      expect(serialized).not.toContain("chk_private_receipt");
      expect(serialized).not.toContain("abc.def.ghi");
      expect(serialized).not.toContain("SECRET10");

      return new Response(
        JSON.stringify({
          success: true,
          data: {
            message: {
              role: "assistant",
              content: "Open the rice product page.",
            },
            actions: [
              { type: "navigate", path: "/products/rice", label: "Open Rice" },
              { type: "navigate", path: "/checkout", label: "Checkout" },
              { type: "delete_cart", path: "/cart", label: "Mutate Cart" },
            ],
            usage: { inputTokens: 10.4, outputTokens: 5.2 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    mocks.cfEnv.BACKEND_API = { fetch: backendFetch as typeof fetch };

    const response = await POST({
      request: new Request("https://store.example.test/api/assistant/chat", {
        method: "POST",
        headers: {
          Authorization: "Bearer should-not-forward",
          Cookie: "cs_tok=private-session",
          "CF-Connecting-IP":
            "2001:0db8:0000:0000:0000:0000:0000:0001",
          [STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER]: "198.51.100.200",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: "Find rice for buyer@example.test chk_private_receipt",
          history: Array.from({ length: 8 }, (_, index) => ({
            role: index % 2 === 0 ? "user" : "assistant",
            content: `History ${index}`,
          })),
          pageContext: {
            version: 1,
            source: "storefront",
            page: {
              path: "/products/rice?token=chk_private_receipt",
              route: "/products/[slug]",
              canonicalUrl:
                "https://store.example.test/products/rice?receiptToken=chk_private_receipt",
              title: "Rice buyer@example.test",
              kind: "product",
            },
            cart: {
              totalItems: 2,
              subtotalAmount: 20,
              lineCount: 1,
              hasDiscount: true,
              truncated: false,
              lines: [
                {
                  productId: "prod_rice",
                  variantId: "var_rice_pack",
                  name: "Rice 01711111111",
                  quantity: 2,
                  unitPrice: 10,
                  lineTotal: 20,
                  options: [{ name: "Pack", label: "Bearer abc.def.ghi" }],
                  discountCode: "SECRET10",
                },
              ],
            },
          },
        }),
      }),
    } as never);
    const body = (await response.json()) as {
      status?: string;
      actions?: Array<{ path: string; label: string }>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.status).toBe("ok");
    expect(body.actions).toEqual([{ type: "navigate", path: "/products/rice", label: "Open Rice" }]);
    expect(backendFetch).toHaveBeenCalledTimes(1);
  });

  it("omits malformed edge identity and never trusts a client-supplied internal header", async () => {
    const backendFetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(
          headers.has(STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER),
        ).toBe(false);
        return new Response(
          JSON.stringify({
            success: true,
            data: { message: { role: "assistant", content: "Safe response." } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    mocks.cfEnv.BACKEND_API = { fetch: backendFetch as typeof fetch };

    const response = await POST({
      request: new Request("https://store.example.test/api/assistant/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "buyer@example.test",
          [STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER]: "203.0.113.90",
        },
        body: JSON.stringify({ message: "Can you help?" }),
      }),
    } as never);

    expect(response.status, await response.clone().text()).toBe(200);
    expect(backendFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the client-IP header private to the service binding and omits it on HTTP fallback", async () => {
    mocks.cfEnv.PUBLIC_API_BASE_URL = "https://api.example.test";
    const publicFetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(
          headers.has(STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER),
        ).toBe(false);
        return new Response(
          JSON.stringify({
            success: true,
            data: { message: { role: "assistant", content: "Safe response." } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", publicFetch);

    const response = await POST({
      request: new Request("http://localhost:4321/api/assistant/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.40",
        },
        body: JSON.stringify({ message: "Can you help?" }),
      }),
    } as never);

    expect(response.status, await response.clone().text()).toBe(200);
    expect(publicFetch).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/storefront/chat",
      expect.any(Object),
    );
  });

  it("forwards valid bounded product, listing, and cart v2 surfaces", async () => {
    const forwarded: unknown[] = [];
    mocks.cfEnv.BACKEND_API = {
      fetch: vi.fn(async (_input, init) => {
        forwarded.push(JSON.parse(String(init?.body)).pageContext?.surface);
        return new Response(
          JSON.stringify({
            success: true,
            data: { message: { role: "assistant", content: "Safe context received." } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch,
    };

    const surfaces = [
      {
        page: { path: "/products/rice", kind: "product" },
        surface: {
          kind: "product",
          productId: "prod_rice",
          slug: "rice",
          selectedVariantId: "var_2kg",
          selectedOptions: [{ name: "Weight", label: "2KG" }],
          displayedPrice: 850,
          availability: "in_stock",
        },
      },
      {
        page: { path: "/search", kind: "search" },
        surface: {
          kind: "search",
          query: "premium rice",
          visibleProductIds: ["prod_rice", "prod_rice_gift"],
          visibleFilters: [{ key: "brand", value: "Scalius" }],
          totalResults: 2,
          page: 1,
          sortBy: "price-asc",
        },
      },
      {
        page: { path: "/cart", kind: "cart" },
        surface: {
          kind: "cart",
          revision: 12,
          fingerprint: "cart_v1_deadbeef",
          exactLineKeys: ["line:v2:prod_rice:variant:var_2kg"],
          totalItems: 2,
          lineCount: 1,
        },
      },
    ];

    for (const pageContext of surfaces) {
      const response = await POST({
        request: new Request("https://store.example.test/api/assistant/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Help with this page", pageContext }),
        }),
      } as never);
      expect(response.status, await response.clone().text()).toBe(200);
    }

    expect(forwarded).toEqual(surfaces.map(({ surface }) => surface));
  });

  it("drops spoofed, oversized, and PII-shaped surface values before forwarding", async () => {
    let forwardedSurface: unknown;
    mocks.cfEnv.BACKEND_API = {
      fetch: vi.fn(async (_input, init) => {
        forwardedSurface = JSON.parse(String(init?.body)).pageContext?.surface;
        return new Response(
          JSON.stringify({
            success: true,
            data: { message: { role: "assistant", content: "Safe context received." } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch,
    };

    const response = await POST({
      request: new Request("https://store.example.test/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Show these products",
          pageContext: {
            page: { path: "/categories/rice", kind: "category" },
            surface: {
              kind: "category",
              categoryId: "cat_rice",
              slug: "rice",
              visibleProductIds: [
                "prod_safe",
                "buyer@example.test",
                `prod_${"x".repeat(130)}`,
              ],
              visibleFilters: [
                { key: "brand", value: "Scalius" },
                { key: "email", value: "buyer@example.test" },
                { key: "recipient", value: "01711111111" },
                { key: "oversized", value: "x".repeat(200) },
              ],
              totalResults: 4,
              page: 1,
              customerEmail: "buyer@example.test",
            },
          },
        }),
      }),
    } as never);

    expect(response.status, await response.clone().text()).toBe(200);
    expect(forwardedSurface).toEqual({
      kind: "category",
      categoryId: "cat_rice",
      slug: "rice",
      visibleProductIds: ["prod_safe"],
      visibleFilters: [{ key: "brand", value: "Scalius" }],
      totalResults: 4,
      page: 1,
    });
    expect(JSON.stringify(forwardedSurface)).not.toContain("buyer@example.test");
    expect(JSON.stringify(forwardedSurface)).not.toContain("01711111111");
  });

  it("converts missing upstream API routes into disabled no-store responses", async () => {
    mocks.cfEnv.BACKEND_API = {
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ success: false, error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      ) as typeof fetch,
    };

    const response = await POST({
      request: new Request("https://store.example.test/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Can you help?" }),
      }),
    } as never);
    const body = (await response.json()) as { status?: string; reason?: string };

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toMatchObject({ status: "disabled", reason: "api-missing" });
  });
});
