import { beforeEach, describe, expect, it, vi } from "vitest";

import { runSeoDiscoveryLiveProbe } from "./seo-discovery-live-probe";

const mocks = vi.hoisted(() => ({
  getStorefrontUrl: vi.fn(),
}));

function storefrontUrlLookup() {
  return mocks.getStorefrontUrl();
}

function textResponse(
  body: string,
  init?: { status?: number; contentType?: string; cacheControl?: string },
) {
  const headers = new Headers();
  if (init?.contentType) headers.set("content-type", init.contentType);
  if (init?.cacheControl) headers.set("cache-control", init.cacheControl);
  return new Response(body, {
    status: init?.status ?? 200,
    headers,
  });
}

describe("runSeoDiscoveryLiveProbe", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not fetch live URLs when the Store URL is not absolute http(s)", async () => {
    mocks.getStorefrontUrl.mockResolvedValue({ storefrontUrl: "/local-store" });
    const fetchMock = vi.fn();

    const result = await runSeoDiscoveryLiveProbe({
      fetch: fetchMock as unknown as typeof fetch,
      getStorefrontUrl: storefrontUrlLookup,
      now: () => new Date("2026-07-06T00:00:00.000Z"),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      baseUrl: null,
      checkedAt: "2026-07-06T00:00:00.000Z",
      ok: false,
      error: "Store URL must be an absolute http(s) URL.",
      resources: [],
    });
  });

  it("probes only the fixed discovery paths without forwarding credentials", async () => {
    mocks.getStorefrontUrl.mockResolvedValue({
      storefrontUrl: "https://shop.example.com/",
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void init;
        const url = String(input);
        if (url.endsWith("/robots.txt")) {
          return textResponse(
            "User-agent: *\nAllow: /\nSitemap: https://shop.example.com/sitemap.xml",
            {
              contentType: "text/plain; charset=utf-8",
              cacheControl: "public, max-age=300",
            },
          );
        }
        if (url.endsWith("/sitemap.xml")) {
          return textResponse(
            "<sitemapindex><sitemap><loc>https://shop.example.com/sitemap-products.xml</loc></sitemap></sitemapindex>",
            {
              contentType: "application/xml",
              cacheControl: "public, max-age=600",
            },
          );
        }
        return textResponse(
          "<rss><channel><item><g:image_link>https://img.example.com/a.jpg</g:image_link><g:availability>in stock</g:availability></item></channel></rss>",
          {
            contentType: "application/rss+xml",
            cacheControl: "public, max-age=600",
          },
        );
      },
    );

    const result = await runSeoDiscoveryLiveProbe({
      fetch: fetchMock as unknown as typeof fetch,
      getStorefrontUrl: storefrontUrlLookup,
      now: () => new Date("2026-07-06T00:00:00.000Z"),
    });

    expect(mocks.getStorefrontUrl).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://shop.example.com/robots.txt",
      "https://shop.example.com/sitemap.xml",
      "https://shop.example.com/api/product-feed.xml?limit=5",
      "https://shop.example.com/api/facebook-feed.xml?limit=5",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toBeDefined();
      const requestInit = init as RequestInit;
      expect(requestInit).toMatchObject({
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
      });
      expect(requestInit.headers).not.toMatchObject({
        cookie: expect.any(String),
        authorization: expect.any(String),
      });
      expect(requestInit.signal).toBeInstanceOf(AbortSignal);
    }

    expect(result.ok).toBe(true);
    expect(result.resources).toMatchObject([
      {
        key: "robots",
        ok: true,
        status: 200,
        contentType: "text/plain; charset=utf-8",
        cacheControl: "public, max-age=300",
        counts: { robotsSitemapLines: 1 },
      },
      {
        key: "sitemap",
        ok: true,
        status: 200,
        counts: { sitemapLocs: 1 },
      },
      {
        key: "productFeed",
        ok: true,
        status: 200,
        counts: { feedItems: 1, imageLinks: 1, availabilityValues: 1 },
      },
      {
        key: "facebookFeed",
        ok: true,
        status: 200,
        counts: { feedItems: 1, imageLinks: 1, availabilityValues: 1 },
      },
    ]);
  });

  it("allows cold-but-healthy discovery files to finish within the default budget", async () => {
    vi.useFakeTimers();
    mocks.getStorefrontUrl.mockResolvedValue({
      storefrontUrl: "https://shop.example.com/",
    });
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          const url = String(input);
          const timer = setTimeout(() => {
            if (url.endsWith("/robots.txt")) {
              resolve(
                textResponse(
                  "User-agent: *\nAllow: /\nSitemap: https://shop.example.com/sitemap.xml",
                  { contentType: "text/plain" },
                ),
              );
              return;
            }
            if (url.endsWith("/sitemap.xml")) {
              resolve(
                textResponse(
                  "<sitemapindex><sitemap><loc>https://shop.example.com/sitemap-products.xml</loc></sitemap></sitemapindex>",
                  { contentType: "application/xml" },
                ),
              );
              return;
            }
            resolve(
              textResponse(
                "<rss><channel><item><g:image_link>https://img.example.com/a.jpg</g:image_link><g:availability>in stock</g:availability></item></channel></rss>",
                { contentType: "application/rss+xml" },
              ),
            );
          }, 6_500);

          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const resultPromise = runSeoDiscoveryLiveProbe({
      fetch: fetchMock as unknown as typeof fetch,
      getStorefrontUrl: storefrontUrlLookup,
      now: () => new Date("2026-07-06T00:00:00.000Z"),
    });
    await vi.advanceTimersByTimeAsync(6_500);
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(result.resources.every((resource) => resource.ok)).toBe(true);
  });

  it("blocks redirects and caps response body reads", async () => {
    mocks.getStorefrontUrl.mockResolvedValue({
      storefrontUrl: "https://shop.example.com",
    });
    const fetchMock = vi.fn(() =>
      textResponse(
        "Sitemap: https://shop.example.com/sitemap.xml\n".repeat(20),
        { status: 302, contentType: "text/plain" },
      ),
    );

    const result = await runSeoDiscoveryLiveProbe({
      fetch: fetchMock as unknown as typeof fetch,
      getStorefrontUrl: storefrontUrlLookup,
      maxBodyBytes: 8,
    });

    expect(result.ok).toBe(false);
    expect(result.resources).toHaveLength(4);
    expect(
      result.resources.every(
        (resource) => resource.error === "Redirect blocked.",
      ),
    ).toBe(true);
    expect(result.resources.every((resource) => resource.bodyTruncated)).toBe(
      true,
    );
  });
});
