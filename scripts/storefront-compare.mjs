#!/usr/bin/env node
/**
 * The storefront speed profile of `pnpm perf:storefront`, run against any
 * public store, so Scalius can be compared with other platforms on the same
 * pages, network and device:
 *
 *   node scripts/storefront-compare.mjs \
 *     --site scalius=https://storefront.scalius.com \
 *     --site shopify-dawn=https://theme-dawn-demo.myshopify.com \
 *     [--runs 3] [--profiles phone,desktop] [--json] [--cdp-port 9395]
 *
 * For each site it finds the home page, the first listing and product page
 * linked from home, and the cart, then records:
 *
 * - TTFB of the page (median of warm-connection GETs after the first) and
 *   of the site's `/robots.txt` on the same connection: the network and edge
 *   floor. "Server" is the page minus that floor.
 * - In headless Chrome, LCP, CLS and transfer size on the phone (390 px, slow
 *   4G, 4x CPU) and desktop profiles, median of `--runs`.
 *
 * GET only, at most 3 runs per page (`--runs` is capped), one request at a
 * time, no cookies accepted and no forms touched: a polite visitor.
 */
import { pathToFileURL } from "node:url";
import { PROFILES, launchChrome, measureInBrowser, median } from "./storefront-perf.mjs";

const USER_AGENT = "Mozilla/5.0 (compatible; scalius-storefront-compare)";
export const MAX_RUNS = 3;

export function parseCompareArgs(argv) {
  const args = { sites: [], runs: MAX_RUNS, profiles: ["phone", "desktop"], json: false, cdpPort: 9395 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === "--site") {
      const value = next() ?? "";
      const at = value.indexOf("=");
      if (at < 1) throw new Error(`--site needs <label>=<url>, got ${value}`);
      const url = new URL(value.slice(at + 1));
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${url} is not a web address`);
      args.sites.push({ label: value.slice(0, at), home: url.href });
    } else if (flag === "--runs") args.runs = Math.min(MAX_RUNS, Math.max(1, Number(next()) || MAX_RUNS));
    else if (flag === "--profiles") args.profiles = next().split(",").filter((p) => p in PROFILES);
    else if (flag === "--json") args.json = true;
    else if (flag === "--cdp-port") args.cdpPort = Number(next());
    else throw new Error(`Unknown argument ${flag}`);
  }
  if (args.sites.length === 0) throw new Error("Name at least one --site <label>=<url>");
  return args;
}

const PAGE_PATTERNS = {
  // Shopify and Scalius: /products/<handle>; WooCommerce: /product/<slug>/.
  product: /\/products?\/[^/?#"]+\/?$/,
  // Scalius categories, Shopify collections, WooCommerce product categories and shop.
  listing: /\/(?:categories|collections|product-category)\/[^?#"]+\/?$|\/shop\/?$/,
};

/** The first same-site product and listing links of a home page, plus the cart. */
export function discoverComparePages(homeHtml, homeUrl) {
  const home = new URL(homeUrl);
  // A store under a path (`/storefront/`) links only inside it.
  const basePath = home.pathname.endsWith("/") ? home.pathname : `${home.pathname}/`;
  const links = [];
  for (const match of homeHtml.matchAll(/href="([^"]+)"/g)) {
    try {
      const url = new URL(match[1].replaceAll("&amp;", "&"), home);
      if (url.origin === home.origin && url.pathname.startsWith(basePath)) {
        url.hash = "";
        links.push(url);
      }
    } catch {}
  }
  const first = (pattern) => links.find((url) => pattern.test(url.pathname) && !url.search)?.href ?? null;
  // WooCommerce stores may call it the basket.
  const cartPath = links.find((url) => /\/(?:cart|basket)\/?$/.test(url.pathname))?.href ?? new URL("cart", home.href.replace(/\/?$/, "/")).href;
  return [
    { page: "home", url: home.href },
    { page: "listing", url: first(PAGE_PATTERNS.listing) },
    { page: "product", url: first(PAGE_PATTERNS.product) },
    { page: "cart", url: cartPath },
  ].filter((entry) => entry.url);
}

async function timedGet(url) {
  const started = performance.now();
  const response = await fetch(url, { redirect: "follow", headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" } });
  const ttfb = performance.now() - started;
  await response.arrayBuffer();
  return { ttfb: Math.round(ttfb), status: response.status, url: response.url };
}

/** Warm-connection TTFB of a page and of the site's robots.txt, interleaved. */
async function measureTtfb(url, runs) {
  const first = await timedGet(url);
  const robots = new URL("/robots.txt", first.url).href;
  await timedGet(robots);
  const page = [];
  const floor = [];
  for (let i = 0; i < runs; i += 1) {
    floor.push((await timedGet(robots)).ttfb);
    page.push((await timedGet(first.url)).ttfb);
  }
  const pageMs = median(page);
  const floorMs = median(floor);
  return { status: first.status, finalUrl: first.url, firstMs: first.ttfb, pageMs, floorMs, serverMs: Math.max(0, pageMs - floorMs) };
}

export async function runStorefrontCompare(options) {
  const stopChrome = options.profiles.length ? await launchChrome(options.cdpPort) : null;
  const rows = [];
  try {
    for (const site of options.sites) {
      const homeResponse = await fetch(site.home, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" } });
      let pages = discoverComparePages(await homeResponse.text(), homeResponse.url);
      const listing = pages.find((entry) => entry.page === "listing");
      if (listing && !pages.some((entry) => entry.page === "product")) {
        // A home page without product links: take the first from the listing.
        const listingResponse = await fetch(listing.url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" } });
        const product = discoverComparePages(await listingResponse.text(), homeResponse.url).find((entry) => entry.page === "product");
        if (product) pages = [...pages.filter((entry) => entry.page !== "cart"), product, pages.find((entry) => entry.page === "cart")].filter(Boolean);
      }
      for (const { page, url } of pages) {
        const ttfb = await measureTtfb(url, options.runs);
        const row = { site: site.label, page, url: ttfb.finalUrl, ...ttfb };
        for (const profile of options.profiles) {
          const samples = [];
          for (let i = 0; i < options.runs; i += 1) samples.push(await measureInBrowser(options.cdpPort, ttfb.finalUrl, profile));
          row[profile] = {
            lcp: median(samples.map((s) => s.lcp)),
            cls: Math.max(...samples.map((s) => s.cls ?? 0)),
            transferKb: median(samples.map((s) => s.transferKb)),
          };
        }
        rows.push(row);
      }
    }
  } finally {
    stopChrome?.();
  }
  return { measuredAt: new Date().toISOString(), runs: options.runs, rows };
}

/** A Markdown table of the rows (the format docs/STOREFRONT-PERFORMANCE.md records). */
export function compareTable(rows) {
  const fmt = (value) => (value === null || value === undefined ? "-" : String(value));
  const lines = [
    "| Site | Page | TTFB server / page / floor (ms) | Phone LCP (ms) | Phone CLS | Phone KB | Desktop LCP (ms) | Desktop CLS |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of rows) {
    lines.push(`| ${row.site} | ${row.page} | ${row.serverMs} / ${row.pageMs} / ${row.floorMs} | ${fmt(row.phone?.lcp)} | ${fmt(row.phone?.cls)} | ${fmt(row.phone?.transferKb)} | ${fmt(row.desktop?.lcp)} | ${fmt(row.desktop?.cls)} |`);
  }
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = parseCompareArgs(process.argv.slice(2));
  const result = await runStorefrontCompare(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Measured ${result.measuredAt}, ${result.runs} runs per page\n`);
    console.log(compareTable(result.rows));
    for (const row of result.rows) console.log(`- ${row.site} ${row.page}: ${row.url}`);
  }
}
