// Built-stack performance (AUDIT §5): TTFB miss (forced by the store dependency
// clock) and hit, and in the browser LCP, CLS, INP-ish and bytes by type
// on the phone profile (390x844 DPR 3, 150 ms RTT, 1.6 Mbps, 4x CPU) and the
// desktop profile (1440x900, unthrottled). Run through check.mjs.
import { sleep } from "./lib/proc.mjs";
import { applyTheme, forceCacheRefresh } from "./lib/theme.mjs";
import { withSeenSeq } from "../storefront-perf.mjs";
import { htmlWeights } from "./matrix.mjs";
import { MENUS } from "./menus.mjs";

const OBSERVE = `(() => { window.__perf = { lcp: 0, lcpEl: null, cls: 0, events: [] };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__perf.lcp = e.startTime; window.__perf.lcpEl = (e.element && (e.element.tagName + '.' + (e.element.className || '').toString().slice(0, 40))) || (e.url || '').slice(-60); } }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.events.push({ n: e.name, d: Math.round(e.duration) }); }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
})();`;

async function timeFetch(url) {
  const t0 = performance.now();
  const r = await fetch(url, { headers: { "User-Agent": "scalius-fidelity-perf" } });
  const ms = Math.round(performance.now() - t0);
  const body = await r.arrayBuffer();
  return { ms, cache: r.headers.get("x-cache-status"), bytes: body.byteLength, status: r.status };
}

export async function ttfbRuns(ctx, path, runs = 3) {
  const out = [];
  for (let i = 0; i < runs; i += 1) {
    const seq = forceCacheRefresh(ctx);
    const miss = await timeFetch(withSeenSeq(ctx.base + path, seq));
    if (miss.status !== 200 || !["MISS", "REFRESH"].includes(miss.cache)) {
      throw new Error(`${path}: forced miss returned ${miss.cache} (${miss.status})`);
    }
    const hit1 = await timeFetch(ctx.base + path);
    const hit2 = await timeFetch(ctx.base + path);
    const hits = [hit1, hit2].filter((sample) => sample.status === 200 && sample.cache === "HIT");
    if (!hits.length) throw new Error(`${path}: no verified HIT samples`);
    out.push({ miss: miss.ms, missCache: miss.cache, hit: Math.min(...hits.map((sample) => sample.ms)), hitCache: "HIT", htmlKB: Math.round(miss.bytes / 1024), status: miss.status });
  }
  return out;
}

export async function browserRun(page, url, profile) {
  await page.profile(profile, { throttle: profile === "phone" });
  await page.send("Network.clearBrowserCache");
  await page.send("Network.setCacheDisabled", { cacheDisabled: false });
  const reqs = new Map();
  const off = page.on((m) => {
    if (m.method === "Network.requestWillBeSent") reqs.set(m.params.requestId, { url: m.params.request.url, type: m.params.type });
    else if (m.method === "Network.responseReceived") { const r = reqs.get(m.params.requestId); if (r) r.type = m.params.type; }
    else if (m.method === "Network.loadingFinished") { const r = reqs.get(m.params.requestId); if (r) r.bytes = m.params.encodedDataLength; }
  });
  const { identifier } = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: OBSERVE });
  try {
    const t0 = Date.now();
    await page.nav(url, { settle: profile === "phone" ? 1500 : 500, quietMs: profile === "phone" ? 800 : 300, timeout: 90000, recentMs: 60000 });
    const loadMs = Date.now() - t0;
    const target = await page.eval("(() => { const el = document.querySelector('[data-option-definition-id] button:not([disabled]), [data-option-definition-id] label, #quantity-plus'); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
    if (target) {
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: target.x, y: target.y, button: "left", clickCount: 1 });
      await sleep(profile === "phone" ? 1000 : 400);
    }
    const perf = await page.eval("({ lcp: Math.round(window.__perf.lcp), lcpEl: window.__perf.lcpEl, cls: +window.__perf.cls.toFixed(3), inp: Math.max(0, ...window.__perf.events.map(e => e.d)) })");
    const list = [...reqs.values()].filter((r) => r.bytes != null);
    const sum = (f) => list.filter(f).reduce((a, r) => a + r.bytes, 0);
    const isImg = (r) => r.type === "Image" || /\.(webp|jpe?g|png|avif|gif)(\?|$)/.test(r.url);
    const imgs = list.filter(isImg);
    return {
      loadMs, ...perf, requests: list.length, totalKB: Math.round(sum(() => true) / 1024),
      jsKB: Math.round(sum((r) => r.type === "Script") / 1024), cssKB: Math.round(sum((r) => r.type === "Stylesheet") / 1024),
      fontKB: Math.round(sum((r) => r.type === "Font") / 1024), imgKB: Math.round(sum(isImg) / 1024), imgCount: imgs.length,
      mediaKB: Math.round(sum((r) => r.type === "Media" || /\.mp4/.test(r.url)) / 1024),
      originals: imgs.filter((r) => /\/media\/.*\.(jpe?g|png)(\?|$)/.test(r.url)).length,
      biggestImgs: imgs.sort((a, b) => b.bytes - a.bytes).slice(0, 3).map((r) => `${Math.round(r.bytes / 1024)}KB ${r.url.replace(/^.*\/media\//, "")}`),
    };
  } finally {
    await page.idle(15000);
    await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    off();
    await page.profile(profile);
  }
}

/**
 * @param {Record<string,string>} pages name -> path
 * @returns template -> page -> row
 */
export async function runPerf(ctx, { templates, pages, runs = 1, ttfbRunsPerPage = 3, into = {} }) {
  const { page, base, log } = ctx;
  const all = into;
  for (const template of templates) {
    all[template] ??= {};
    if (Object.keys(pages).every((name) => all[template][name])) continue; // done before a stack restart
    await applyTheme(ctx, template, { menu: MENUS["150"] });
    for (const [name, path] of Object.entries(pages)) {
      if (all[template][name]) continue;
      const row = { path, ttfb: await ttfbRuns(ctx, path, ttfbRunsPerPage) };
      row.html = await htmlWeights(base, path);
      for (const profile of ["phone", "desktop"]) {
        const samples = [];
        for (let i = 0; i < runs; i += 1) samples.push(await browserRun(page, base + path, profile));
        samples.sort((a, b) => a.lcp - b.lcp);
        row[profile] = { ...samples[Math.floor(samples.length / 2)], lcpRuns: samples.map((s) => s.lcp), cls: Math.max(...samples.map((s) => s.cls)) };
      }
      all[template][name] = row;
      log(`  perf ${template} ${name}: ttfb miss/hit ${row.ttfb.map((t) => `${t.miss}/${t.hit}`).join(" ")} | phone LCP ${row.phone.lcp} (${row.phone.lcpEl}) img ${row.phone.imgKB}KB | desktop LCP ${row.desktop.lcp} | html ${Math.round(row.html.bytes / 1024)}KB`);
    }
  }
  return all;
}
