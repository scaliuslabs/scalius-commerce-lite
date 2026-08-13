// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createApiUrl: vi.fn((path: string) => `https://api.example.test/api/v1${path}`),
  fetchWithRetry: vi.fn(),
}));

vi.mock("@/lib/api/client", () => mocks);

import { GET, POST } from "../../pages/checkout/continue";
import {
  isBrowserContinuationRelayPathname,
  isForbiddenStorefrontCrossOriginFormRequest,
} from "../browser-continuation-relay";

const CODE = `acb_${"a".repeat(20)}_${"b".repeat(43)}`;
const ID = `acn_${"a".repeat(20)}`;
const URL = "https://storefront.example.test/checkout/continue";

function request(origin: string, cookie?: string) {
  const headers: Record<string, string> = {
    Origin: origin,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (cookie) headers.Cookie = cookie;
  return {
    request: new Request(URL, {
      method: "POST",
      headers,
      body: new URLSearchParams({ continuationCode: CODE }),
    }),
  } as never;
}

describe("agent storefront body-only bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchWithRetry.mockResolvedValue(Response.json({
      success: true,
      data: { id: ID, expiresAt: new Date(Date.now() + 600_000).toISOString() },
    }));
  });

  it("accepts the reviewed same-origin body-only handoff", async () => {
    const origin = "https://storefront.example.test";
    const response = await POST(request(origin, "existing_storefront_cookie=value"));
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`/checkout/continue/${ID}`);
    expect(response.headers.get("Location")).not.toContain(CODE);
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(mocks.fetchWithRetry).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/storefront/agent-continuations/bootstrap",
      expect.objectContaining({ body: JSON.stringify({ continuationCode: CODE }) }),
      0,
      12_000,
      true,
      false,
    );
  });

  it.each([
    "http://127.0.0.1:43123",
    "http://localhost:43124",
    "http://[::1]:43125",
  ])("accepts a body-only handoff from an ephemeral CLI loopback origin %s", async (origin) => {
    const response = await POST(request(origin));
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`/checkout/continue/${ID}`);
    expect(response.headers.get("Location")).not.toContain(CODE);
    expect(mocks.fetchWithRetry).toHaveBeenCalledOnce();
  });

  it.each([
    "https://evil.example.test",
    "http://evil.example.test:43123",
    "http://127.0.0.1:43123/not-an-origin",
    "null",
    "file://",
  ])(
    "rejects an untrusted browser origin %s before exchange",
    async (origin) => {
      const response = await POST(request(origin));
      expect(response.status).toBe(403);
      expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
    },
  );

  it("serves a private relay that clears window.name before same-origin submission", async () => {
    const response = await GET({} as never);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
    expect(html).toContain('const raw = window.name;');
    expect(html).toContain('window.name = "";');
    expect(html).toContain('form.method = "post";');
    expect(html).toContain('button.textContent = "Continue securely";');
    expect(html).toContain("form.submit();");
    expect(html).not.toContain(CODE);
  });

  it("identifies only the exact private relay paths", () => {
    expect(isBrowserContinuationRelayPathname("/checkout/continue")).toBe(true);
    expect(isBrowserContinuationRelayPathname("/agent/continue")).toBe(true);
    expect(isBrowserContinuationRelayPathname("/theme-preview/continue")).toBe(true);
    expect(isBrowserContinuationRelayPathname("/checkout/continue/anything")).toBe(false);
    expect(isBrowserContinuationRelayPathname("/agent/continue/anything")).toBe(false);
    expect(isBrowserContinuationRelayPathname("/")).toBe(false);
  });

  it("preserves Astro's cross-origin form protection for every ordinary route", () => {
    const ordinaryUrl = "https://storefront.example.test/api/checkout";
    expect(isForbiddenStorefrontCrossOriginFormRequest(new Request(ordinaryUrl, {
      method: "POST",
      headers: {
        Origin: "https://evil.example.test",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "value=1",
    }))).toBe(true);
    expect(isForbiddenStorefrontCrossOriginFormRequest(new Request(ordinaryUrl, {
      method: "POST",
      headers: {
        Origin: "https://storefront.example.test",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "value=1",
    }))).toBe(false);
    expect(isForbiddenStorefrontCrossOriginFormRequest(new Request(ordinaryUrl, {
      method: "POST",
      headers: {
        Origin: "https://evil.example.test",
        "Content-Type": "application/json",
      },
      body: "{}",
    }))).toBe(false);
    expect(isForbiddenStorefrontCrossOriginFormRequest(new Request(ordinaryUrl, {
      method: "POST",
      headers: { Origin: "https://evil.example.test" },
    }))).toBe(true);
    expect(isForbiddenStorefrontCrossOriginFormRequest(new Request(ordinaryUrl, {
      method: "GET",
      headers: { Origin: "https://evil.example.test" },
    }))).toBe(false);
  });
});
