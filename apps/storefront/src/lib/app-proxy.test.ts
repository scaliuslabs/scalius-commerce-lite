import { describe, expect, it, vi } from "vitest";
import {
  APP_PROXY_MAX_BODY_BYTES,
  answerAppProxyRequest,
  appProxyApiPath,
  appProxySessionCookie,
  isAppPageNavigation,
  proxyAppRequest,
  resolveAppProxyAnswer,
  sameStoreRedirectPath,
} from "./app-proxy";

function target(response: Response | (() => Response)) {
  const fetch = vi.fn(async (_input: string | Request, _init?: RequestInit) => typeof response === "function" ? response() : response);
  return {
    fetch,
    resolve: (apiPath: string) => ({ url: `https://api.internal${apiPath}`, fetch, viaServiceBinding: true }),
  };
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), {
  ...init,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(init.headers ?? {}) },
});

describe("storefront app proxy", () => {
  it("maps /apps/<id>/<route>/<sub path> onto the app's public route", () => {
    expect(appProxyApiPath("acme.loyalty", "points/c_1", "?x=1")).toBe("/api/v1/plugins/acme.loyalty/public/points/c_1?x=1");
    expect(appProxyApiPath("acme.loyalty", "points", "")).toBe("/api/v1/plugins/acme.loyalty/public/points");
    for (const [id, path] of [["Acme.loyalty", "points"], ["acme", "points"], ["acme.loyalty", ""], ["acme.loyalty", "Points"], ["acme.loyalty", "points/../admin"]]) {
      expect(appProxyApiPath(id!, path!, ""), `${id} ${path}`).toBeNull();
    }
  });

  it("forwards only safe request headers, the client IP, the proxy marker and the store's session cookie", async () => {
    const upstream = target(() => new Response(JSON.stringify({ points: 12 }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60", "Set-Cookie": "a=1", Location: "https://evil.example/" },
    }));
    const request = new Request("https://shop.test/apps/acme.loyalty/points?c=1", {
      headers: { Cookie: "_ga=GA1.2; cs_tok=secret; cs_auth=1", Authorization: "Bearer x", "Accept-Language": "bn", "cf-connecting-ip": "203.0.113.5", "x-scalius-app-proxy": "forged", "X-Other": "1" },
    });
    const response = await proxyAppRequest(request, "acme.loyalty", "points", upstream.resolve);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ points: 12 });
    const [url, init] = upstream.fetch.mock.calls[0]!;
    expect(url).toBe("https://api.internal/api/v1/plugins/acme.loyalty/public/points?c=1");
    const sent = new Headers(init!.headers);
    expect([...sent.keys()].sort()).toEqual(["accept-language", "cf-connecting-ip", "cookie", "x-scalius-app-proxy"]);
    expect(sent.get("x-scalius-app-proxy")).toBe("1");
    // Only the session cookie, as the browser sent it; never analytics or other cookies.
    expect(sent.get("cookie")).toBe("cs_tok=secret");
    // An answer for a signed-in buyer is private; cookies and redirects never pass.
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    // A guest's answer keeps the API's caching decision, and no cookie crosses.
    const guest = await proxyAppRequest(
      new Request("https://shop.test/apps/acme.loyalty/points", { headers: { Cookie: "_ga=GA1.2; _fbp=fb.1" } }),
      "acme.loyalty",
      "points",
      upstream.resolve,
    );
    expect(guest.headers.get("cache-control")).toBe("public, max-age=60");
    expect(new Headers(upstream.fetch.mock.calls[1]![1]!.headers).has("cookie")).toBe(false);
  });

  it("forwards the session on unsafe methods only from the store's own pages", () => {
    const post = (headers: Record<string, string>) => new Request("https://shop.test/apps/acme.loyalty/join", {
      method: "POST",
      headers: { Cookie: "cs_tok=tok_1", "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: "a=1",
    });
    expect(appProxySessionCookie(post({ "Sec-Fetch-Site": "same-origin" }))).toBe("cs_tok=tok_1");
    expect(appProxySessionCookie(post({ "Sec-Fetch-Site": "none" }))).toBe("cs_tok=tok_1");
    expect(appProxySessionCookie(post({ Origin: "https://shop.test" }))).toBe("cs_tok=tok_1");
    // Another site, a sibling subdomain, or no proof of origin: no session.
    expect(appProxySessionCookie(post({ "Sec-Fetch-Site": "cross-site", Origin: "https://shop.test" }))).toBeNull();
    expect(appProxySessionCookie(post({ "Sec-Fetch-Site": "same-site" }))).toBeNull();
    expect(appProxySessionCookie(post({ Origin: "https://evil.example" }))).toBeNull();
    expect(appProxySessionCookie(post({}))).toBeNull();
    // GET and HEAD always carry it; a malformed or missing value never.
    expect(appProxySessionCookie(new Request("https://shop.test/apps/a.b/x", { headers: { Cookie: "cs_tok=tok_2" } }))).toBe("cs_tok=tok_2");
    expect(appProxySessionCookie(new Request("https://shop.test/apps/a.b/x", { method: "HEAD", headers: { Cookie: "xcs_tok=1; cs_tok=tok_3" } }))).toBe("cs_tok=tok_3");
    expect(appProxySessionCookie(new Request("https://shop.test/apps/a.b/x", { headers: { Cookie: "xcs_tok=1" } }))).toBeNull();
    expect(appProxySessionCookie(new Request("https://shop.test/apps/a.b/x", { headers: { Cookie: 'cs_tok="a b"' } }))).toBeNull();
  });

  it("sends no session upstream for a cross-site unsafe request", async () => {
    const upstream = target(() => new Response(null, { status: 204 }));
    await proxyAppRequest(new Request("https://shop.test/apps/acme.loyalty/join", {
      method: "POST",
      headers: { Cookie: "cs_tok=tok_1", "Content-Type": "application/json", Origin: "https://evil.example" },
      body: "{}",
    }), "acme.loyalty", "join", upstream.resolve);
    expect(new Headers(upstream.fetch.mock.calls[0]![1]!.headers).has("cookie")).toBe(false);
  });

  it("forwards a capped body, defaults to no-store and fails closed without the API", async () => {
    const upstream = target(new Response(null, { status: 204 }));
    const post = new Request("https://shop.test/apps/acme.loyalty/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Rina" }) });
    const response = await proxyAppRequest(post, "acme.loyalty", "join", upstream.resolve);
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [, init] = upstream.fetch.mock.calls[0]!;
    expect(new TextDecoder().decode(init!.body as ArrayBuffer)).toBe(JSON.stringify({ name: "Rina" }));

    const huge = new Request("https://shop.test/apps/acme.loyalty/join", { method: "POST", body: "x".repeat(APP_PROXY_MAX_BODY_BYTES + 1) });
    expect((await proxyAppRequest(huge, "acme.loyalty", "join", upstream.resolve)).status).toBe(413);
    expect((await proxyAppRequest(new Request("https://shop.test/apps/acme.loyalty/x"), "acme.loyalty", "x", () => null)).status).toBe(503);
    expect((await proxyAppRequest(new Request("https://shop.test/apps/bad/x"), "bad", "x", upstream.resolve)).status).toBe(404);
    expect((await proxyAppRequest(new Request("https://shop.test/apps/acme.loyalty/x", { method: "OPTIONS" }), "acme.loyalty", "x", upstream.resolve)).status).toBe(405);
  });
});

describe("storefront app proxy pages", () => {
  const page = { page: { title: "Your wishlist", html: "<p>Saved</p>", index: false } };

  it("treats HTML GETs and plain form posts as navigations, never JSON or script calls", () => {
    const at = "https://shop.test/apps/acme.wishlist/toggle";
    expect(isAppPageNavigation(new Request(at, { headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" } }))).toBe(true);
    expect(isAppPageNavigation(new Request(at, { headers: { Accept: "application/json" } }))).toBe(false);
    expect(isAppPageNavigation(new Request(at))).toBe(false);
    expect(isAppPageNavigation(new Request(at, { method: "HEAD", headers: { Accept: "text/html" } }))).toBe(false);
    const form = (accept: string, type = "application/x-www-form-urlencoded") =>
      new Request(at, { method: "POST", headers: { Accept: accept, "Content-Type": type }, body: "a=1" });
    expect(isAppPageNavigation(form("text/html,*/*"))).toBe(true);
    expect(isAppPageNavigation(form("application/json"))).toBe(false);
    expect(isAppPageNavigation(form("text/html", "application/json"))).toBe(false);
  });

  it("draws a page answer, keeping the app's status", async () => {
    const navigation = new Request("https://shop.test/apps/acme.wishlist/wishlist", { headers: { Accept: "text/html" } });
    const answer = await resolveAppProxyAnswer(navigation, json(page));
    expect(answer).toEqual({ kind: "page", page: page.page, status: 200 });
    const missing = await resolveAppProxyAnswer(navigation, json(page, { status: 404 }));
    expect(missing.kind === "page" && missing.status).toBe(404);
  });

  it("turns a redirect answer into a 303 to a path on this store only", async () => {
    const post = new Request("https://shop.test/apps/acme.wishlist/toggle", {
      method: "POST",
      headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
      body: "productId=p1",
    });
    const answer = await resolveAppProxyAnswer(post, json({ redirect: "/products/linen?saved=1" }));
    expect(answer.kind).toBe("response");
    const response = (answer as { response: Response }).response;
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/products/linen?saved=1");
    expect(response.headers.get("cache-control")).toBe("no-store");

    for (const redirect of ["//evil.example/x", "/\\evil.example", "https://evil.example/", "javascript:alert(1)", "/a b"]) {
      const body = JSON.stringify({ redirect });
      const passed = await resolveAppProxyAnswer(post, new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }));
      expect(passed.kind, redirect).toBe("response");
      const out = (passed as { response: Response }).response;
      expect(out.status, redirect).toBe(200);
      expect(out.headers.get("location"), redirect).toBeNull();
      expect(await out.text(), redirect).toBe(body);
    }
    expect(sameStoreRedirectPath("/account", "https://shop.test")).toBe("/account");
    expect(sameStoreRedirectPath("//evil.example", "https://shop.test")).toBeNull();
    expect(sameStoreRedirectPath("/x\u0000y", "https://shop.test")).toBeNull();
  });

  it("passes JSON, errors and non-navigation answers through byte for byte", async () => {
    const navigation = new Request("https://shop.test/apps/acme.wishlist/state", { headers: { Accept: "text/html" } });
    const body = JSON.stringify({ pressed: true });
    const plainJson = await resolveAppProxyAnswer(navigation, new Response(body, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" } }));
    expect(plainJson.kind).toBe("response");
    const passed = (plainJson as { response: Response }).response;
    expect(await passed.text()).toBe(body);
    expect(passed.headers.get("cache-control")).toBe("public, max-age=30");

    const error = JSON.stringify({ success: false, error: { code: "APP_PROXY", message: "The app could not be reached." } });
    const failed = await resolveAppProxyAnswer(navigation, new Response(error, { status: 502, headers: { "Content-Type": "application/json" } }));
    expect((failed as { response: Response }).response.status).toBe(502);
    expect(await (failed as { response: Response }).response.text()).toBe(error);

    // A script asking for JSON gets the app's page JSON as it is.
    const script = new Request("https://shop.test/apps/acme.wishlist/wishlist", { headers: { Accept: "application/json" } });
    const raw = json(page);
    expect(await resolveAppProxyAnswer(script, raw)).toEqual({ kind: "response", response: raw });
  });

  it("proxies and reads a navigation in one call", async () => {
    const upstream = target(() => json(page));
    const answer = await answerAppProxyRequest(
      new Request("https://shop.test/apps/acme.wishlist/wishlist", { headers: { Accept: "text/html", Cookie: "cs_tok=tok_9" } }),
      "acme.wishlist",
      "wishlist",
      upstream.resolve,
    );
    expect(answer.kind).toBe("page");
    expect(new Headers(upstream.fetch.mock.calls[0]![1]!.headers).get("cookie")).toBe("cs_tok=tok_9");
  });

  it("keeps a bodiless 404 or 500 the API's own (never the store's error page)", async () => {
    const missing = target(() => json({ success: false }, { status: 404 }));
    const head = await answerAppProxyRequest(new Request("https://shop.test/apps/acme.loyalty/points", { method: "HEAD" }), "acme.loyalty", "points", missing.resolve);
    const response = (head as { response: Response }).response;
    expect(response.status).toBe(404);
    expect(response.body).not.toBeNull();
    expect(response.headers.get("content-type")).toContain("application/json");
    const empty = target(() => new Response(null, { status: 204 }));
    const noContent = await answerAppProxyRequest(new Request("https://shop.test/apps/acme.loyalty/points", { method: "HEAD" }), "acme.loyalty", "points", empty.resolve);
    expect((noContent as { response: Response }).response.status).toBe(204);
  });
});
