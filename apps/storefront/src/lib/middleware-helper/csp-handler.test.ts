import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../edge-cache", () => ({
  CACHE_TTL: { SHORT: 300 },
  withEdgeCache: async (_key: string, loader: () => Promise<unknown>) => loader(),
}));

import { setPageCspHeader } from "./csp-handler";

describe("setPageCspHeader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("unwraps enveloped storefront CSP settings responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { cspAllowedDomains: "payments.example.com" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await setPageCspHeader(new Response("ok"), {
      PUBLIC_API_BASE_URL: "https://api.example.com",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/api/v1/storefront/csp",
      expect.objectContaining({
        headers: { Accept: "application/json" },
      }),
    );
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "https://payments.example.com",
    );
  });
});
