import { describe, expect, it } from "vitest";

import {
  FRONT_PROXY_MAX_CLOCK_SKEW_SECONDS,
  FRONT_PROXY_SIGNATURE_HEADER,
  applyTrustedFrontProxy,
  buildFrontProxySigningPayload,
  firstForwardedClientIp,
  isValidForwardedHost,
  parseFrontProxySignature,
  signFrontProxyRequest,
} from "./trusted-front-proxy";

const SECRET = "front-proxy-secret-for-tests-0123456789abcdef";
const NOW = 1_800_000_000;

async function signedRequest(overrides: {
  url?: string;
  host?: string;
  proto?: "http" | "https";
  forwardedFor?: string;
  signedClientIp?: string | null;
  timestamp?: number;
  secret?: string;
  method?: string;
  body?: string;
} = {}) {
  const url = overrides.url ?? "https://internal.workers.dev/api/v1/products?page=2";
  const host = overrides.host ?? "shop.example.com";
  const proto = overrides.proto ?? "https";
  const forwardedFor = overrides.forwardedFor ?? "203.0.113.9, 10.0.0.1";
  const signature = await signFrontProxyRequest(overrides.secret ?? SECRET, {
    timestamp: overrides.timestamp ?? NOW,
    proto,
    host,
    pathname: new URL(url).pathname,
    clientIp: overrides.signedClientIp === undefined
      ? firstForwardedClientIp(forwardedFor)
      : overrides.signedClientIp,
  });
  return new Request(url, {
    method: overrides.method ?? "GET",
    body: overrides.body,
    headers: {
      "X-Forwarded-Host": host,
      "X-Forwarded-Proto": proto,
      "X-Forwarded-For": forwardedFor,
      "cf-connecting-ip": "10.0.0.1",
      [FRONT_PROXY_SIGNATURE_HEADER]: signature,
    },
  });
}

const nowSeconds = () => NOW;

describe("front proxy signature format", () => {
  it("signs the documented newline payload and emits the v1 header shape", async () => {
    expect(buildFrontProxySigningPayload({
      timestamp: NOW,
      proto: "https",
      host: "shop.example.com",
      pathname: "/api/v1/products",
      clientIp: "203.0.113.9",
    })).toBe(`v1\n${NOW}\nhttps\nshop.example.com\n/api/v1/products\n203.0.113.9`);

    const header = await signFrontProxyRequest(SECRET, {
      timestamp: NOW,
      proto: "https",
      host: "shop.example.com",
      pathname: "/api/v1/products",
      clientIp: null,
    });
    expect(header).toMatch(/^v1,t=1800000000,s=[A-Za-z0-9_-]{43}$/);
    expect(parseFrontProxySignature(header)).toEqual({
      timestamp: NOW,
      signature: header.slice(header.indexOf(",s=") + 3),
    });
  });

  it("rejects malformed headers", () => {
    expect(parseFrontProxySignature(null)).toBeNull();
    expect(parseFrontProxySignature("")).toBeNull();
    expect(parseFrontProxySignature("v2,t=1,s=abc")).toBeNull();
    expect(parseFrontProxySignature("v1,t=abc,s=abc")).toBeNull();
    expect(parseFrontProxySignature(`v1,t=${NOW},s=short`)).toBeNull();
  });

  it("validates forwarded hosts and client IPs", () => {
    expect(isValidForwardedHost("shop.example.com")).toBe(true);
    expect(isValidForwardedHost("shop.example.com:8443")).toBe(true);
    expect(isValidForwardedHost("[2001:db8::1]:443")).toBe(true);
    expect(isValidForwardedHost("shop.example.com/evil")).toBe(false);
    expect(isValidForwardedHost("shop example.com")).toBe(false);
    expect(isValidForwardedHost("..example.com")).toBe(false);
    expect(isValidForwardedHost("")).toBe(false);

    expect(firstForwardedClientIp("203.0.113.9, 10.0.0.1")).toBe("203.0.113.9");
    expect(firstForwardedClientIp("2001:db8::1")).toBe("2001:db8::1");
    expect(firstForwardedClientIp("not-an-ip")).toBeNull();
    expect(firstForwardedClientIp("999.1.1.1")).toBeNull();
    expect(firstForwardedClientIp(null)).toBeNull();
  });
});

describe("applyTrustedFrontProxy", () => {
  it("rewrites the URL and client IP for a valid, fresh signature", async () => {
    const request = await signedRequest();
    const result = await applyTrustedFrontProxy(request, SECRET, { nowSeconds });

    expect(result.trusted).toBe(true);
    expect(result.request.url).toBe("https://shop.example.com/api/v1/products?page=2");
    expect(result.request.headers.get("cf-connecting-ip")).toBe("203.0.113.9");
    expect(result.request.method).toBe("GET");
  });

  it("keeps the method, body, and headers of the forwarded request", async () => {
    const request = await signedRequest({
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
      url: "https://internal.workers.dev/api/v1/orders",
    });
    request.headers.set("Content-Type", "application/json");
    const result = await applyTrustedFrontProxy(request, SECRET, { nowSeconds });

    expect(result.trusted).toBe(true);
    expect(result.request.method).toBe("POST");
    expect(result.request.headers.get("Content-Type")).toBe("application/json");
    await expect(result.request.text()).resolves.toBe(JSON.stringify({ hello: "world" }));
  });

  it("leaves the request untouched when no signature header is present", async () => {
    const request = new Request("https://internal.workers.dev/api/v1/products", {
      headers: { "X-Forwarded-Host": "evil.example.com", "X-Forwarded-Proto": "https" },
    });
    const result = await applyTrustedFrontProxy(request, SECRET, { nowSeconds });

    expect(result.trusted).toBe(false);
    expect(result.request).toBe(request);
    expect(result.request.url).toBe("https://internal.workers.dev/api/v1/products");
  });

  it("ignores forwarded headers when the secret is unavailable", async () => {
    const request = await signedRequest();
    const result = await applyTrustedFrontProxy(request, null, { nowSeconds });
    expect(result.trusted).toBe(false);
    expect(result.request).toBe(request);
  });

  it("rejects a signature made with another key", async () => {
    const request = await signedRequest({ secret: "another-secret-that-is-long-enough-000000" });
    const result = await applyTrustedFrontProxy(request, SECRET, { nowSeconds });
    expect(result.trusted).toBe(false);
    expect(result.request.url).toBe("https://internal.workers.dev/api/v1/products?page=2");
    expect(result.request.headers.get("cf-connecting-ip")).toBe("10.0.0.1");
  });

  it("rejects stale and future timestamps", async () => {
    const stale = await signedRequest({ timestamp: NOW - FRONT_PROXY_MAX_CLOCK_SKEW_SECONDS - 1 });
    const future = await signedRequest({ timestamp: NOW + FRONT_PROXY_MAX_CLOCK_SKEW_SECONDS + 1 });
    const edge = await signedRequest({ timestamp: NOW - FRONT_PROXY_MAX_CLOCK_SKEW_SECONDS });

    expect((await applyTrustedFrontProxy(stale, SECRET, { nowSeconds })).trusted).toBe(false);
    expect((await applyTrustedFrontProxy(future, SECRET, { nowSeconds })).trusted).toBe(false);
    expect((await applyTrustedFrontProxy(edge, SECRET, { nowSeconds })).trusted).toBe(true);
  });

  it("rejects a replayed signature whose host, path, proto, or client IP changed", async () => {
    const original = await signedRequest();
    const signature = original.headers.get(FRONT_PROXY_SIGNATURE_HEADER)!;
    const tamper = (headers: Record<string, string>, url = original.url) =>
      new Request(url, {
        headers: {
          "X-Forwarded-Host": "shop.example.com",
          "X-Forwarded-Proto": "https",
          "X-Forwarded-For": "203.0.113.9, 10.0.0.1",
          [FRONT_PROXY_SIGNATURE_HEADER]: signature,
          ...headers,
        },
      });

    const cases = [
      tamper({ "X-Forwarded-Host": "other.example.com" }),
      tamper({ "X-Forwarded-Proto": "http" }),
      tamper({ "X-Forwarded-For": "198.51.100.7" }),
      tamper({}, "https://internal.workers.dev/api/v1/orders?page=2"),
    ];
    for (const request of cases) {
      const result = await applyTrustedFrontProxy(request, SECRET, { nowSeconds });
      expect(result.trusted).toBe(false);
      expect(result.request).toBe(request);
    }
  });

  it("rejects an invalid forwarded host or proto even with a matching signature", async () => {
    const badHost = await signedRequest({ host: "shop.example.com/../admin" });
    expect((await applyTrustedFrontProxy(badHost, SECRET, { nowSeconds })).trusted).toBe(false);

    const badProto = await signedRequest();
    badProto.headers.set("X-Forwarded-Proto", "ftp");
    expect((await applyTrustedFrontProxy(badProto, SECRET, { nowSeconds })).trusted).toBe(false);
  });

  it("does not forward an unparseable client IP but still trusts the URL when signed without one", async () => {
    const request = await signedRequest({ forwardedFor: "garbage", signedClientIp: null });
    const result = await applyTrustedFrontProxy(request, SECRET, { nowSeconds });

    expect(result.trusted).toBe(true);
    expect(result.request.url).toBe("https://shop.example.com/api/v1/products?page=2");
    expect(result.request.headers.get("cf-connecting-ip")).toBe("10.0.0.1");
  });
});
