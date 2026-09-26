// Applies a template (plus single-block variant swaps, what a merchant does in
// the dashboard) to the harness state; DVC triggers track the changed rows.
import { importTs, tx } from "./context.mjs";
import { sleep } from "./proc.mjs";
import { FORCE_MISS_SQL } from "../../storefront-perf.mjs";

let modules;
export async function themeModules() {
  if (!modules) {
    const [T, D, B] = await Promise.all([
      importTs("packages/shared/src/storefront-theme/templates.ts"),
      importTs("packages/shared/src/storefront-theme/document.ts"),
      importTs("packages/shared/src/storefront-theme/blocks.ts"),
    ]);
    modules = { T, D, B };
  }
  return modules;
}

function setPath(doc, path, raw) {
  const keys = path.split(".");
  let o = doc;
  for (const k of keys.slice(0, -1)) {
    o[k] ??= {};
    o = o[k];
  }
  let v = raw;
  if (typeof raw === "string") {
    try { v = JSON.parse(raw); } catch { /* best effort */ }
  }
  o[keys.at(-1)] = v;
}

/**
 * Builds a validated theme document: the template's defaults, then `sets`
 * ({ "blocks.card.variant": "spec", ... }). A variant swap resets that block's
 * settings to the new variant's defaults, as the dashboard does.
 */
export async function buildThemeDocument(template, sets = {}) {
  const { T, D, B } = await themeModules();
  const doc = structuredClone(T.storefrontTemplateTheme(template));
  const registries = {
    card: B.STOREFRONT_CARD_VARIANTS, desktopNav: B.STOREFRONT_DESKTOP_NAV_VARIANTS, header: B.STOREFRONT_HEADER_VARIANTS,
    mobileNav: B.STOREFRONT_MOBILE_NAV_VARIANTS, footer: B.STOREFRONT_FOOTER_VARIANTS, topBar: B.STOREFRONT_TOP_BAR_VARIANTS,
  };
  for (const [path, value] of Object.entries(sets)) {
    setPath(doc, path, value);
    const block = /^blocks\.(\w+)\.variant$/.exec(path)?.[1];
    if (block && registries[block]?.[value]) doc.blocks[block].settings = { ...(registries[block][value].defaults ?? {}) };
    if (path === "blocks.listing.layout.variant" && B.STOREFRONT_LISTING_VARIANTS?.[value]) {
      doc.blocks.listing.layout.settings = { ...(B.STOREFRONT_LISTING_VARIANTS[value].defaults ?? {}) };
    }
  }
  for (const [path, value] of Object.entries(sets)) {
    if (!/\.variant$/.test(path)) setPath(doc, path, value);
  }
  const parsed = D.storefrontThemeDocumentSchema.safeParse(doc);
  if (!parsed.success) {
    throw new Error(`theme ${template} ${JSON.stringify(sets)} is invalid: ${JSON.stringify(parsed.error.issues).slice(0, 600)}`);
  }
  return parsed.data;
}

export async function variantNames() {
  const { B } = await themeModules();
  return {
    card: Object.keys(B.STOREFRONT_CARD_VARIANTS),
    listing: Object.keys(B.STOREFRONT_LISTING_VARIANTS ?? {}),
    gallery: Object.keys(B.STOREFRONT_GALLERY_VARIANTS ?? {}),
    buyBox: Object.keys(B.STOREFRONT_BUY_BOX_VARIANTS ?? {}),
  };
}

/** Writes tracked theme/menu rows, then outwaits the frontier freshness window. */
export async function applyTheme({ db }, template, { sets = {}, menu = null } = {}) {
  const doc = await buildThemeDocument(template, sets);
  const now = Math.floor(Date.now() / 1000);
  tx(db, () => {
    db.prepare("INSERT INTO theme_settings (id, colors, revision, created_at, updated_at) VALUES ('default', ?, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET colors = excluded.colors, revision = theme_settings.revision + 1, updated_at = excluded.updated_at").run(JSON.stringify(doc), now, now);
    if (menu) db.prepare("UPDATE navigation_placements SET menu_id = ?, is_enabled = 1, revision = revision + 1, updated_at = ? WHERE surface = 'header'").run(menu, now);
  });
  const seq = db.prepare("SELECT seq FROM cache_clock WHERE id = 1").get().seq;
  // Matrix/hover/variant callers navigate many ordinary URLs. Their next
  // request must not reuse a frontier taken just before this committed write.
  const { CACHE_FRONTIER_DELTA_MS } = await importTs("packages/shared/src/cache-frontier.ts");
  await sleep(CACHE_FRONTIER_DELTA_MS + 1);
  return seq;
}

/** Explicit cold measurement only; caller carries the returned `_sv` hint. */
export function forceCacheRefresh({ db }) {
  return db.prepare(FORCE_MISS_SQL).get().seq;
}
