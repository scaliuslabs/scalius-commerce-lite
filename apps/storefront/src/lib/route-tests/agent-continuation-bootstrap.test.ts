// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createApiUrl: vi.fn((path: string) => `https://api.example.test/api/v1${path}`),
  fetchWithRetry: vi.fn(),
}));

vi.mock("@/lib/api/client", () => mocks);

import { POST } from "../../pages/agent/continue";

const CODE = `acb_${"a".repeat(20)}_${"b".repeat(43)}`;
const ID = `acn_${"a".repeat(20)}`;
const URL = "https://storefront.example.test/agent/continue";

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

  it.each([
    "http://127.0.0.1:43123",
    "http://localhost:43123",
    "http://[::1]:43123",
    "https://storefront.example.test",
  ])("accepts the reviewed body-only handoff from %s", async (origin) => {
    const response = await POST(request(origin, "existing_storefront_cookie=value"));
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`/agent/continue/${ID}`);
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

  it.each(["https://evil.example.test", "null", "file://"])(
    "rejects an untrusted browser origin %s before exchange",
    async (origin) => {
      const response = await POST(request(origin));
      expect(response.status).toBe(403);
      expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
    },
  );
});
