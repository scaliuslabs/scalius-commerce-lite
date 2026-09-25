// Distinctness (AUDIT §2.1, §2.2): one template's tokens held fixed, ONE block
// variant swapped at a time (what a merchant does in the dashboard). Every
// card variant's first card is cropped and compared pixel by pixel with every
// other variant (share of pixels differing by more than 28 grey levels), and
// every listing layout is probed. Run through check.mjs.
import { join } from "node:path";
import { loadSharp } from "./lib/context.mjs";
import { pixelDiffPct } from "./lib/compare.mjs";
import { sleep } from "./lib/proc.mjs";
import { applyTheme, variantNames } from "./lib/theme.mjs";
import { probePage } from "./matrix.mjs";
import { MENUS } from "./menus.mjs";

const CROP = { width: 200, height: 300 };

async function greyCrop(sharp, file) {
  return sharp(file).resize(CROP.width, CROP.height, { fit: "fill" }).greyscale().raw().toBuffer();
}

/** For each variant: its nearest other variant and the pixel difference. */
export async function nearestDiffs(files, viewport) {
  const sharp = await loadSharp();
  const names = Object.keys(files);
  const buffers = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await greyCrop(sharp, files[n])])));
  const pairs = {};
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) pairs[`${names[i]}~${names[j]}`] = pixelDiffPct(buffers[names[i]], buffers[names[j]]);
  }
  return {
    pairs,
    nearest: names.map((a) => {
      let best = null;
      for (const b of names) {
        if (a === b) continue;
        const pct = pairs[`${a}~${b}`] ?? pairs[`${b}~${a}`];
        if (!best || pct < best.pct) best = { a, b, pct, viewport };
      }
      return best;
    }).filter(Boolean),
  };
}

export async function runVariants(ctx, { template = "department-mall", path }) {
  const { page, base, log, shotsDir } = ctx;
  const { card: cards, listing: layouts } = await variantNames();
  const out = { template, cards: {}, listings: {}, diffs: [] };
  const files = { desktop: {}, phone: {} };
  for (const v of cards) {
    await applyTheme(ctx, template, { menu: MENUS["150"], sets: { "blocks.card.variant": v } });
    for (const viewport of ["desktop", "phone"]) {
      await page.profile(viewport);
      const m = await probePage(page, base + path);
      out.cards[`${v}-${viewport}`] = m.card ?? null;
      const c = m.card;
      if (c) {
        await sleep(150);
        const name = `card-${template}-${v}-${viewport === "phone" ? "m" : "d"}`;
        await page.shot(name, { clip: { x: c.x, y: c.y, width: c.w, height: Math.min(c.h, 900) } });
        files[viewport][v] = join(shotsDir, `${name}.jpg`);
      }
    }
  }
  for (const viewport of ["desktop", "phone"]) {
    if (Object.keys(files[viewport]).length < 2) continue;
    const { pairs, nearest } = await nearestDiffs(files[viewport], viewport);
    out[`pairs-${viewport}`] = pairs;
    out.diffs.push(...nearest);
  }
  log(`  variants ${template} cards: ${out.diffs.filter((d) => d.viewport === "desktop").map((d) => `${d.a}~${d.b} ${d.pct}%`).join(", ")}`);
  for (const v of layouts) {
    await applyTheme(ctx, template, { menu: MENUS["150"], sets: { "blocks.listing.layout.variant": v } });
    for (const viewport of ["desktop", "phone"]) {
      await page.profile(viewport);
      const m = await probePage(page, base + path);
      // No markup names the rendered layout, so describe what is on screen:
      // a visible filter sidebar, a filter bar, the grid's columns, shelves.
      const layout = [
        m.listing?.filterBox ? "sidebar" : null,
        m.listing?.phoneBar ? "filter-bar" : null,
        await page.eval("(() => { const b = document.querySelector('[data-catalog-filter-bar]'); const r = b && b.getBoundingClientRect(); return r && r.width > 0 && r.height > 0 ? 'chip-bar' : null; })()"),
        m.density?.cols ? `${m.density.cols}-col` : null,
      ].filter(Boolean).join("+") || "none";
      out.listings[`${v}-${viewport}`] = { layout, listing: m.listing ?? null, density: m.density ?? null, card: m.card ? { w: m.card.w, h: m.card.h, cols: m.card.cols } : null };
      await page.shot(`listing-${template}-${v}-${viewport === "phone" ? "m" : "d"}`);
    }
  }
  log(`  variants ${template} listings: ${layouts.map((v) => `${v}->${out.listings[`${v}-desktop`]?.layout ?? "?"}`).join(", ")}`);
  return out;
}
