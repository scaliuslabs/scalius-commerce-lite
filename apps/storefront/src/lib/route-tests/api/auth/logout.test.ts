// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rejectCrossOrigin: true,
}));

vi.mock("@scalius/shared/request-origin-guard", () => ({
  shouldRejectCrossOriginCookieRequest: () => mocks.rejectCrossOrigin,
}));

import { requestRuntime } from "@/lib/api/runtime";
import { getOrderReceiptCookieName, getOrderReceiptFinalizeCookieName } from "@/lib/order-receipt-cookie";
import { POST } from "../../../../pages/api/auth/logout";

beforeEach(() => {
  mocks.rejectCrossOrigin = true;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("logout proxy Origin guard", () => {
  it("rejects cross-origin cookie logout requests before clearing cookies", async () => {
    const response = await POST({
      request: new Request("https://storefront.example.test/api/auth/logout", {
        method: "POST",
        headers: {
          Cookie: "cs_tok=session",
          Origin: "https://evil.example.test",
        },
      }),
    } as never);

    expect(response.status).toBe(403);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("logout proxy backend revocation", () => {
  it("revokes through the service binding with the internal origin in production", async () => {
    vi.stubEnv("DEV", false);
    mocks.rejectCrossOrigin = false;
    const bindingFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const httpFetch = vi.fn();
    vi.stubGlobal("fetch", httpFetch);

    const response = await requestRuntime.run(
      { BACKEND_API: { fetch: bindingFetch } as unknown as Fetcher },
      () => POST({
        request: new Request("https://storefront.example.test/api/auth/logout", {
          method: "POST",
          headers: { Cookie: "cs_tok=session", Origin: "https://storefront.example.test" },
        }),
      } as never),
    );

    expect(response.status).toBe(200);
    expect(bindingFetch).toHaveBeenCalledWith(
      "https://api.internal/api/v1/customer-auth/logout",
      expect.objectContaining({ method: "POST", headers: { Cookie: "cs_tok=session" } }),
    );
    expect(httpFetch).not.toHaveBeenCalled();
    expect(response.headers.get("Set-Cookie")).toContain("cs_tok=; Max-Age=0");
  });

  it("still clears cookies when no backend target is available in production", async () => {
    vi.stubEnv("DEV", false);
    mocks.rejectCrossOrigin = false;
    const httpFetch = vi.fn();
    vi.stubGlobal("fetch", httpFetch);

    const response = await POST({
      request: new Request("https://storefront.example.test/api/auth/logout", {
        method: "POST",
        headers: { Cookie: "cs_tok=session", Origin: "https://storefront.example.test" },
      }),
    } as never);

    expect(response.status).toBe(200);
    expect(httpFetch).not.toHaveBeenCalled();
    expect(response.headers.get("Set-Cookie")).toContain("cs_tok=; Max-Age=0");
  });

  it("expires every receipt on this device and its checkout marker, so a shared phone shows no previous buyer", async () => {
    vi.stubEnv("DEV", false);
    mocks.rejectCrossOrigin = false;
    const receiptA = getOrderReceiptCookieName("JJEHCFQ3C1JJ35GX");
    const receiptB = getOrderReceiptCookieName("order/with spaces");

    const response = await POST({
      request: new Request("https://storefront.example.test/api/auth/logout", {
        method: "POST",
        headers: {
          Cookie: `cs_tok=session; ${receiptA}=token-a; theme=dark; ${receiptB}=token-b`,
          Origin: "https://storefront.example.test",
        },
      }),
    } as never);

    const cleared = response.headers.getSetCookie();
    expect(cleared).toEqual([
      "cs_tok=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure",
      "cs_auth=; Max-Age=0; Path=/; SameSite=Lax; Secure",
      `${receiptA}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
      `${getOrderReceiptFinalizeCookieName("JJEHCFQ3C1JJ35GX")}=; Max-Age=0; Path=/order-success; HttpOnly; Secure; SameSite=Lax`,
      `${receiptB}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
      `${getOrderReceiptFinalizeCookieName("order/with spaces")}=; Max-Age=0; Path=/order-success; HttpOnly; Secure; SameSite=Lax`,
    ]);
    expect(cleared.join("\n")).not.toMatch(/token-|theme/);
  });
});
