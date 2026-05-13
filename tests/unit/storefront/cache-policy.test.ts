import { describe, expect, it } from "vitest";
import {
  isCacheableHtmlResponse,
  requestHasPrivateSession,
} from "../../../apps/storefront/src/lib/cache-policy";

describe("storefront cache policy", () => {
  it("treats customer auth cookies as private session signals", () => {
    const headers = new Headers({
      Cookie: "_fbp=abc; cs_tok=secret; theme=dark",
    });

    expect(requestHasPrivateSession(headers)).toBe(true);
  });

  it("does not disable HTML caching for unrelated tracking cookies", () => {
    const headers = new Headers({
      Cookie: "_fbp=abc; _fbc=def; scalius_fbc=ghi",
    });

    expect(requestHasPrivateSession(headers)).toBe(false);
  });

  it("treats authorization headers as private", () => {
    const headers = new Headers({ Authorization: "Bearer token" });

    expect(requestHasPrivateSession(headers)).toBe(true);
  });

  it("rejects HTML responses that set cookies", () => {
    const response = new Response("<html></html>", {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": "cs_auth=1; Path=/",
      },
    });

    expect(isCacheableHtmlResponse(response)).toBe(false);
  });

  it("respects no-store/private response cache directives", () => {
    const noStore = new Response("<html></html>", {
      status: 200,
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": "private, no-store",
      },
    });

    expect(isCacheableHtmlResponse(noStore)).toBe(false);
  });

  it("allows public HTML without cookies", () => {
    const response = new Response("<html></html>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });

    expect(isCacheableHtmlResponse(response)).toBe(true);
  });
});
