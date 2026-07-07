import { beforeEach, describe, expect, it, vi } from "vitest";

import { runSeoDiscoveryLiveProbe } from "./seo-discovery-live-probe";

const mocks = vi.hoisted(() => ({
  getDiscoveryPolicy: vi.fn(),
  getStorefrontUrl: vi.fn(),
}));

function discoveryPolicyLookup() {
  return mocks.getDiscoveryPolicy();
}

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
    mocks.getDiscoveryPolicy.mockResolvedValue({ discovery: undefined });
  });

  it("does not fetch live URLs when the Store URL is not absolute http(s)", async () => {
    mocks.getStorefrontUrl.mockResolvedValue({ storefrontUrl: "/local-store" });
    const fetchMock = vi.fn();

    const result = await runSeoDiscoveryLiveProbe({
      fetch: fetchMock as unknown as typeof fetch,
      getStorefrontUrl: storefrontUrlLookup,
      getDiscoveryPolicy: discoveryPolicyLookup,
      now: () => new Date("2026-07-06T00:00:00.000Z"),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.getDiscoveryPolicy).not.toHaveBeenCalled();
    expect(result).toEqual({
      baseUrl: null,
      checkedAt: "2026-07-06T00:00:00.000Z",
      ok: false,
      error: "Store URL must be an absolute http(s) URL.",
      resources: [],
    });
  });

  it("probes policy-enabled discovery paths without forwarding credentials", async () => {
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
            `<sitemapindex>
              <sitemap><loc>https://shop.example.com/sitemap-static.xml</loc></sitemap>
              <sitemap><loc>https://shop.example.com/sitemap-products.xml?page=1</loc></sitemap>
              <sitemap><loc>https://shop.example.com/sitemap-categories.xml</loc></sitemap>
              <sitemap><loc>https://shop.example.com/sitemap-collections.xml</loc></sitemap>
              <sitemap><loc>https://shop.example.com/sitemap-pages.xml</loc></sitemap>
            </sitemapindex>`,
            {
              contentType: "application/xml",
              cacheControl: "public, max-age=600",
            },
          );
        }
        if (url.includes("/sitemap-")) {
          return textResponse(
            `<urlset><url><loc>${url}</loc></url></urlset>`,
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
      getDiscoveryPolicy: discoveryPolicyLookup,
      getStorefrontUrl: storefrontUrlLookup,
      now: () => new Date("2026-07-06T00:00:00.000Z"),
    });

    expect(mocks.getStorefrontUrl).toHaveBeenCalledTimes(1);
    expect(mocks.getDiscoveryPolicy).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://shop.example.com/robots.txt",
      "https://shop.example.com/sitemap.xml",
      "https://shop.example.com/api/product-feed.xml?limit=5",
      "https://shop.example.com/api/facebook-feed.xml?limit=5",
      "https://shop.example.com/sitemap-static.xml",
      "https://shop.example.com/sitemap-products.xml?page=1",
      "https://shop.example.com/sitemap-categories.xml",
      "https://shop.example.com/sitemap-collections.xml",
      "https://shop.example.com/sitemap-pages.xml",
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
    expect(result.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "robots",
          kind: "robots",
          ok: true,
          status: 200,
          contentType: "text/plain; charset=utf-8",
          cacheControl: "public, max-age=300",
          counts: { robotsSitemapLines: 1 },
          expectedRobotsSitemapLines: 1,
        }),
        expect.objectContaining({
          key: "sitemap",
          kind: "sitemap",
          ok: true,
          status: 200,
          counts: { sitemapLocs: 5 },
          minimumSitemapLocs: 5,
        }),
        expect.objectContaining({
          key: "productFeed",
          kind: "feed",
          ok: true,
          status: 200,
          counts: { feedItems: 1, imageLinks: 1, availabilityValues: 1 },
        }),
        expect.objectContaining({
          key: "facebookFeed",
          kind: "feed",
          ok: true,
          status: 200,
          counts: { feedItems: 1, imageLinks: 1, availabilityValues: 1 },
        }),
        expect.objectContaining({
          key: "staticPagesSitemap",
          kind: "sitemapChild",
          ok: true,
          status: 200,
          counts: { sitemapLocs: 1 },
          minimumSitemapLocs: 1,
        }),
      ]),
    );
  });

  it("skips disabled feeds and child sitemap sections without live fetches", async () => {
    mocks.getStorefrontUrl.mockResolvedValue({
      storefrontUrl: "https://shop.example.com/",
    });
    mocks.getDiscoveryPolicy.mockResolvedValue({
      discovery: {
        sitemap: {
          enabled: true,
          staticPages: true,
          products: false,
          categories: false,
          collections: false,
          pages: false,
        },
        feeds: { productCatalogEnabled: false },
        robots: { advertiseSitemap: false },
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) {
        return textResponse("User-agent: *\nAllow: /", {
          contentType: "text/plain",
        });
      }
      if (url.endsWith("/sitemap.xml")) {
        return textResponse(
          "<sitemapindex><sitemap><loc>https://shop.example.com/sitemap-static.xml</loc></sitemap></sitemapindex>",
          { contentType: "application/xml" },
        );
      }
      return textResponse("<urlset><url><loc>https://shop.example.com/</loc></url></urlset>", {
        contentType: "application/xml",
      });
    });

    const result = await runSeoDiscoveryLiveProbe({
      fetch: fetchMock as unknown as typeof fetch,
      getDiscoveryPolicy: discoveryPolicyLookup,
      getStorefrontUrl: storefrontUrlLookup,
    });

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://shop.example.com/robots.txt",
      "https://shop.example.com/sitemap.xml",
      "https://shop.example.com/sitemap-static.xml",
    ]);
    expect(result.ok).toBe(true);
    expect(result.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "robots",
          counts: { robotsSitemapLines: 0 },
          expectedRobotsSitemapLines: 0,
        }),
        expect.objectContaining({
          key: "sitemap",
          counts: { sitemapLocs: 1 },
          minimumSitemapLocs: 1,
        }),
        expect.objectContaining({
          key: "productFeed",
          status: null,
          disabledReason:
            "Catalog feeds are disabled by the current SEO discovery policy.",
        }),
        expect.objectContaining({
          key: "facebookFeed",
          status: null,
          disabledReason:
            "Catalog feeds are disabled by the current SEO discovery policy.",
        }),
        expect.objectContaining({
          key: "staticPagesSitemap",
          status: 200,
          counts: { sitemapLocs: 1 },
        }),
        expect.objectContaining({
          key: "productsSitemap",
          status: null,
          disabledReason:
            "This sitemap section is disabled by the current SEO discovery policy.",
        }),
      ]),
    );
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
      getDiscoveryPolicy: discoveryPolicyLookup,
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
      getDiscoveryPolicy: discoveryPolicyLookup,
      getStorefrontUrl: storefrontUrlLookup,
      maxBodyBytes: 8,
    });

    expect(result.ok).toBe(false);
    expect(result.resources).toHaveLength(9);
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
