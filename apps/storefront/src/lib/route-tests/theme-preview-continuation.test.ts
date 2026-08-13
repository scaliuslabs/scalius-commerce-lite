// @vitest-environment node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createApiUrl: vi.fn((path: string) => `https://api.example.test/api/v1${path}`),
  fetchWithRetry: vi.fn(),
}));

vi.mock("@/lib/api/client", () => mocks);
vi.mock("cloudflare:workers", () => ({
  env: { DASHBOARD_URL: "https://dashboard.example.test" },
}));

import { ALL, GET, POST } from "../../pages/theme-preview/continue";

const CONTINUATION_CODE = `tpc_${"a".repeat(48)}`;
const TOKEN = `tpv_${"b".repeat(48)}`;
const ROUTE_URL = "https://storefront.example.test/theme-preview/continue";

function context(fields: Record<string, string> = {
  continuationCode: CONTINUATION_CODE,
  path: "/search?q=lamp",
  device: "mobile",
}, origin = "https://storefront.example.test") {
  const body = new URLSearchParams(fields).toString();
  return {
    request: new Request(ROUTE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Origin": origin,
      },
      body,
    }),
    url: new URL(ROUTE_URL),
  } as never;
}

function rawContext(body: string, contentLength?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Origin": "https://storefront.example.test",
  };
  if (contentLength !== undefined) headers["Content-Length"] = contentLength;
  return {
    request: new Request(ROUTE_URL, { method: "POST", headers, body }),
    url: new URL(ROUTE_URL),
  } as never;
}

describe("theme preview continuation route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exchanges a body-only code through service auth, sets HttpOnly state, and redirects cleanly", async () => {
    mocks.fetchWithRetry.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { token: TOKEN, draftRevision: 3, basePublishedRevision: 2 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const response = await POST(context());

    expect(mocks.fetchWithRetry).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/storefront/agent-continuations/theme-preview",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ continuationCode: CONTINUATION_CODE }),
        cache: "no-store",
      },
      0,
      4_000,
      true,
      false,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("Set-Cookie")).toContain(TOKEN);
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(response.headers.get("Location")).toBe(
      "https://storefront.example.test/theme-preview?path=%2Fsearch%3Fq%3Dlamp&device=mobile",
    );
    expect(`${ROUTE_URL}${response.headers.get("Location")}`).not.toContain(CONTINUATION_CODE);
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("requires the exact storefront origin and bounded form shape", async () => {
    for (const origin of [
      "https://evil.example.test",
      "https://dashboard.example.test",
      "http://127.0.0.1:43123",
      "http://localhost:43124",
      "http://[::1]:43125",
      "http://127.0.0.1:43123/not-an-origin",
    ]) {
      await expect(POST(context(undefined, origin)))
        .resolves.toMatchObject({ status: 403 });
    }
    await expect(POST(context({
      continuationCode: CONTINUATION_CODE,
      path: "/",
      device: "mobile",
      unexpected: "value",
    }))).resolves.toMatchObject({ status: 400 });
    await expect(POST(context({
      continuationCode: CONTINUATION_CODE,
      path: `/${"a".repeat(2_100)}`,
      device: "mobile",
    }))).resolves.toMatchObject({ status: 400 });
    await expect(POST(context({
      continuationCode: CONTINUATION_CODE,
      path: "https://evil.example.test/",
      device: "mobile",
    }))).resolves.toMatchObject({ status: 400 });
    await expect(POST(rawContext("", "0"))).resolves.toMatchObject({ status: 400 });
    await expect(POST(rawContext("continuationCode=value", "2049")))
      .resolves.toMatchObject({ status: 400 });
    await expect(POST(rawContext(
      `continuationCode=${CONTINUATION_CODE}&continuationCode=${CONTINUATION_CODE}&path=%2F&device=full`,
    ))).resolves.toMatchObject({ status: 400 });
    await expect(POST(rawContext("continuationCode=value", "1")))
      .resolves.toMatchObject({ status: 400 });
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
  });

  it("serves a private relay without continuation material", async () => {
    const response = await GET({} as never);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
    expect(html).not.toContain("window.name");
    expect(html).toContain("window.opener");
    expect(html).toContain("scalius-continuation-ready-v1");
    expect(html).toContain("https://dashboard.example.test");
    expect(html).toContain("continuationCode");
    expect(html).not.toContain(CONTINUATION_CODE);
  });

  it("fails malformed, expired, and replayed continuations closed", async () => {
    await expect(POST(context({
      continuationCode: "bad",
      path: "/",
      device: "full",
    }))).resolves.toMatchObject({ status: 400 });
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();

    mocks.fetchWithRetry.mockResolvedValue(new Response(null, { status: 409 }));
    const expired = await POST(context());
    expect(expired.status).toBe(410);
    expect(expired.headers.get("Set-Cookie")).toBeNull();
  });

  it("allows only POST and never caches or leaks a referrer", async () => {
    const response = await ALL({} as never);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, POST");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("has no legacy URL-code, browser postMessage, or JSON bearer acceptance route", () => {
    const storefrontRoot = process.cwd().endsWith("apps/storefront")
      ? process.cwd()
      : resolve(process.cwd(), "apps/storefront");
    expect(existsSync(resolve(storefrontRoot, "src/pages/theme-preview/handoff.astro"))).toBe(false);
    expect(existsSync(resolve(storefrontRoot, "src/pages/theme-preview/session.ts"))).toBe(false);
    expect(existsSync(resolve(
      storefrontRoot,
      "src/pages/theme-preview/continue/[continuationId].ts",
    ))).toBe(false);
    const continuationSource = readFileSync(
      resolve(storefrontRoot, "src/pages/theme-preview/continue.ts"),
      "utf8",
    );
    expect(continuationSource).not.toMatch(/postMessage|request\.json|console\.|continue\/\$\{|continue\/\[continuationId\]/);
    expect(continuationSource).toContain('createApiUrl("/storefront/agent-continuations/theme-preview")');
  });
});
