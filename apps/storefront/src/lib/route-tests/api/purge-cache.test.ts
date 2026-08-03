import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cfEnv: { PURGE_TOKEN: "secret" },
  purgeGroups: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.cfEnv }));

function context(request: Request) {
  return {
    request,
    url: new URL(request.url),
    locals: {
      cfContext: {
        exports: { PublicStorefront: { purgeGroups: mocks.purgeGroups } },
      },
    },
  } as never;
}

describe("storefront native cache purge route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.purgeGroups.mockResolvedValue(undefined);
    mocks.cfEnv.PURGE_TOKEN = "secret";
  });

  it("rejects purge credentials in query strings", async () => {
    const { GET } = await import("../../../pages/api/purge-cache");
    const request = new Request(
      "https://shop.example/api/purge-cache?token=secret",
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
        Authorization: "Bearer secret",
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
        Authorization: "Bearer secret",
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

  it("reports native purge failures without mutating another cache layer", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.purgeGroups.mockRejectedValueOnce(new Error("purge unavailable"));
    const { POST } = await import("../../../pages/api/purge-cache");
    const request = new Request("https://shop.example/api/purge-cache", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ groups: ["products"] }),
    });
    const response = await POST(context(request));
    expect(response.status).toBe(503);
    error.mockRestore();
  });
});
