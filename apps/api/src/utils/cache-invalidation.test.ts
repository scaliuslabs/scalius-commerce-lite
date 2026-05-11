import { afterEach, describe, expect, it, vi } from "vitest";
import { triggerStorefrontPurgeForGroups } from "./cache-invalidation";

describe("triggerStorefrontPurgeForGroups", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("posts the matching storefront cache prefixes and HTML bump flag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    const waitUntil = vi.fn();

    vi.stubGlobal("fetch", fetchMock);

    triggerStorefrontPurgeForGroups(
      ["pages"],
      {
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
      } as Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(waitUntil).toHaveBeenCalledTimes(1);

    const purgePromise = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await purgePromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;

    expect(String(url)).toBe(
      "https://storefront.example.com/api/purge-cache?token=secret-token",
    );
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      groups: ["pages"],
      prefixes: ["page_slug_", "all_pages_"],
      bumpVersion: true,
    });
  });

  it("does not purge when config or valid groups are missing", () => {
    const fetchMock = vi.fn();
    const waitUntil = vi.fn();

    vi.stubGlobal("fetch", fetchMock);

    triggerStorefrontPurgeForGroups(
      ["not-a-real-group"],
      {
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
      } as Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
      { waitUntil } as unknown as ExecutionContext,
    );
    triggerStorefrontPurgeForGroups(
      ["pages"],
      {} as Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
