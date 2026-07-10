import { describe, expect, it, vi } from "vitest";

import { createAdminFlueAuthorityResolver } from "./-authority";

const NOW = 1_800_000_000_000;
const COOKIE = "better-auth.session_token=session.signature";
const THREAD_ID = `conv_${"t".repeat(22)}`;
const INSTANCE_ID = `v1.${"i".repeat(43)}`;
const TENANT_ID = `tenant_${"n".repeat(43)}`;
const PRINCIPAL_ID = `principal_${"p".repeat(43)}`;

function browserRequest(cookie = COOKIE): Request {
  return new Request("https://dashboard.test/api/assistant/flue/computer/results", {
    method: "POST",
    headers: { Cookie: cookie },
  });
}

function admission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: true,
    data: {
      agent: {
        surface: "admin",
        instanceId: INSTANCE_ID,
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_ID,
        threadId: THREAD_ID,
        expiresAt: NOW + 60_000,
        ...overrides,
      },
    },
  };
}

describe("Admin Flue API authority resolver", () => {
  it("forwards only the dashboard cookie and requested opaque thread", async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "http://api.internal/api/v1/internal/admin-assistant/flue/admit",
      );
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect([...new Headers(init?.headers).entries()]).toEqual([
        ["accept", "application/json"],
        ["content-type", "application/json"],
        ["cookie", COOKIE],
      ]);
      await expect(new Response(init?.body).json()).resolves.toEqual({ threadId: THREAD_ID });
      return Response.json(admission());
    });
    const resolver = createAdminFlueAuthorityResolver({
      api: { fetch: apiFetch },
      now: () => NOW,
      timeoutSignal: () => new AbortController().signal,
    });

    await expect(resolver({
      request: browserRequest(),
      requestedThreadId: THREAD_ID,
    })).resolves.toEqual({
      ok: true,
      authority: {
        surface: "admin",
        instanceId: INSTANCE_ID,
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_ID,
        threadId: THREAD_ID,
      },
    });
    expect(apiFetch).toHaveBeenCalledOnce();
  });

  it.each([
    [401, "unauthenticated"],
    [403, "forbidden"],
    [404, "unavailable"],
    [503, "unavailable"],
  ] as const)("maps API %s to %s without reading authority", async (status, reason) => {
    const resolver = createAdminFlueAuthorityResolver({
      api: { fetch: vi.fn(async () => new Response(null, { status })) },
      timeoutSignal: () => new AbortController().signal,
    });
    await expect(resolver({ request: browserRequest(), requestedThreadId: THREAD_ID }))
      .resolves.toEqual({ ok: false, reason });
  });

  it("fails closed without a binding, cookie, or valid thread", async () => {
    const apiFetch = vi.fn();
    const withoutBinding = createAdminFlueAuthorityResolver({});
    await expect(withoutBinding({ request: browserRequest(), requestedThreadId: THREAD_ID }))
      .resolves.toEqual({ ok: false, reason: "unavailable" });

    const resolver = createAdminFlueAuthorityResolver({ api: { fetch: apiFetch } });
    await expect(resolver({ request: browserRequest(""), requestedThreadId: THREAD_ID }))
      .resolves.toEqual({ ok: false, reason: "unauthenticated" });
    await expect(resolver({ request: browserRequest(), requestedThreadId: "forged-thread" }))
      .resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it.each([
    admission({ surface: "storefront" }),
    admission({ threadId: `conv_${"x".repeat(22)}` }),
    admission({ instanceId: "v1.short" }),
    admission({ tenantId: "tenant_public" }),
    admission({ principalId: "principal_public" }),
    admission({ expiresAt: NOW }),
    { ...admission(), unexpected: true },
    { success: true, data: { agent: { ...admission().data as object }, leaked: true } },
    { success: false, data: admission().data },
  ])("rejects malformed, mismatched, expired, or expanded admission envelopes", async (body) => {
    const resolver = createAdminFlueAuthorityResolver({
      api: { fetch: vi.fn(async () => Response.json(body)) },
      now: () => NOW,
      timeoutSignal: () => new AbortController().signal,
    });
    await expect(resolver({ request: browserRequest(), requestedThreadId: THREAD_ID }))
      .resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("bounds and sanitizes malformed, oversized, and failed API responses", async () => {
    for (const reply of [
      async () => new Response("not-json", { status: 200 }),
      async () => new Response(JSON.stringify({ padding: "x".repeat(5_000) }), { status: 200 }),
      async () => { throw new Error("private API failure"); },
    ]) {
      const resolver = createAdminFlueAuthorityResolver({
        api: { fetch: vi.fn(reply) },
        timeoutSignal: () => new AbortController().signal,
      });
      await expect(resolver({ request: browserRequest(), requestedThreadId: THREAD_ID }))
        .resolves.toEqual({ ok: false, reason: "unavailable" });
    }
  });
});
