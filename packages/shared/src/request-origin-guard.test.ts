import { describe, expect, it } from "vitest";

import { shouldRejectCrossOriginCookieRequest } from "./request-origin-guard";

function request(
  method: string,
  headers: HeadersInit,
): Request {
  return new Request("https://storefront.example.test/api/customer-auth/logout", {
    method,
    headers,
  });
}

describe("shouldRejectCrossOriginCookieRequest", () => {
  it("rejects unsafe cookie requests from another browser origin", () => {
    expect(shouldRejectCrossOriginCookieRequest(request("POST", {
      Cookie: "cs_tok=session",
      Origin: "https://evil.example.test",
    }))).toBe(true);
  });

  it("allows unsafe cookie requests from the same origin", () => {
    expect(shouldRejectCrossOriginCookieRequest(request("POST", {
      Cookie: "cs_tok=session",
      Origin: "https://storefront.example.test",
    }))).toBe(false);
  });

  it("allows safe methods, no-cookie requests, and server-to-server requests without Origin", () => {
    expect(shouldRejectCrossOriginCookieRequest(request("GET", {
      Cookie: "cs_tok=session",
      Origin: "https://evil.example.test",
    }))).toBe(false);
    expect(shouldRejectCrossOriginCookieRequest(request("POST", {
      Origin: "https://evil.example.test",
    }))).toBe(false);
    expect(shouldRejectCrossOriginCookieRequest(request("POST", {
      Cookie: "cs_tok=session",
    }))).toBe(false);
  });

  it("rejects malformed browser Origin values when cookies are present", () => {
    expect(shouldRejectCrossOriginCookieRequest(request("DELETE", {
      Cookie: "cs_tok=session",
      Origin: "not a url",
    }))).toBe(true);
  });
});
