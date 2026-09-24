#!/usr/bin/env node
// Runtime dashboard performance smoke against a LOCAL stack (never production).
//
// Drives headless Chrome over CDP (no Playwright), signs in with the repo's
// local dev-admin smoke account, and measures what a merchant feels:
//   - first load of /admin: first contentful paint, page ready (title + data,
//     no skeletons) and an interactive estimate (ready, then no long task);
//   - route transitions by real mouse clicks (hover, then press, as a person
//     does), cold (first visit: chunk + data) and warm (revisit, cached);
//   - dashboard API requests per transition and their waterfall depth (how
//     many round trips had to finish before the next could start);
//   - with --explorer, the API Worker's D1 calls per transition, read from the
//     local wrangler observability store;
//   - optional typing latency in the product editor (--typing-product <id>).
//
// Usage:
//   node scripts/admin-perf-check.mjs --runtime --admin http://localhost:4323 \
//     [--cpu 4] [--cdp-port 9396] [--explorer http://localhost:8787] \
//     [--typing-product <productId>] [--json <file>] [--check]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdminBrowserSmokeConfig, resolveBrowserExecutable } from "./dev-admin-browser-smoke.mjs";

/** Runtime budgets (milliseconds) enforced by --check. */
export const RUNTIME_BUDGETS = {
  firstLoadReadyMs: 1500,
  warmTransitionMs: 150,
  coldTransitionMs: 400,
  keystrokeMs: 50,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    });
  }

  send(method, params = {}) {
    const id = this.id++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 60_000);
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

async function launchChrome(port, profileDir) {
  const executable = resolveBrowserExecutable(process.env.CHROME_BIN ?? null);
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--window-size=1440,900",
  ], { stdio: "ignore" });
  for (let attempt = 0; attempt < 75; attempt += 1) {
    await sleep(200);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return child;
    } catch {
      // Chrome is still starting.
    }
  }
  child.kill("SIGKILL");
  throw new Error(`Chrome did not open its debugging port ${port}`);
}

async function connect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find((item) => item.type === "page")
    ?? await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  return new Cdp(ws);
}

// Installed in every document: records long tasks, input event durations and
// exposes a frame-accurate wait for a "page ready" predicate.
const PAGE_PROBE = `(() => {
  window.__perf = { longTasks: [], events: [], t0: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__perf.longTasks.push([entry.startTime, entry.duration]);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__perf.events.push([entry.name, entry.startTime, entry.duration]);
    }).observe({ type: "event", durationThreshold: 16, buffered: true });
  } catch {}
  addEventListener("pointerdown", () => { window.__perf.t0 = performance.now(); }, true);
  window.__perfReady = (source, timeoutMs) => new Promise((resolve) => {
    const ready = new Function("return (" + source + ")();");
    const started = performance.now();
    const tick = () => {
      let ok = false;
      try { ok = ready(); } catch {}
      if (ok) {
        // Resolve after the frame that shows it has been produced.
        const at = performance.now();
        requestAnimationFrame(() => setTimeout(() => resolve({ at, ok: true }), 0));
        return;
      }
      if (performance.now() - started > timeoutMs) { resolve({ at: performance.now(), ok: false }); return; }
      requestAnimationFrame(tick);
    };
    tick();
  });
})();`;

/** Home shows its title before its numbers; ready means the metrics are in. */
const HOME_DATA = ".tabular-nums";

/** A page is ready when its title and data are on screen and nothing is still loading. */
function readyPredicate(pathPattern, selector) {
  return `() => {
    if (!new RegExp(${JSON.stringify(pathPattern)}).test(location.pathname)) return false;
    if (document.getElementById("boot")) return false;
    const main = document.querySelector("#admin-main-scroll") || document.querySelector("main");
    // The previous page's title is marked before each click: ready means the
    // destination rendered its own title, not that the URL changed.
    if (!main || !main.querySelector("h1:not([data-perf-stale])")) return false;
    if (document.querySelector("[data-perf-stale]")) return false;
    if (main.querySelector(".animate-pulse, [aria-busy='true']")) return false;
    return ${selector ? `!!main.querySelector(${JSON.stringify(selector)})` : "true"};
  }`;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)];
}

function round(value) {
  return value == null ? null : Math.round(value);
}

/** Longest chain of API requests where each starts after the previous ended. */
export function waterfallDepth(requests) {
  const sorted = [...requests].sort((a, b) => a.start - b.start);
  const depth = new Map();
  let max = 0;
  for (const request of sorted) {
    let best = 0;
    for (const earlier of sorted) {
      if (earlier === request) break;
      if (earlier.end <= request.start) best = Math.max(best, depth.get(earlier) ?? 0);
    }
    depth.set(request, best + 1);
    max = Math.max(max, best + 1);
  }
  return max;
}

async function readD1Calls(explorer, fromMs, toMs) {
  const sql = `SELECT name, parent_id IS NULL AS root, start_ms, duration_ms FROM spans
    WHERE start_ms >= ${Math.floor(fromMs)} AND start_ms <= ${Math.ceil(toMs)}`;
  try {
    const response = await fetch(`${explorer}/cdn-cgi/local/explorer/api/local/observability/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql }),
    });
    const body = await response.json();
    const rows = body?.result?.rows ?? [];
    const d1 = rows.filter(([name]) => /^d1_/.test(name));
    return {
      requests: rows.filter(([, root]) => root).length,
      d1Calls: d1.length,
      d1Ms: Math.round(d1.reduce((sum, [, , , duration]) => sum + duration, 0)),
    };
  } catch {
    return null;
  }
}

export async function runAdminPerfRuntime(options) {
  const admin = options.admin.replace(/\/$/, "");
  const port = options.cdpPort ?? 9396;
  const profileDir = mkdtempSync(join(tmpdir(), "scalius-admin-perf-"));
  const chrome = await launchChrome(port, profileDir);
  const progress = (message) => {
    if (options.verbose) process.stderr.write(`  … ${message}\n`);
  };
  const report = {
    admin,
    cpuThrottle: options.cpu ?? 1,
    latencyMs: options.latencyMs ?? 0,
    downloadMbps: options.downloadMbps ?? null,
    firstLoad: {}, transitions: [], typing: null, errors: [] };

  try {
    const cdp = await connect(port);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_PROBE });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    if ((options.cpu ?? 1) > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: options.cpu });
    if (options.latencyMs || options.downloadMbps) {
      // Round trip and bandwidth of a merchant's connection to the edge; the
      // local stack otherwise answers in microseconds.
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: options.latencyMs ?? 0,
        downloadThroughput: options.downloadMbps ? (options.downloadMbps * 1024 * 1024) / 8 : -1,
        uploadThroughput: options.downloadMbps ? (options.downloadMbps * 1024 * 1024) / 16 : -1,
      });
    }

    const requests = new Map();
    cdp.on((message) => {
      // "Leave page? Changes you made may not be saved": leave.
      if (message.method === "Page.javascriptDialogOpening") {
        void cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      }
      if (message.method === "Runtime.exceptionThrown") {
        report.errors.push(message.params.exceptionDetails?.exception?.description?.slice(0, 300) ?? "exception");
      }
      if (message.method === "Network.requestWillBeSent" && /\/api\/(v1|auth)\//.test(message.params.request.url)) {
        requests.set(message.params.requestId, {
          url: message.params.request.url.replace(admin, ""),
          start: message.params.timestamp * 1000,
          end: Number.POSITIVE_INFINITY,
        });
      }
      if (message.method === "Network.loadingFinished" || message.method === "Network.loadingFailed") {
        const request = requests.get(message.params.requestId);
        if (request) request.end = message.params.timestamp * 1000;
      }
    });

    const evaluate = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };

    // Sign in through the dashboard origin (its proxy or the Worker) and hand
    // the session cookies to Chrome. Credentials are never printed.
    const config = getAdminBrowserSmokeConfig([], process.env);
    const signIn = await fetch(`${admin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", origin: admin },
      body: JSON.stringify({ email: config.email, password: config.password, rememberMe: true }),
    });
    if (!signIn.ok) throw new Error(`Local admin sign-in failed (${signIn.status}); run pnpm dev:admin:create first.`);
    for (const raw of signIn.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const index = pair.indexOf("=");
      await cdp.send("Network.setCookie", {
        name: pair.slice(0, index),
        value: pair.slice(index + 1),
        url: admin,
        httpOnly: /httponly/i.test(raw),
        path: "/",
      });
    }

    const homeReady = readyPredicate("^/admin/?$", HOME_DATA);

    async function load(url, predicate, { cold }) {
      progress(`load ${url} (${cold ? "cold" : "warm"})`);
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: cold });
      if (cold) await cdp.send("Network.clearBrowserCache");
      requests.clear();
      await cdp.send("Page.navigate", { url });
      await sleep(50);
      const waited = await evaluate(`window.__perfReady(${JSON.stringify(predicate)}, 30000)`);
      await sleep(1000);
      const metrics = await evaluate(`(() => {
        const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null;
        const nav = performance.getEntriesByType("navigation")[0];
        const scripts = performance.getEntriesByType("resource").filter((entry) => entry.initiatorType === "script" || /\\.js$/.test(entry.name));
        return {
          fcp,
          domContentLoaded: nav?.domContentLoadedEventEnd ?? null,
          scriptBytes: scripts.reduce((sum, entry) => sum + (entry.encodedBodySize || 0), 0),
          scripts: scripts.length,
          longTasks: window.__perf.longTasks,
        };
      })()`);
      const ready = waited.at;
      // Interactive: ready, and the main thread free of long tasks from then on.
      const lastLongTaskEnd = metrics.longTasks
        .map(([start, duration]) => start + duration)
        .filter((end) => end > 0)
        .reduce((max, end) => Math.max(max, end), 0);
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
      return {
        ok: waited.ok,
        fcp: round(metrics.fcp),
        ready: round(ready),
        interactive: round(Math.max(ready, lastLongTaskEnd)),
        longTaskMs: round(metrics.longTasks.reduce((sum, [, duration]) => sum + duration, 0)),
        scripts: metrics.scripts,
        scriptKiB: round(metrics.scriptBytes / 1024),
        apiRequests: requests.size,
        apiWaterfall: waterfallDepth([...requests.values()]),
        apiUrls: [...requests.values()].map((request) => request.url.replace(/\?.*$/, "")),
      };
    }

    // First load: cold (empty HTTP cache) and warm (cached immutable assets).
    for (const mode of ["cold", "warm"]) {
      const runs = [];
      for (let run = 0; run < (options.runs ?? 3); run += 1) {
        runs.push(await load(`${admin}/admin`, homeReady, { cold: mode === "cold" }));
      }
      report.firstLoad[mode] = {
        ok: runs.every((run) => run.ok),
        fcp: median(runs.map((run) => run.fcp)),
        ready: median(runs.map((run) => run.ready)),
        interactive: median(runs.map((run) => run.interactive)),
        longTaskMs: median(runs.map((run) => run.longTaskMs)),
        scripts: median(runs.map((run) => run.scripts)),
        scriptKiB: median(runs.map((run) => run.scriptKiB)),
        apiRequests: median(runs.map((run) => run.apiRequests)),
        apiWaterfall: median(runs.map((run) => run.apiWaterfall)),
        apiUrls: runs[0].apiUrls,
      };
    }

    // Fresh session for transitions: cold means the route's data has never been
    // fetched in this document. A merchant reads Home for a few seconds first;
    // the everyday screens' code is fetched in that time (lib/warm-route-code.ts).
    await load(`${admin}/admin`, homeReady, { cold: true });
    await sleep(options.settleMs ?? 2500);

    async function transition(step, pass) {
      progress(`${pass} ${step.name}`);
      const box = await evaluate(`(() => {
        const candidates = [...document.querySelectorAll(${JSON.stringify(step.link)})].filter((el) => el.getClientRects().length);
        const el = candidates[0];
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const rect = el.getBoundingClientRect();
        return { x: rect.x + Math.min(rect.width / 2, 40), y: rect.y + rect.height / 2, href: el.getAttribute("href") };
      })()`);
      if (!box) return { name: step.name, pass, ok: false, error: `link not found: ${step.link}` };
      await evaluate(`window.__perf.longTasks.length = 0; document.querySelectorAll("h1").forEach((el) => el.setAttribute("data-perf-stale", ""))`);
      requests.clear();
      const wallStart = Date.now();
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
      await sleep(options.hoverMs ?? 120);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
      const waited = await evaluate(`window.__perfReady(${JSON.stringify(readyPredicate(step.path, step.selector))}, 20000)`);
      const t0 = await evaluate("window.__perf.t0");
      await sleep(600);
      const longTasks = await evaluate("window.__perf.longTasks");
      const apiRequests = [...requests.values()].filter((request) => request.start >= 0);
      const d1 = options.explorer ? await readD1Calls(options.explorer, wallStart, Date.now()) : null;
      return {
        name: step.name,
        pass,
        ok: waited.ok,
        ms: round(waited.at - t0),
        longTaskMs: round(longTasks.reduce((sum, [, duration]) => sum + duration, 0)),
        apiRequests: apiRequests.length,
        apiWaterfall: waterfallDepth(apiRequests),
        apiUrls: apiRequests.map((request) => request.url.replace(/\?.*$/, "")),
        ...(d1 ? { d1Calls: d1.d1Calls, d1Ms: d1.d1Ms } : {}),
      };
    }

    const steps = [
      { name: "Home → Orders", link: "a[href$='/admin/orders']", path: "^/admin/orders/?$", selector: "tbody tr a" },
      { name: "Orders → Order", link: "tbody a[href*='/admin/orders/']", path: "^/admin/orders/[^/]+/?$", selector: null },
      { name: "Order → Products", link: "nav a[href$='/admin/products']", path: "^/admin/products/?$", selector: "tbody tr a" },
      { name: "Products → Product editor", link: "tbody a[href$='/edit']", path: "^/admin/products/[^/]+/edit$", selector: "input" },
      { name: "Product → Inventory", link: "nav a[href$='/admin/inventory']", path: "^/admin/inventory/?$", selector: "tbody tr" },
      { name: "Inventory → Customers", link: "nav a[href$='/admin/customers']", path: "^/admin/customers/?$", selector: "tbody tr a" },
      { name: "Customers → Settings", link: "a[href$='/admin/settings']", path: "^/admin/settings", selector: null },
      { name: "Settings → Home", link: "header a[href$='/admin']", path: "^/admin/?$", selector: HOME_DATA },
    ];
    for (const pass of ["cold", "warm"]) {
      for (const step of steps) {
        const result = await transition(step, pass);
        report.transitions.push(result);
        if (!result.ok) break;
      }
    }

    if (options.typingProduct) {
      await load(`${admin}/admin/products/${options.typingProduct}/edit`, readyPredicate("/edit$", "input"), { cold: false });
      await evaluate(`(() => { const el = document.querySelector("#admin-main-scroll input[name='name'], #admin-main-scroll input"); el.focus(); el.select?.(); window.__perf.events.length = 0; return true; })()`);
      const text = "Cotton panjabi test";
      for (const char of text) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: char, key: char, unmodifiedText: char });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
        await sleep(60);
      }
      await sleep(500);
      const events = await evaluate("window.__perf.events.filter(([name]) => name === 'keydown' || name === 'keypress' || name === 'input' || name === 'beforeinput')");
      const perKey = events.map(([, , duration]) => duration);
      report.typing = {
        keystrokes: text.length,
        over16ms: perKey.length,
        maxMs: round(perKey.length ? Math.max(...perKey) : 16),
        p95Ms: round(perKey.length ? [...perKey].sort((a, b) => a - b)[Math.floor(perKey.length * 0.95)] : 16),
      };
    }

    cdp.ws.close();
  } finally {
    chrome.kill("SIGTERM");
    await sleep(300);
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
    rmSync(profileDir, { recursive: true, force: true });
  }

  return report;
}

export function validateRuntimeReport(report, budgets = RUNTIME_BUDGETS) {
  const failures = [];
  const cold = report.firstLoad.cold;
  if (!cold?.ok) failures.push("first load never became ready");
  else if (cold.ready > budgets.firstLoadReadyMs) failures.push(`first load ready ${cold.ready}ms (budget ${budgets.firstLoadReadyMs}ms)`);
  for (const step of report.transitions) {
    if (!step.ok) {
      failures.push(`${step.pass} ${step.name}: ${step.error ?? "never became ready"}`);
      continue;
    }
    const budget = step.pass === "warm" ? budgets.warmTransitionMs : budgets.coldTransitionMs;
    if (step.ms > budget) failures.push(`${step.pass} ${step.name}: ${step.ms}ms (budget ${budget}ms)`);
  }
  if (report.typing && report.typing.maxMs > budgets.keystrokeMs) {
    failures.push(`product editor keystroke ${report.typing.maxMs}ms (budget ${budgets.keystrokeMs}ms)`);
  }
  return failures;
}

export function formatRuntimeReport(report) {
  const network = report.latencyMs || report.downloadMbps ? `, ${report.latencyMs}ms RTT, ${report.downloadMbps ?? "∞"} Mbps` : "";
  const lines = [`Dashboard runtime (${report.admin}, CPU ×${report.cpuThrottle}${network})`];
  for (const [mode, load] of Object.entries(report.firstLoad)) {
    lines.push(`  first load ${mode}: FCP ${load.fcp}ms, ready ${load.ready}ms, interactive ${load.interactive}ms, long tasks ${load.longTaskMs}ms, JS ${load.scripts} files ${load.scriptKiB} KiB, API ${load.apiRequests} (waterfall ${load.apiWaterfall})`);
  }
  for (const step of report.transitions) {
    const d1 = step.d1Calls == null ? "" : `, D1 ${step.d1Calls} calls ${step.d1Ms}ms`;
    lines.push(step.ok
      ? `  ${step.pass.padEnd(4)} ${step.name.padEnd(28)} ${String(step.ms).padStart(5)}ms  long tasks ${step.longTaskMs}ms, API ${step.apiRequests} (waterfall ${step.apiWaterfall})${d1}`
      : `  ${step.pass.padEnd(4)} ${step.name.padEnd(28)} FAILED ${step.error ?? "not ready"}`);
  }
  if (report.typing) lines.push(`  product editor typing: max ${report.typing.maxMs}ms, p95 ${report.typing.p95Ms}ms (${report.typing.over16ms} events over 16ms)`);
  if (report.errors.length) lines.push(`  page errors: ${report.errors.slice(0, 5).join(" | ")}`);
  return lines;
}

export async function writeRuntimeJson(file, report) {
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
}
