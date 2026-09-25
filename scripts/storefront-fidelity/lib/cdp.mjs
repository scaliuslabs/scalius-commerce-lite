// Minimal CDP driver: one headless Chrome the harness starts itself (own
// profile directory, own port), one tab at a time. No Playwright.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleep, startGroup, killTree } from "./proc.mjs";

export const PROFILES = Object.freeze({
  phone: {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    net: { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
    cpu: 4,
  },
  desktop: {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    net: null,
    cpu: 1,
  },
});

const CHROME_CANDIDATES = [
  process.env.SCALIUS_FIDELITY_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

export class Chrome {
  constructor({ port, profileDir, logFile }) {
    this.port = port;
    this.profileDir = profileDir;
    this.logFile = logFile;
    this.child = null;
  }

  async start() {
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(800) });
      if (r.ok) throw new Error(`Something already listens on CDP port ${this.port}; stop it or pass --chrome-port.`);
    } catch (error) {
      if (error.message?.startsWith("Something")) throw error;
    }
    const exe = CHROME_CANDIDATES.find((p) => existsSync(p));
    if (!exe) throw new Error("No Chrome/Chromium found; set SCALIUS_FIDELITY_CHROME.");
    mkdirSync(this.profileDir, { recursive: true });
    this.child = startGroup("chrome", exe, [
      `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.profileDir}`, "--headless=new",
      "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1440,900", "--disable-background-networking", "--disable-component-update",
      "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--mute-audio",
      // Memory: one renderer, no spare renderer, no site-per-process split.
      "--renderer-process-limit=1", "--disable-site-isolation-trials", "--disk-cache-size=67108864",
      "--disable-features=site-per-process,IsolateOrigins,SpareRendererForSitePerProcess,Translate,OptimizationHints,MediaRouter,AutofillServerCommunication",
    ], { logFile: this.logFile });
    for (let i = 0; i < 100; i += 1) {
      await sleep(200);
      try {
        if ((await fetch(`http://127.0.0.1:${this.port}/json/version`)).ok) return;
      } catch { /* best effort */ }
    }
    throw new Error("headless Chrome did not start");
  }

  async stop() {
    if (this.child) await killTree(this.child.pid);
    this.child = null;
  }

  async newPage(outDir) {
    // Reuse Chrome's initial blank tab: an idle second renderer costs memory.
    this.used ??= new Set();
    const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
    const blank = list.find((t) => t.type === "page" && t.url === "about:blank" && !this.used.has(t.id));
    const target = blank ?? await (await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: "PUT" })).json();
    this.used.add(target.id);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
    const page = new Page(ws, target.id, this.port, outDir);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Network.enable");
    return page;
  }
}

export class Page {
  constructor(ws, targetId, port, outDir) {
    this.ws = ws;
    this.targetId = targetId;
    this.port = port;
    this.outDir = outDir;
    this.id = 1;
    this.pending = new Map();
    this.listeners = [];
    this.inflight = new Map(); // requestId -> start time
    ws.addEventListener("message", (event) => {
      const m = JSON.parse(event.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
        return;
      }
      if (!m.method) return;
      if (m.method === "Network.requestWillBeSent") this.inflight.set(m.params.requestId, Date.now());
      else if (m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") this.inflight.delete(m.params.requestId);
      for (const l of this.listeners) l(m);
    });
  }

  on(fn) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((x) => x !== fn); };
  }

  send(method, params = {}, timeoutMs = 90000) {
    const id = this.id++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout ${method}`));
        }
      }, timeoutMs).unref();
    });
  }

  async profile(name, { throttle = false, width, height } = {}) {
    const p = PROFILES[name];
    await this.send("Emulation.setDeviceMetricsOverride", { width: width ?? p.width, height: height ?? p.height, deviceScaleFactor: p.deviceScaleFactor, mobile: p.mobile });
    await this.send("Emulation.setTouchEmulationEnabled", { enabled: p.mobile });
    await this.send("Network.setUserAgentOverride", { userAgent: p.ua });
    await this.send("Emulation.setCPUThrottlingRate", { rate: throttle ? p.cpu : 1 });
    if (throttle && p.net) await this.send("Network.emulateNetworkConditions", { offline: false, ...p.net });
    else await this.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  }

  /**
   * Navigates and waits for `load`, web fonts, and a network-quiet window
   * (no request in flight for `quietMs`), bounded by `timeout`.
   */
  async nav(url, { settle = 250, quietMs = 300, timeout = 60000, recentMs = 5000 } = {}) {
    await this.idle(3000);
    this.inflight.clear();
    await this.send("Page.navigate", { url });
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        if (await this.eval("document.readyState === 'complete'")) break;
      } catch { /* best effort */ }
      await sleep(100);
    }
    try { await this.eval("document.fonts ? document.fonts.ready.then(() => true) : true"); } catch { /* best effort */ }
    let quietSince = Date.now();
    while (Date.now() < end) {
      if (this.busy(recentMs) > 0) quietSince = Date.now();
      else if (Date.now() - quietSince >= quietMs) break;
      await sleep(50);
    }
    await sleep(settle);
  }

  /**
   * Waits until no request is in flight (up to `maxMs`). Leaving a page while
   * throttled image downloads are mid-stream aborts them, and a burst of
   * aborted responses has taken down local `wrangler dev`.
   */
  async idle(maxMs = 30000) {
    const end = Date.now() + maxMs;
    while (this.busy(maxMs) > 0 && Date.now() < end) await sleep(100);
    return this.busy(maxMs) === 0;
  }

  /** Requests in flight that started less than `recentMs` ago (a stuck or streaming request stops counting). */
  busy(recentMs = 5000) {
    const now = Date.now();
    let n = 0;
    for (const t of this.inflight.values()) if (now - t < recentMs) n += 1;
    return n;
  }

  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  /** Screenshot to `<outDir>/<name>.jpg`; `full` caps at 9000px. */
  async shot(name, { full = false, quality = 70, clip = null } = {}) {
    const params = { format: "jpeg", quality, captureBeyondViewport: full };
    if (clip) {
      params.clip = { ...clip, scale: 1 };
      params.captureBeyondViewport = true;
    }
    if (full) {
      const h = await this.eval("Math.min(document.documentElement.scrollHeight, 9000)");
      const w = await this.eval("window.innerWidth");
      params.clip = { x: 0, y: 0, width: w, height: h, scale: 1 };
    }
    const r = await this.send("Page.captureScreenshot", params);
    mkdirSync(this.outDir, { recursive: true });
    const file = join(this.outDir, `${name}.jpg`);
    writeFileSync(file, Buffer.from(r.data, "base64"));
    return file;
  }

  async close() {
    try { await fetch(`http://127.0.0.1:${this.port}/json/close/${this.targetId}`); } catch { /* best effort */ }
    try { this.ws.close(); } catch { /* best effort */ }
  }
}
