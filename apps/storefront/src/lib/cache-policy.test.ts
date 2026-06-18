import { describe, expect, it } from "vitest";
import { isCacheablePublicResponse } from "./cache-policy";

function responseWithHeaders(headers: HeadersInit, status = 200): Response {
  return new Response("ok", { status, headers });
}

describe("storefront cache policy", () => {
  it("allows public HTML, XML, XSLT, and text responses", () => {
    for (const contentType of [
      "text/html; charset=utf-8",
      "application/xml; charset=utf-8",
      "text/xml",
      "application/xslt+xml; charset=utf-8",
      "text/plain; charset=utf-8",
    ]) {
      expect(
        isCacheablePublicResponse(
          responseWithHeaders({
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=3600",
          }),
        ),
      ).toBe(true);
    }
  });

  it("rejects non-public, cookie-setting, non-OK, and unrelated responses", () => {
    expect(
      isCacheablePublicResponse(
        responseWithHeaders({
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600",
        }),
      ),
    ).toBe(false);
    expect(
      isCacheablePublicResponse(
        responseWithHeaders({
          "Content-Type": "application/xml",
          "Cache-Control": "private, max-age=3600",
        }),
      ),
    ).toBe(false);
    expect(
      isCacheablePublicResponse(
        responseWithHeaders({
          "Content-Type": "application/xml",
          "Cache-Control": "public, no-store",
        }),
      ),
    ).toBe(false);
    expect(
      isCacheablePublicResponse(
        responseWithHeaders({
          "Content-Type": "application/xml",
          "Cache-Control": "public, max-age=3600",
          "Set-Cookie": "cs_tok=secret",
        }),
      ),
    ).toBe(false);
    expect(
      isCacheablePublicResponse(
        responseWithHeaders({
          "Content-Type": "application/xml",
          "Cache-Control": "public, max-age=3600",
        }, 404),
      ),
    ).toBe(false);
  });
});
