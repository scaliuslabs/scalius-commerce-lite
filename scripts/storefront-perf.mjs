#!/usr/bin/env node
/**
 * Storefront render-speed check: server TTFB (edge-cache miss and hit) and
 * browser LCP/CLS on a phone (390 px, slow 4G, 4x CPU) and a desktop profile.
 *
 *   node scripts/storefront-perf.mjs --base http://localhost:4391 \
 *     --kv-explorer http://localhost:8811 [--json] [--runs 3]
 *
 * Hit TTFB is judged at the edge: against a remote base the round trip of
 * the edge's own /cdn-cgi/trace on the same connection is subtracted.
 * Read-only: only GET requests. `--kv-explorer` (local wrangler only) points
 * at the API's local explorer so a cache miss can be forced by writing a fresh
 * `cache:generation`; without it the first request of each page is reported
 * as "first" (miss or hit, whatever the edge had) and the rest as hits.
 * Pages default to home, the first category and product linked from home,
 * a search, and the cart. Exit code 1 when any budget is exceeded.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Budgets (ms) the check enforces. Miss budgets hold for a local stack. */
export const DEFAULT_BUDGETS = Object.freeze({
  ttfbHitMs: 50,
  ttfbMissMs: 300,
  lcpPhoneMs: 1500,
  lcpDesktopMs: 1200,
  cls: 0.1,
});

/** Lighthouse's mobile profile: 150 ms RTT, 1.6 Mbps down, 750 kbps up, 4x CPU. */
export const PROFILES = Object.freeze({
  phone: {
    metrics: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    network: { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
    cpuRate: 4,
  },
  desktop: {
    metrics: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
    userAgent: null,
    network: null,
    cpuRate: 1,
  },
});

export function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Compares one page's measurements with the budgets. A 5xx first response
 * fails; `ttfbMiss` is only judged for cacheable pages (a page that always
 * renders, such as a signed-in cart, is held to the miss budget on every hit).
 */
export function evaluateBudgets(row, budgets = DEFAULT_BUDGETS) {
  const failures = [];
  const over = (label, value, limit) => {
    if (Number.isFinite(value) && value > limit) failures.push(`${row.path}: ${label} ${value} > ${limit}`);
  };
  if (row.status >= 500) failures.push(`${row.path}: first response status ${row.status}`);
  if (row.cacheable) {
    over("ttfb hit ms", row.ttfbHit, budgets.ttfbHitMs);
    over("ttfb miss ms", row.ttfbMiss, budgets.ttfbMissMs);
  } else {
    over("ttfb (uncached) ms", row.ttfbHit, budgets.ttfbMissMs);
  }
  over("phone LCP ms", row.phone?.lcp, budgets.lcpPhoneMs);
  over("desktop LCP ms", row.desktop?.lcp, budgets.lcpDesktopMs);
  over("phone CLS", row.phone?.cls, budgets.cls);
  over("desktop CLS", row.desktop?.cls, budgets.cls);
  return failures;
}

/** First category and product links on the home page, plus search and cart. */
export function discoverPaths(homeHtml) {
  const first = (pattern) => homeHtml.match(pattern)?.[1] ?? null;
  const category = first(/href="(\/categories\/[^"?#]+)/);
  const product = first(/href="(\/products\/[^"?#]+)/);
  return ["/", category, product, "/search?q=a", "/cart"].filter(Boolean);
}

function parseArgs(argv) {
  const args = { base: "http://localhost:4391", runs: 3, json: false, profiles: ["phone", "desktop"], paths: null, kvExplorer: null, cdpPort: 9395, budgets: { ...DEFAULT_BUDGETS }, noBrowser: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === "--base") args.base = next().replace(/\/$/, "");
    else if (flag === "--runs") args.runs = Math.max(1, Number(next()) || 3);
    else if (flag === "--json") args.json = true;
    else if (flag === "--no-browser") args.noBrowser = true;
    else if (flag === "--profiles") args.profiles = next().split(",").filter((p) => p in PROFILES);
    else if (flag === "--paths") args.paths = next().split(",").filter(Boolean);
    else if (flag === "--kv-explorer") args.kvExplorer = next().replace(/\/$/, "");
    else if (flag === "--cdp-port") args.cdpPort = Number(next());
    else if (flag.startsWith("--budget-")) {
      const key = flag.slice("--budget-".length).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (!(key in args.budgets)) throw new Error(`Unknown budget ${flag}`);
      args.budgets[key] = Number(next());
    } else throw new Error(`Unknown argument ${flag}`);
  }
  return args;
}

const CACHE_KV_NAMESPACE = "d6e2d77d898e4b3f9c186802ce63f9b8";

async function forceMiss(kvExplorer) {
  const url = `${kvExplorer}/cdn-cgi/local/explorer/api/storage/kv/namespaces/${CACHE_KV_NAMESPACE}/values/cache:generation`;
  const response = await fetch(url, { method: "PUT", body: `perf${Date.now().toString(36)}` });
  if (!response.ok) throw new Error(`could not write the local cache generation (${response.status})`);
}

export function isLocalBase(base) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(base);
}

async function timeFetch(url) {
  const started = performance.now();
  const response = await fetch(url, { redirect: "manual", headers: { "User-Agent": "scalius-storefront-perf" } });
  const ttfb = Math.round(performance.now() - started);
  await response.arrayBuffer();
  return { ttfb, status: response.status, cache: response.headers.get("x-cache-status") ?? "" };
}

// ---------------------------------------------------------------------------
// Minimal CDP client (headless Chrome, no Playwright).
// ---------------------------------------------------------------------------

async function launchChrome(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
    if (r.ok) return null;
  } catch {}
  const { resolveBrowserExecutable } = await import("./dev-admin-browser-smoke.mjs");
  const profile = mkdtempSync(join(tmpdir(), "storefront-perf-"));
  const child = spawn(resolveBrowserExecutable(null), [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--headless=new",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-gpu",
  ], { stdio: "ignore" });
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
  }
  // Chrome may still be writing its profile as it exits: retry, and never let
  // cleanup of a temp dir throw away the measurements.
  return () => {
    child.kill("SIGTERM");
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
  };
}

async function openTarget(port) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const close = async () => {
    ws.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
  };
  return { send, close };
}

const COLLECT_METRICS = `new Promise((resolve) => {
  let lcp = null; let cls = 0;
  new PerformanceObserver((l) => { for (const e of l.getEntries()) lcp = e; }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; }).observe({ type: "layout-shift", buffered: true });
  setTimeout(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    resolve({
      ttfb: nav ? Math.round(nav.responseStart - nav.startTime) : null,
      lcp: lcp ? Math.round(lcp.startTime) : null,
      lcpElement: lcp?.element ? (lcp.element.tagName + (lcp.url ? " " + lcp.url.split("/").slice(-2).join("/") : "")) : null,
      cls: Math.round(cls * 1000) / 1000,
      transferKb: Math.round(performance.getEntriesByType("resource").reduce((n, r) => n + (r.transferSize || 0), nav?.transferSize || 0) / 1024),
    });
  }, 1500);
})`;

async function measureInBrowser(port, url, profileName) {
  const profile = PROFILES[profileName];
  const { send, close } = await openTarget(port);
  try {
    await send("Page.enable");
    await send("Network.enable");
    await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Emulation.setDeviceMetricsOverride", profile.metrics);
    if (profile.userAgent) await send("Emulation.setUserAgentOverride", { userAgent: profile.userAgent });
    await send("Emulation.setCPUThrottlingRate", { rate: profile.cpuRate });
    if (profile.network) {
      await send("Network.emulateNetworkConditions", { offline: false, ...profile.network });
    }
    await send("Page.navigate", { url });
    for (let i = 0; i < 120; i += 1) {
      const { result } = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (result.value === "complete") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const { result } = await send("Runtime.evaluate", { expression: COLLECT_METRICS, awaitPromise: true, returnByValue: true });
    return result.value;
  } finally {
    await close();
  }
}

export async function runStorefrontPerf(options) {
  const { base, runs, kvExplorer, cdpPort, profiles, noBrowser } = options;
  const paths = options.paths ?? discoverPaths(await (await fetch(`${base}/`)).text());
  const stopChrome = noBrowser ? null : await launchChrome(cdpPort);
  const rows = [];
  try {
    for (const path of paths) {
      const url = `${base}${path}`;
      if (kvExplorer) await forceMiss(kvExplorer);
      const first = await timeFetch(url);
      const hits = [];
      const edgeRtts = [];
      for (let i = 0; i < runs; i += 1) {
        // The edge answers /cdn-cgi/trace itself; its TTFB on the same
        // connection is the network round trip to subtract from a hit.
        if (!isLocalBase(base)) edgeRtts.push((await timeFetch(`${base}/cdn-cgi/trace`)).ttfb);
        hits.push(await timeFetch(url));
      }
      const cacheable = hits.some((h) => h.cache === "HIT");
      const rtt = median(edgeRtts) ?? 0;
      const row = {
        path,
        status: first.status,
        cacheable,
        firstCache: first.cache,
        ttfbMiss: kvExplorer || first.cache === "MISS" ? first.ttfb : null,
        ttfbFirst: first.ttfb,
        ttfbHitClient: median(hits.map((h) => h.ttfb)),
        edgeRtt: rtt,
        ttfbHit: Math.max(0, median(hits.map((h) => h.ttfb)) - rtt),
      };
      for (const profileName of noBrowser ? [] : profiles) {
        const samples = [];
        for (let i = 0; i < runs; i += 1) samples.push(await measureInBrowser(cdpPort, url, profileName));
        row[profileName] = {
          lcp: median(samples.map((s) => s.lcp)),
          cls: Math.max(...samples.map((s) => s.cls ?? 0)),
          ttfb: median(samples.map((s) => s.ttfb)),
          transferKb: median(samples.map((s) => s.transferKb)),
          lcpElement: samples.at(-1)?.lcpElement ?? null,
        };
      }
      rows.push(row);
    }
  } finally {
    stopChrome?.();
  }
  const failures = rows.flatMap((row) => evaluateBudgets(row, options.budgets));
  return { base, rows, failures };
}

function printTable({ rows, failures }) {
  const fmt = (v) => (v === null || v === undefined ? "-" : String(v));
  console.log("path | status | first(cache) | miss ttfb | hit ttfb at edge (client, rtt) | phone LCP / CLS / KB | desktop LCP / CLS / KB");
  for (const r of rows) {
    console.log([
      r.path, r.status, `${r.ttfbFirst} (${r.firstCache || "-"})`, fmt(r.ttfbMiss), `${fmt(r.ttfbHit)} (${fmt(r.ttfbHitClient)}, ${fmt(r.edgeRtt)})`,
      r.phone ? `${fmt(r.phone.lcp)} / ${r.phone.cls} / ${r.phone.transferKb} [${r.phone.lcpElement ?? "-"}]` : "-",
      r.desktop ? `${fmt(r.desktop.lcp)} / ${r.desktop.cls} / ${r.desktop.transferKb} [${r.desktop.lcpElement ?? "-"}]` : "-",
    ].join(" | "));
  }
  console.log(failures.length ? `\nFAIL\n${failures.join("\n")}` : "\nPASS");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = parseArgs(process.argv.slice(2));
  const result = await runStorefrontPerf(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printTable(result);
  process.exit(result.failures.length ? 1 : 0);
}
