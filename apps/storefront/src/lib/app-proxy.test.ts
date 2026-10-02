import { describe, expect, it, vi } from "vitest";
import { APP_PROXY_MAX_BODY_BYTES, appProxyApiPath, proxyAppRequest } from "./app-proxy";

function target(response: Response) {
  const fetch = vi.fn(async (_input: string | Request, _init?: RequestInit) => response);
  return {
    fetch,
    resolve: (apiPath: string) => ({ url: `https://api.internal${apiPath}`, fetch, viaServiceBinding: true }),
  };
}

describe("storefront app proxy", () => {
  it("maps /apps/<id>/<route>/<sub path> onto the app's public route", () => {
    expect(appProxyApiPath("acme.loyalty", "points/c_1", "?x=1")).toBe("/api/v1/plugins/acme.loyalty/public/points/c_1?x=1");
    expect(appProxyApiPath("acme.loyalty", "points", "")).toBe("/api/v1/plugins/acme.loyalty/public/points");
    for (const [id, path] of [["Acme.loyalty", "points"], ["acme", "points"], ["acme.loyalty", ""], ["acme.loyalty", "Points"], ["acme.loyalty", "points/../admin"]]) {
      expect(appProxyApiPath(id!, path!, ""), `${id} ${path}`).toBeNull();
    }
  });

  it("forwards only safe request headers plus the client IP and the proxy marker, never cookies or credentials", async () => {
    const upstream = target(new Response(JSON.stringify({ points: 12 }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60", "Set-Cookie": "a=1", Location: "https://evil.example/" },
    }));
    const request = new Request("https://shop.test/apps/acme.loyalty/points?c=1", {
      headers: { Cookie: "cs_tok=secret", Authorization: "Bearer x", "Accept-Language": "bn", "cf-connecting-ip": "203.0.113.5", "x-scalius-app-proxy": "forged", "X-Other": "1" },
    });
    const response = await proxyAppRequest(request, "acme.loyalty", "points", upstream.resolve);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ points: 12 });
    const [url, init] = upstream.fetch.mock.calls[0]!;
    expect(url).toBe("https://api.internal/api/v1/plugins/acme.loyalty/public/points?c=1");
    const sent = new Headers(init!.headers);
    expect([...sent.keys()].sort()).toEqual(["accept-language", "cf-connecting-ip", "x-scalius-app-proxy"]);
    expect(sent.get("x-scalius-app-proxy")).toBe("1");
    // The API's caching decision passes; cookies and redirects never do.
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
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
