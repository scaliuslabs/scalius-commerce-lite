import { afterEach, describe, expect, it, vi } from "vitest";

import { partytownProxyRoutes } from "./partytown-proxy";

function createEnv(): Env {
  return {
    CSP_ALLOWED: "analytics.tiktok.com",
  } as unknown as Env;
}

describe("partytown proxy route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows configured http and https analytics script URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("console.log('pixel')", {
        headers: { "Content-Type": "application/javascript" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const target = "https://analytics.tiktok.com/i18n/pixel/events.js";
    const response = await partytownProxyRoutes.request(
      `/?url=${encodeURIComponent(target)}`,
      {},
      createEnv(),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ redirect: "follow" }),
    );
  });

  it("rejects allowed hosts when the target protocol is not http or https", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const target = "ftp://analytics.tiktok.com/i18n/pixel/events.js";
    const response = await partytownProxyRoutes.request(
      `/?url=${encodeURIComponent(target)}`,
      {},
      createEnv(),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Proxying this protocol is not allowed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
