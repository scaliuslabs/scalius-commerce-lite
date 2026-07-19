import { describe, expect, it } from "vitest";
import {
  isCacheablePublicResponse,
  requestHasPrivateSession,
} from "./cache-policy";

function responseWithHeaders(headers: HeadersInit, status = 200): Response {
  const response = new Response("ok", { status, headers });
  const entries = headers instanceof Headers
    ? [...headers.entries()]
    : Array.isArray(headers)
      ? headers
      : Object.entries(headers);
  const setCookieValues = entries
    .filter(([key]) => key.toLowerCase() === "set-cookie")
    .map(([, value]) => String(value));

  if (setCookieValues.length > 0) {
    const headersWithCookies = response.headers as Headers & {
      getSetCookie?: () => string[];
    };
    headersWithCookies.getSetCookie = () => setCookieValues;
  }

  return response;
}

describe("storefront cache policy", () => {
  it("keeps theme preview requests out of the shared storefront cache", () => {
    expect(requestHasPrivateSession(new Headers({
      Cookie: "other=1; stp_theme_preview=tpv_secret",
    }))).toBe(true);
    expect(requestHasPrivateSession(new Headers({ Cookie: "other=1" }))).toBe(false);
  });

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
