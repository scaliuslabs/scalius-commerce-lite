import { describe, expect, it, vi } from "vitest";
import {
  evaluateDiscoveryCacheHeaders,
  evaluateFacebookFeedXml,
  evaluateProductFeedXml,
  evaluateRemediationTracker,
  evaluateRequiredDocs,
  evaluateRobotsTxt,
  evaluateSitemapXml,
  normalizeHttpBaseUrl,
  parseReleaseCheckArgs,
  runReleaseCheck,
} from "./release-check.mjs";

const SITEMAP_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";
const FEED_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=43200";

function textResponse(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

function discoveryResponse(body, cacheControl = SITEMAP_CACHE_CONTROL) {
  return textResponse(body, 200, { "Cache-Control": cacheControl });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

function readyResponse() {
  return jsonResponse({
    success: true,
    status: "ready",
    checks: {
      d1: { status: "ok", latencyMs: 12 },
      api_cache_kv: { status: "ok", latencyMs: 8 },
    },
  });
}

function monitoringApiConfig() {
  return {
    name: "scalius-api",
    observability: { enabled: true },
    triggers: { crons: ["*/15 * * * *"] },
    vars: {
      PUBLIC_API_BASE_URL: "https://api.example.test",
      STOREFRONT_URL: "https://storefront.example.test",
    },
    queues: {
      producers: [{ queue: "payment-events" }],
      consumers: [
        { queue: "payment-events", dead_letter_queue: "payment-events-dlq" },
        { queue: "payment-events-dlq" },
      ],
    },
  };
}

function verifiedTracker() {
  return [
    "| ID | Severity | Status | Owner | Summary | Primary Verification |",
    "| --- | --- | --- | --- | --- | --- |",
    "| SEC-001 | P0 | Verified | API | Fixed. | Tests. |",
    "| AUTH-001 | P1 | Won't Fix | API | Accepted. | Note. |",
    "| PERF-001 | P2 | In Progress | Admin | Follow-up. | Tests. |",
  ].join("\n");
}

function trackerWithOpenBlocker() {
  return [
    "| ID | Severity | Status | Owner | Summary | Primary Verification |",
    "| --- | --- | --- | --- | --- | --- |",
    "| SEC-001 | P0 | Verified | API | Fixed. | Tests. |",
    "| PAY-001 | P1 | In Progress | Payments | Not ready. | Smoke. |",
  ].join("\n");
}

function robotsTxt() {
  return "User-agent: *\nAllow: /\nSitemap: https://storefront.example.test/sitemap.xml\n";
}

function sitemapXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    "<url><loc>https://storefront.example.test/products/demo-product</loc></url>",
    "</urlset>",
  ].join("");
}

function feedXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0"><channel>',
    "<item>",
    "<g:id>sku_1</g:id>",
    "<g:link>https://storefront.example.test/products/demo-product</g:link>",
    "<g:image_link>https://cloud.example.test/demo.png</g:image_link>",
    "<g:availability>in stock</g:availability>",
    "</item>",
    "</channel></rss>",
  ].join("");
}

describe("release-check parser", () => {
  it("parses supported options and normalizes URLs", () => {
    expect(parseReleaseCheckArgs([
      "--json",
      "--skip-wrangler",
      "--timeout-ms=5000",
      "--api-base-url",
      "https://api.example.test/api/v1/",
      "--storefront-url",
      "https://storefront.example.test/",
      "--dashboard-url=https://dashboard.example.test/",
    ])).toMatchObject({
      json: true,
      skipLive: false,
      skipWrangler: true,
      timeoutMs: 5000,
      apiBaseUrl: "https://api.example.test/api/v1",
      storefrontUrl: "https://storefront.example.test",
      dashboardUrl: "https://dashboard.example.test",
    });

    expect(parseReleaseCheckArgs(["--help"])).toEqual({ help: true });
    expect(() => parseReleaseCheckArgs(["--timeout-ms", "0"])).toThrow("--timeout-ms must be a positive integer");
    expect(() => parseReleaseCheckArgs(["--api-base-url", "file:///tmp/api"])).toThrow("must use http or https");
    expect(() => normalizeHttpBaseUrl("https://user:pass@example.test", "Storefront URL")).toThrow("must not include credentials");
  });
});

describe("release-check local evaluators", () => {
  it("fails open P0/P1 tracker rows and allows closed rows", () => {
    expect(evaluateRemediationTracker(verifiedTracker())).toMatchObject({
      ok: true,
      checkedRows: 3,
      blockers: [],
    });

    expect(evaluateRemediationTracker(trackerWithOpenBlocker())).toMatchObject({
      ok: false,
      blockers: [{ id: "PAY-001", severity: "P1", status: "In Progress" }],
    });
  });

  it("checks required docs by path", () => {
    const existing = new Set([
      "/repo/audit/REMEDIATION_TRACKER.md",
      "/repo/audit/VERIFICATION_PLAYBOOK.md",
      "/repo/audit/STABLE_RELEASE_CHECKLIST.md",
      "/repo/docs/codex/PLATFORM-GOAL.md",
      "/repo/docs/codex/README.md",
      "/repo/docs/ARCHITECTURE.md",
      "/repo/README.md",
      "/repo/AGENTS.md",
    ]);

    expect(evaluateRequiredDocs({
      rootDir: "/repo",
      fileExistsImpl: (path) => existing.has(path),
    })).toMatchObject({
      ok: true,
      checkedFiles: 8,
    });

    existing.delete("/repo/docs/ARCHITECTURE.md");
    expect(evaluateRequiredDocs({
      rootDir: "/repo",
      fileExistsImpl: (path) => existing.has(path),
    })).toMatchObject({
      ok: false,
      missing: ["docs/ARCHITECTURE.md"],
    });
  });
});

describe("release-check discovery evaluators", () => {
  const storefrontOrigin = "https://storefront.example.test";

  it("validates robots sitemap URLs and sitemap locs", () => {
    expect(evaluateRobotsTxt(robotsTxt(), { storefrontOrigin })).toMatchObject({
      ok: true,
      sitemapUrls: ["https://storefront.example.test/sitemap.xml"],
    });
    expect(evaluateRobotsTxt("Sitemap: /sitemap.xml", { storefrontOrigin })).toMatchObject({
      ok: false,
      errors: ["robots sitemap URL is not absolute http(s): /sitemap.xml"],
    });

    expect(evaluateSitemapXml(sitemapXml(), { storefrontOrigin })).toMatchObject({
      ok: true,
      locCount: 1,
    });
    expect(evaluateSitemapXml("<url><loc>/products/demo</loc></url>", { storefrontOrigin })).toMatchObject({
      ok: false,
      errors: ["sitemap <loc> is not absolute http(s): /products/demo"],
    });
  });

  it("rejects product sitemap priority/changefreq tags", () => {
    const withIgnoredSeoHints = sitemapXml().replace("</url>", "<priority>0.9</priority><changefreq>daily</changefreq></url>");
    expect(evaluateSitemapXml(withIgnoredSeoHints, {
      storefrontOrigin,
      forbidPriority: true,
      forbidChangefreq: true,
    })).toMatchObject({
      ok: false,
      errors: [
        "product sitemap must not include <priority>.",
        "product sitemap must not include <changefreq>.",
      ],
    });
  });

  it("validates feed item, availability, and absolute links", () => {
    const feedWithChannelLink = feedXml().replace("<channel>", "<channel><link>https://storefront.example.test/</link>");

    expect(evaluateProductFeedXml(feedWithChannelLink, { storefrontOrigin })).toMatchObject({
      ok: true,
      itemCount: 1,
      linkCount: 1,
      imageLinkCount: 1,
      availabilityCount: 1,
      firstStorefrontItemUrl: "https://storefront.example.test/products/demo-product",
    });
    expect(evaluateFacebookFeedXml(feedWithChannelLink, { storefrontOrigin })).toMatchObject({
      ok: true,
      itemCount: 1,
    });

    expect(evaluateProductFeedXml("<rss><channel><item><g:link>/products/demo</g:link></item></channel></rss>", {
      storefrontOrigin,
    })).toMatchObject({
      ok: false,
      errors: [
        "Product feed must include availability markers.",
        "feed product link is not absolute http(s): /products/demo",
      ],
    });

    const missingRssShell = [
      "<channel><item>",
      "<g:link>https://storefront.example.test/products/demo-product</g:link>",
      "<g:image_link>https://cloud.example.test/demo.png</g:image_link>",
      "<g:availability>in stock</g:availability>",
      "</item></channel>",
    ].join("");
    expect(evaluateProductFeedXml(missingRssShell, { storefrontOrigin })).toMatchObject({
      ok: false,
      errors: ["Product feed must be RSS/XML with <rss> and <channel>."],
    });
  });

  it("validates production-safe discovery cache headers without pinning exact TTLs", () => {
    expect(evaluateDiscoveryCacheHeaders("public, max-age=60", { label: "robots.txt" })).toMatchObject({
      ok: true,
      cacheControl: "public, max-age=60",
    });
    expect(evaluateDiscoveryCacheHeaders("private, no-store", { label: "sitemap.xml" })).toMatchObject({
      ok: false,
      errors: [
        "sitemap.xml Cache-Control must not include no-store on successful discovery responses.",
        "sitemap.xml Cache-Control must not be private on successful discovery responses.",
        "sitemap.xml Cache-Control must include public cacheability.",
        "sitemap.xml Cache-Control must include a positive max-age or s-maxage.",
      ],
    });
    expect(evaluateDiscoveryCacheHeaders("", { label: "product feed" })).toMatchObject({
      ok: false,
      errors: ["product feed must include Cache-Control."],
    });
  });
});

describe("runReleaseCheck", () => {
  it("runs local gates and live read-only checks with fake fetch and exec", async () => {
    const feedRequests = [];
    const fetchImpl = vi.fn(async (url, init) => {
      expect(init.method).toBe("GET");
      const parsed = new URL(url);

      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyResponse();
        if (parsed.pathname === "/api/v1/openapi.json") {
          return jsonResponse({
            paths: {
              "/api/v1/health": {},
              "/api/v1/readyz": {},
              "/api/v1/openapi.json": {},
            },
          });
        }
      }

      if (parsed.hostname === "dashboard.example.test" && parsed.pathname === "/admin") {
        expect(init.redirect).toBe("manual");
        return textResponse("", 307, { location: "/auth/login" });
      }

      if (parsed.hostname === "storefront.example.test") {
        if (parsed.pathname === "/health") return textResponse("ok");
        if (parsed.pathname === "/" || parsed.pathname === "/search") return textResponse("<!doctype html><html></html>");
        if (parsed.pathname === "/robots.txt") return discoveryResponse(robotsTxt());
        if (parsed.pathname.startsWith("/sitemap-") || parsed.pathname === "/sitemap.xml") {
          return discoveryResponse(sitemapXml());
        }
        if (
          (parsed.pathname === "/api/product-feed.xml" || parsed.pathname === "/api/facebook-feed.xml") &&
          (parsed.search === "?limit=5" || parsed.search === "?page=2&limit=5")
        ) {
          feedRequests.push(`${parsed.pathname}${parsed.search}`);
          return discoveryResponse(feedXml(), FEED_CACHE_CONTROL);
        }
        if (parsed.pathname === "/products/demo-product") return textResponse("<!doctype html><html></html>");
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    const execFileImpl = vi.fn(async (command, args) => {
      expect(command).toBe("pnpm");
      expect(args).toEqual(["--dir", "apps/api", "exec", "wrangler", "deployments", "list", "--json"]);
      return {
        stdout: JSON.stringify([
          {
            created_on: "2026-07-06T02:00:00Z",
            versions: [{ version_id: "api-version", percentage: 100 }],
          },
        ]),
      };
    });

    const result = await runReleaseCheck(parseReleaseCheckArgs([
      "--api-base-url", "https://api.example.test",
      "--storefront-url", "https://storefront.example.test",
      "--dashboard-url", "https://dashboard.example.test",
    ]), {
      apiConfig: monitoringApiConfig(),
      fetchImpl,
      execFileImpl,
      rootDir: "/repo",
      readFileImpl: () => verifiedTracker(),
      fileExistsImpl: () => true,
      pnpmExecutable: "pnpm",
      logger: null,
    });

    expect(result.status).toBe("passed");
    expect(result.checks.apiOps).toMatchObject({
      healthStatusCode: 200,
      readyCount: 2,
      openApiPathCount: 3,
      deploymentVersionId: "api-version",
    });
    expect(result.checks.dashboard).toMatchObject({
      statusCode: 307,
      location: "/auth/login",
    });
    expect(result.checks.discovery.robots.cacheControl).toBe(SITEMAP_CACHE_CONTROL);
    expect(result.checks.discovery.sitemaps["/sitemap.xml"].cacheControl).toBe(SITEMAP_CACHE_CONTROL);
    expect(result.checks.discovery.feed).toMatchObject({
      cacheControl: FEED_CACHE_CONTROL,
      itemCount: 1,
      imageLinkCount: 1,
      availabilityCount: 1,
    });
    expect(result.checks.discovery.compatibilityFeed).toMatchObject({
      cacheControl: FEED_CACHE_CONTROL,
      itemCount: 1,
      imageLinkCount: 1,
      availabilityCount: 1,
    });
    expect(feedRequests).toEqual([
      "/api/product-feed.xml?limit=5",
      "/api/product-feed.xml?page=2&limit=5",
      "/api/facebook-feed.xml?limit=5",
      "/api/facebook-feed.xml?page=2&limit=5",
    ]);
    expect(result.checks.productRoute.url).toBe("https://storefront.example.test/products/demo-product");
    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });

  it("skips live checks without calling fetch or exec", async () => {
    const fetchImpl = vi.fn();
    const execFileImpl = vi.fn();

    const result = await runReleaseCheck(parseReleaseCheckArgs(["--skip-live"]), {
      apiConfig: monitoringApiConfig(),
      fetchImpl,
      execFileImpl,
      rootDir: "/repo",
      readFileImpl: () => verifiedTracker(),
      fileExistsImpl: () => true,
      logger: null,
    });

    expect(result.status).toBe("passed");
    expect(result.checks.live).toMatchObject({ status: "skipped" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it("honors --skip-wrangler while still running live HTTP checks", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyResponse();
        if (parsed.pathname === "/api/v1/openapi.json") return jsonResponse({ paths: { "/x": {} } });
      }
      if (parsed.hostname === "dashboard.example.test" && parsed.pathname === "/admin") {
        return textResponse("", 307, { location: "/auth/login" });
      }
      if (parsed.hostname === "storefront.example.test") {
        if (parsed.pathname === "/health") return textResponse("ok");
        if (parsed.pathname === "/" || parsed.pathname === "/search") return textResponse("<html></html>");
        if (parsed.pathname === "/robots.txt") return discoveryResponse(robotsTxt());
        if (parsed.pathname.startsWith("/sitemap-") || parsed.pathname === "/sitemap.xml") {
          return discoveryResponse(sitemapXml());
        }
        if (
          (parsed.pathname === "/api/product-feed.xml" || parsed.pathname === "/api/facebook-feed.xml") &&
          (parsed.search === "?limit=5" || parsed.search === "?page=2&limit=5")
        ) {
          return discoveryResponse(feedXml(), FEED_CACHE_CONTROL);
        }
        if (parsed.pathname === "/products/demo-product") return textResponse("<html></html>");
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const execFileImpl = vi.fn();

    const result = await runReleaseCheck(parseReleaseCheckArgs([
      "--skip-wrangler",
      "--api-base-url", "https://api.example.test",
      "--storefront-url", "https://storefront.example.test",
      "--dashboard-url", "https://dashboard.example.test",
    ]), {
      apiConfig: monitoringApiConfig(),
      fetchImpl,
      execFileImpl,
      rootDir: "/repo",
      readFileImpl: () => verifiedTracker(),
      fileExistsImpl: () => true,
      logger: null,
    });

    expect(result.status).toBe("passed");
    expect(result.checks.apiOps).toMatchObject({
      deploymentStatus: "skipped",
    });
    expect(fetchImpl).toHaveBeenCalled();
    expect(execFileImpl).not.toHaveBeenCalled();
  });
});
