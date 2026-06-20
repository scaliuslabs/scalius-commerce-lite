import { describe, expect, it } from "vitest";

import {
  appendRewrittenCustomerAuthSetCookies,
  getSetCookieHeaderValues,
  rewriteCustomerAuthSetCookie,
  splitCombinedSetCookieHeader,
} from "./customer-auth-proxy-cookies";

describe("customer auth proxy cookie handling", () => {
  it("prefers getSetCookie when the runtime exposes separate cookie headers", () => {
    const headers = new Headers({ "set-cookie": "collapsed=wrong" }) as Headers & {
      getSetCookie: () => string[];
    };
    headers.getSetCookie = () => [
      "cs_tok=secret; Path=/; HttpOnly; SameSite=None; Secure",
      "cs_auth=1; Path=/; SameSite=None; Secure",
    ];

    expect(getSetCookieHeaderValues(headers)).toEqual([
      "cs_tok=secret; Path=/; HttpOnly; SameSite=None; Secure",
      "cs_auth=1; Path=/; SameSite=None; Secure",
    ]);
  });

  it("splits combined Set-Cookie values without breaking Expires dates", () => {
    expect(
      splitCombinedSetCookieHeader(
        "cs_tok=secret; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/; HttpOnly; SameSite=None; Secure, cs_auth=1; Max-Age=2592000; Path=/; SameSite=None; Secure",
      ),
    ).toEqual([
      "cs_tok=secret; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/; HttpOnly; SameSite=None; Secure",
      "cs_auth=1; Max-Age=2592000; Path=/; SameSite=None; Secure",
    ]);
  });

  it("splits cookies when Expires is the last attribute before a combined comma", () => {
    expect(
      splitCombinedSetCookieHeader(
        "cs_tok=secret; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT, cs_auth=1; Path=/; SameSite=None",
      ),
    ).toEqual([
      "cs_tok=secret; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
      "cs_auth=1; Path=/; SameSite=None",
    ]);
  });

  it("rewrites backend cookies as host-only same-origin storefront cookies", () => {
    expect(
      rewriteCustomerAuthSetCookie(
        "cs_tok=secret; Max-Age=2592000; Path=/; Domain=.example.com; HttpOnly; SameSite=None; Secure",
      ),
    ).toBe("cs_tok=secret; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax; Secure");
  });

  it("preserves stricter SameSite policies while still stripping Domain", () => {
    expect(
      rewriteCustomerAuthSetCookie(
        "cs_tok=secret; Path=/; Domain=.example.com; HttpOnly; SameSite=Strict; Secure",
      ),
    ).toBe("cs_tok=secret; Path=/; HttpOnly; SameSite=Strict; Secure");
  });

  it("appends each rewritten customer-auth cookie to the storefront response", () => {
    const source = new Headers();
    source.append(
      "Set-Cookie",
      "cs_tok=secret; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/; Domain=.example.com; HttpOnly; SameSite=None; Secure",
    );
    source.append(
      "Set-Cookie",
      "cs_auth=1; Max-Age=2592000; Path=/; Domain=.example.com; SameSite=None; Secure",
    );

    const target = new Headers();
    appendRewrittenCustomerAuthSetCookies(target, source);

    expect(splitCombinedSetCookieHeader(target.get("set-cookie") ?? "")).toEqual([
      "cs_tok=secret; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/; HttpOnly; SameSite=Lax; Secure",
      "cs_auth=1; Max-Age=2592000; Path=/; SameSite=Lax; Secure",
    ]);
  });
});
