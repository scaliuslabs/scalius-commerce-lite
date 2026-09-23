import { describe, expect, it } from "vitest";
import {
  requestBypassesPublicStorefrontCache,
  requestHasPrivateSession,
  toPublicCacheRequest,
} from "./cache-policy";

describe("storefront cache policy", () => {
  it("keeps theme preview requests out of the shared storefront cache", () => {
    expect(requestHasPrivateSession(new Headers({
      Cookie: "other=1; stp_theme_preview=tpv_secret",
    }))).toBe(true);
    expect(requestHasPrivateSession(new Headers({ Cookie: "other=1" }))).toBe(false);
  });

  it("aligns speculative prefetch suppression with every public-cache bypass signal", () => {
    expect(requestBypassesPublicStorefrontCache(new Headers())).toBe(false);
    // Analytics, ad-click, and receipt cookies never change a public render, so
    // they must not push the visitor onto the uncached lane.
    expect(
      requestBypassesPublicStorefrontCache(new Headers({ Cookie: "_fbc=click; _fbp=fb.1.1; _ga=GA1.1" })),
    ).toBe(false);
    expect(
      requestBypassesPublicStorefrontCache(
        new Headers({ Cookie: "order_receipt=proof" }),
      ),
    ).toBe(false);
    expect(
      requestBypassesPublicStorefrontCache(new Headers({ Cookie: "_fbp=fb.1.1; cs_tok=secret" })),
    ).toBe(true);
    expect(
      requestBypassesPublicStorefrontCache(new Headers({ Cookie: "cs_auth=1" })),
    ).toBe(true);
    expect(
      requestBypassesPublicStorefrontCache(new Headers({ Cookie: "stp_theme_preview=tpv" })),
    ).toBe(true);
    expect(
      requestBypassesPublicStorefrontCache(
        new Headers({ Authorization: "Bearer token" }),
      ),
    ).toBe(true);
    expect(
      requestBypassesPublicStorefrontCache(
        new Headers({ "X-API-Token": "token" }),
      ),
    ).toBe(true);
  });

  it("renders the public cache lane from a cookie-free canonical request", () => {
    // Node's Request drops Cookie on construction, so model the Worker request.
    const headers = new Headers({
      Cookie: "_fbp=fb.1.1; _ga=GA1.1",
      Accept: "text/html",
      "Accept-Language": "bn",
    });
    const request = {
      url: "https://shop.example/products/fish?fbclid=abc",
      method: "GET",
      headers,
      redirect: "follow",
    } as unknown as Request;
    const cacheRequest = toPublicCacheRequest(request, "https://shop.example/products/fish");
    expect(cacheRequest.url).toBe("https://shop.example/products/fish");
    expect(cacheRequest.method).toBe("GET");
    expect(cacheRequest.headers.has("Cookie")).toBe(false);
    expect(cacheRequest.headers.get("Accept-Language")).toBe("bn");
    expect(headers.get("Cookie")).toBe("_fbp=fb.1.1; _ga=GA1.1");
  });
});
