// Card hover-image latency (AUDIT §5.3): is the second photo loaded before
// the pointer arrives, how long until it is painted after pointerenter at
// 10 Mbps / 60 ms, and what hover costs in image bytes. Run through check.mjs.
import { sleep } from "./lib/proc.mjs";
import { applyTheme } from "./lib/theme.mjs";
import { MENUS } from "./menus.mjs";

const CARD = "document.querySelectorAll('[data-theme-component=product-card]')";

/** `targets`: "boutique", or "department-mall:hover" to force hoverImage on. */
export async function runHover(ctx, { targets, path, net = { latency: 60, mbps: 10 } }) {
  const { page, base, log } = ctx;
  const all = {};
  for (const target of targets) {
    const [template, force] = target.split(":");
    await applyTheme(ctx, template, { menu: MENUS["150"], sets: force ? { "blocks.card.settings.hoverImage": true } : {} });
    await page.profile("desktop");
    await page.send("Network.emulateNetworkConditions", { offline: false, latency: net.latency, downloadThroughput: (net.mbps * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8 });
    await page.send("Network.clearBrowserCache");
    const got = new Map();
    const off = page.on((m) => {
      if (m.method === "Network.requestWillBeSent") got.set(m.params.requestId, { url: m.params.request.url });
      if (m.method === "Network.loadingFinished") { const r = got.get(m.params.requestId); if (r) r.bytes = m.params.encodedDataLength; }
    });
    try {
      await page.nav(base + path, { settle: 1000 });
      const before = await page.eval(`(() => [...${CARD}].map((c, i) => { const h = [...c.querySelectorAll('.product-card-media img')][1];
        return h ? { i, src: (h.currentSrc || h.src || '').replace(/^.*\\/media\\//, ''), loading: h.getAttribute('loading'), complete: h.complete && h.naturalWidth > 0 } : { i, none: true }; }))()`);
      const hoverCards = before.filter((b) => !b.none);
      const results = [];
      for (const idx of [0, 5, 10, 17]) {
        if (!before[idx] || before[idx].none) continue;
        await page.eval(`${CARD}[${idx}].scrollIntoView({ block: 'center' })`);
        await sleep(300);
        const pre = await page.eval(`(() => { const h = ${CARD}[${idx}].querySelectorAll('.product-card-media img')[1]; return { complete: h.complete && h.naturalWidth > 0, src: (h.currentSrc || '').replace(/^.*\\/media\\//, '') }; })()`);
        const box = await page.eval(`(() => { const r = ${CARD}[${idx}].querySelector('.product-card-media').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
        const ms = await page.eval(`(async () => { const h = ${CARD}[${idx}].querySelectorAll('.product-card-media img')[1]; const s = performance.now();
          while (performance.now() - s < 8000) { const op = parseFloat(getComputedStyle(h).opacity); if (h.complete && h.naturalWidth > 0 && op > 0.95) return Math.round(performance.now() - s); await new Promise(r => requestAnimationFrame(r)); } return -1; })()`);
        results.push({ idx, preloadedBeforeHover: pre.complete, src: pre.src, visibleAfterMs: ms });
        await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
        await sleep(200);
      }
      const reqs = [...got.values()].filter((r) => /\/media\//.test(r.url));
      all[target] = { cardsWithHover: hoverCards.length, lazyAttr: hoverCards[0]?.loading ?? null, completeAtLoad: before.filter((b) => b.complete).length, results,
        imageRequests: reqs.length, imageKB: Math.round(reqs.reduce((a, r) => a + (r.bytes || 0), 0) / 1024) };
      log(`  hover ${target}: ${results.map((r) => `#${r.idx} ${r.visibleAfterMs}ms${r.preloadedBeforeHover ? " (preloaded)" : ""}`).join(", ") || "no hover photos"} | ${all[target].imageKB}KB images`);
    } finally {
      off();
      await page.profile("desktop");
    }
  }
  return all;
}
