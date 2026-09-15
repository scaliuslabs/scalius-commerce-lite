import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveRuntimeSecret,
  RUNTIME_SECRET_PURPOSES,
} from "@scalius/shared/runtime-secrets";

const MASTER_SECRET = "storefront-purge-test-master-secret-0123456789abcdef";

const mocks = vi.hoisted(() => ({
  cfEnv: { SCALIUS_SECRET: undefined as string | undefined },
  purgeGroups: vi.fn(),
  fetch: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.cfEnv }));

// The purge token is never installed: it is derived from SCALIUS_SECRET with
// the same purpose label the API uses.
let secret = "";
beforeAll(async () => {
  secret = await deriveRuntimeSecret(MASTER_SECRET, RUNTIME_SECRET_PURPOSES.PURGE_TOKEN);
});

function context(request: Request) {
  return {
    request,
    url: new URL(request.url),
    locals: {
      cfContext: {
        waitUntil: mocks.waitUntil,
        exports: {
          CachedPublicStorefront: {
            purgeGroups: mocks.purgeGroups,
            fetch: mocks.fetch,
          },
        },
      },
    },
  } as never;
}

describe("storefront native cache purge route", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.purgeGroups.mockResolvedValue(undefined);
    mocks.fetch.mockResolvedValue(new Response("<html/>"));
    mocks.cfEnv.SCALIUS_SECRET = MASTER_SECRET;
  });

  it("fails closed when the master secret is missing or too short", async () => {
    const { POST } = await import("../../../pages/api/purge-cache");
    for (const value of [undefined, "", "too-short"]) {
      mocks.cfEnv.SCALIUS_SECRET = value;
      const request = new Request("https://shop.example/api/purge-cache", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ groups: ["products"] }),
      });
      const response = await POST(context(request));
      expect(response.status).toBe(500);
    }
    expect(mocks.purgeGroups).not.toHaveBeenCalled();
  });

  it("rejects the master secret itself and stale tokens as purge credentials", async () => {
    const { POST } = await import("../../../pages/api/purge-cache");
    for (const token of [MASTER_SECRET, "secret", `${secret}x`]) {
      const request = new Request("https://shop.example/api/purge-cache", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ groups: ["products"] }),
      });
      const response = await POST(context(request));
      expect(response.status).toBe(401);
    }
    expect(mocks.purgeGroups).not.toHaveBeenCalled();
  });

  it("rejects purge credentials in query strings", async () => {
    const { GET } = await import("../../../pages/api/purge-cache");
    const request = new Request(
      `https://shop.example/api/purge-cache?token=${secret}`,
    );
    const response = await GET(context(request));
    expect(response.status).toBe(400);
    expect(mocks.purgeGroups).not.toHaveBeenCalled();
  });

  it("keeps GET non-mutating", async () => {
    const { GET } = await import("../../../pages/api/purge-cache");
    const request = new Request("https://shop.example/api/purge-cache");
    const response = await GET(context(request));
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(mocks.purgeGroups).not.toHaveBeenCalled();
  });

  it("requires the purge secret", async () => {
    const { POST } = await import("../../../pages/api/purge-cache");
    const request = new Request("https://shop.example/api/purge-cache", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groups: ["products"] }),
    });
    const response = await POST(context(request));
    expect(response.status).toBe(401);
    expect(mocks.purgeGroups).not.toHaveBeenCalled();
  });

  it("rejects unbounded or empty group payloads", async () => {
    const { POST } = await import("../../../pages/api/purge-cache");
    const request = new Request("https://shop.example/api/purge-cache", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ groups: [] }),
    });
    const response = await POST(context(request));
    expect(response.status).toBe(400);
    expect(mocks.purgeGroups).not.toHaveBeenCalled();
  });

  it("purges deduplicated native cache tags", async () => {
    const { POST } = await import("../../../pages/api/purge-cache");
    const request = new Request("https://shop.example/api/purge-cache", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ groups: ["products", "layout", "products"] }),
    });
    const response = await POST(context(request));
    expect(response.status).toBe(200);
    expect(mocks.purgeGroups).toHaveBeenCalledWith(["products", "layout"]);
    await expect(response.json()).resolves.toEqual({
      success: true,
      groups: ["products", "layout"],
    });
  });

  it("warms the homepage through the cache-enabled entrypoint after a successful purge", async () => {
    vi.useFakeTimers();
    const { POST } = await import("../../../pages/api/purge-cache");
    const request = new Request("https://shop.example/api/purge-cache", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ groups: ["products"] }),
    });
    const response = await POST(context(request));
    expect(response.status).toBe(200);
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    // The warm-up waits for purge propagation before rendering.
    expect(mocks.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    await mocks.waitUntil.mock.calls[0]![0];
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const warmed = mocks.fetch.mock.calls[0]![0] as Request;
    expect(warmed.url).toBe("https://shop.example/");
  });

  it("does not warm when the purge itself fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.purgeGroups.mockRejectedValueOnce(new Error("purge unavailable"));
    const { POST } = await import("../../../pages/api/purge-cache");
    const request = new Request("https://shop.example/api/purge-cache", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ groups: ["products"] }),
    });
    await POST(context(request));
    expect(mocks.waitUntil).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("reports native purge failures without mutating another cache layer", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.purgeGroups.mockRejectedValueOnce(new Error("purge unavailable"));
    const { POST } = await import("../../../pages/api/purge-cache");
    const request = new Request("https://shop.example/api/purge-cache", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ groups: ["products"] }),
    });
    const response = await POST(context(request));
    expect(response.status).toBe(503);
    error.mockRestore();
  });
});
