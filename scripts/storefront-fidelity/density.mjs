#!/usr/bin/env node
// Listing density of the LIVE reference sites (AUDIT §0): products at least
// 50% visible in the first screen, filter controls visible without a click,
// the first card's y, and the bottom of the 20th product, plus the facet
// column's row pitch, label size and width. Our own pages get the same numbers
// from probe.js inside `pnpm fidelity:check`; this script only refreshes the
// reference side of reference-metrics.json. Read-only public page loads; a
// site may show a cookie dialog, which is never accepted.
//
//   node scripts/storefront-fidelity/density.mjs [--only daraz,startech] [--out refs.json] [--chrome-port 9601]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Chrome } from "./lib/cdp.mjs";

export const REFERENCE_LISTINGS = Object.freeze({
  startech: { url: "https://www.startech.com.bd/laptop-notebook", sel: ".p-item" },
  applegadgets: { url: "https://www.applegadgetsbd.com/category/mobile-phone", sel: "article, .product-card, [class*=ProductCard]" },
  daraz: { url: "https://www.daraz.com.bd/catalog/?q=ssd", sel: "[data-qa-locator=product-item]" },
  amazon_uk: { url: "https://www.amazon.co.uk/s?k=laptop+bag", sel: "[data-component-type=s-search-result]" },
  dawn: { url: "https://theme-dawn-demo.myshopify.com/collections/bags", sel: ".grid__item .card-wrapper" },
});

/** The density expression for any card selector (same math as probe.js). */
export function densityExpression(cardSel) {
  return `(async () => {
  const H = innerHeight, W = innerWidth;
  for (let y = 0; y < 6000; y += 800) { scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }
  scrollTo(0, 0); await new Promise(r => setTimeout(r, 400));
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none'; };
  let cards = [...document.querySelectorAll(${JSON.stringify(cardSel)})].filter(vis);
  cards = cards.filter(c => !cards.some(o => o !== c && o.contains(c)));
  const rects = cards.map(c => { const r = c.getBoundingClientRect(); return { top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left, h: r.height, w: r.width }; })
    .filter(r => r.w > 60 && r.h > 60).sort((a, b) => a.top - b.top || a.left - b.left);
  const inView = rects.filter(r => { const vh = Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0)); return vh >= r.h * 0.5; }).length;
  const boxes = [...document.querySelectorAll('input[type=checkbox], input[type=radio], [role=checkbox], .a-checkbox, input[type=range], input[type=number]')].filter(vis);
  const filterInView = boxes.filter(b => { const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= H && r.left < W * 0.35; }).length;
  const nth = (n) => rects[n - 1] ? Math.round(rects[n - 1].bottom) : null;
  const fboxes = [...document.querySelectorAll('input[type=checkbox], .a-checkbox, [role=checkbox]')].filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.left < W * 0.35; });
  const ys = fboxes.map(b => b.getBoundingClientRect().top + scrollY).sort((a, b) => a - b); const gaps = [];
  for (let i = 1; i < ys.length; i++) { const g = ys[i] - ys[i - 1]; if (g > 5 && g < 60) gaps.push(Math.round(g)); } gaps.sort((a, b) => a - b);
  const lab = fboxes[0] ? (fboxes[0].closest('label') || fboxes[0].parentElement) : null;
  let colW = null; if (fboxes[0]) { let e = fboxes[0]; while (e && e.getBoundingClientRect().width < 150) e = e.parentElement; colW = e ? Math.round(e.getBoundingClientRect().width) : null; }
  return { vw: W, vh: H, cards: rects.length, firstCardTop: rects[0] ? Math.round(rects[0].top) : null, cardW: rects[0] ? Math.round(rects[0].w) : null, cardH: rects[0] ? Math.round(rects[0].h) : null,
    cols: rects.length ? rects.filter(r => Math.abs(r.top - rects[0].top) < 4).length : 0, productsFullyHalfVisible: inView, filterControlsVisible: filterInView,
    bottomOf8: nth(8), bottomOf20: nth(20), facetRowPitch: gaps[Math.floor(gaps.length / 2)] ?? null, facetLabelFont: lab ? parseFloat(getComputedStyle(lab).fontSize) : null, facetColumnW: colW };
})()`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const arg = (n, f) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : f; };
  const only = arg("--only", "")?.split(",").filter(Boolean);
  const profileDir = mkdtempSync(join(tmpdir(), "scalius-fidelity-density-"));
  const chrome = new Chrome({ port: Number(arg("--chrome-port", 9601)), profileDir });
  const out = {};
  try {
    await chrome.start();
    const page = await chrome.newPage(profileDir);
    for (const [site, ref] of Object.entries(REFERENCE_LISTINGS).filter(([k]) => !only?.length || only.includes(k))) {
      for (const viewport of ["desktop", "phone"]) {
        try {
          await page.profile(viewport);
          await page.nav(ref.url, { settle: 3000, timeout: 45000 });
          out[`${site}-${viewport}`] = await page.eval(densityExpression(ref.sel));
          console.log(site, viewport, JSON.stringify(out[`${site}-${viewport}`]));
        } catch (error) {
          console.log(site, viewport, "ERR", error.message);
        }
      }
    }
    await page.close();
  } finally {
    await chrome.stop();
    rmSync(profileDir, { recursive: true, force: true });
  }
  if (arg("--out")) writeFileSync(arg("--out"), JSON.stringify(out, null, 1));
}
