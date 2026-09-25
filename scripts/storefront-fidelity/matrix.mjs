// Fidelity matrix (AUDIT §1, §2): every template x page x viewport -> probe
// JSON (layout, type, card, listing density, facet column, buy box, footer,
// weights) plus a first-screen screenshot. Run through check.mjs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_DIR } from "./lib/context.mjs";
import { applyTheme } from "./lib/theme.mjs";
import { MENUS } from "./menus.mjs";

export const PROBE = readFileSync(join(HARNESS_DIR, "probe.js"), "utf8");
export const SCROLL_THROUGH = "(async () => { const H = Math.min(document.documentElement.scrollHeight, 12000); for (let y = 0; y < H; y += 700) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } scrollTo(0, 0); await new Promise((r) => setTimeout(r, 250)); return true; })()";

/** Loads `url`, lets lazy content react to one scroll pass, then probes. */
export async function probePage(page, url) {
  await page.nav(url);
  await page.eval(SCROLL_THROUGH);
  try {
    return await page.eval(PROBE);
  } catch (error) {
    return { error: error.message };
  }
}

const JSON_LD = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;

/** Server HTML weights of a page (bytes as sent, JSON-LD bytes). */
export async function htmlWeights(base, path) {
  const r = await fetch(base + path, { headers: { "User-Agent": "scalius-fidelity" } });
  const html = await r.text();
  let jsonLd = 0;
  for (const m of html.matchAll(JSON_LD)) jsonLd += Buffer.byteLength(m[1]);
  return { status: r.status, bytes: Buffer.byteLength(html), jsonLdBytes: jsonLd };
}

/**
 * @returns {Promise<Record<string, Record<string, object>>>} template -> "page-viewport" -> probe
 */
export async function runMatrix(ctx, { templates, pages, viewports = ["desktop", "phone"], menu = MENUS["150"], prefix = "ours", into = {} }) {
  const { page, base, log } = ctx;
  const all = into;
  for (const template of templates) {
    if (all[template]?.weights) continue; // done before a stack restart
    await applyTheme(ctx, template, { menu });
    all[template] = {};
    const weights = {};
    for (const viewport of viewports) {
      await page.profile(viewport);
      for (const [name, path] of Object.entries(pages)) {
        const m = await probePage(page, base + path);
        all[template][`${name}-${viewport}`] = m;
        await page.shot(`${prefix}-${template}-${name}-${viewport === "phone" ? "m" : "d"}-top`);
        if (viewport === "desktop") {
          weights[name] = await htmlWeights(base, path);
          weights[name].headerBytes = m.bytes?.siteHeader ?? null;
          weights[name].headerAnchors = m.siteHeaderLinksInHtml ?? null;
        }
      }
    }
    all[template].weights = weights;
    const listingName = Object.keys(pages).find((n) => n !== "home" && !/^pdp/.test(n) && n !== "search") ?? "home";
    const l = all[template][`${listingName}-desktop`];
    const kb = Object.entries(weights).map(([n, w]) => `${n} ${Math.round(w.bytes / 1024)}KB`).join(" ");
    log(`  ${prefix} ${template}: ${listingName} card ${l?.card?.w}x${l?.card?.h} cols ${l?.density?.cols} first y ${l?.density?.firstCardTop} filters ${l?.density?.filterControlsVisible} groups ${l?.listing?.facetGroups ?? 0} | html ${kb}`);
  }
  return all;
}
