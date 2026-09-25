// Applies a template (plus single-block variant swaps, what a merchant does in
// the dashboard) to the harness state and forces a new cache generation in
// D1 and its KV mirror, so the next page load renders the new theme.
import { importTs, tx } from "./context.mjs";

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

let generationSeq = 0;
/** Writes the theme (and header menu), bumps the generation in D1 and KV. */
export async function applyTheme({ db, stack }, template, { sets = {}, menu = null } = {}) {
  const doc = await buildThemeDocument(template, sets);
  const now = Math.floor(Date.now() / 1000);
  const generation = `fid${Date.now().toString(16)}${(generationSeq++).toString(36)}`;
  tx(db, () => {
    db.prepare("INSERT INTO theme_settings (id, colors, revision, created_at, updated_at) VALUES ('default', ?, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET colors = excluded.colors, revision = theme_settings.revision + 1, updated_at = excluded.updated_at").run(JSON.stringify(doc), now, now);
    if (menu) db.prepare("UPDATE navigation_placements SET menu_id = ?, is_enabled = 1, revision = revision + 1, updated_at = ? WHERE surface = 'header'").run(menu, now);
    db.prepare("INSERT INTO cache_generation (id, generation, updated_at) VALUES ('default', ?, ?) ON CONFLICT(id) DO UPDATE SET generation = excluded.generation, updated_at = excluded.updated_at").run(generation, now);
  });
  await stack.kvPut("cache:generation", generation);
  return generation;
}

/** A new generation only (forces a cache miss without changing anything). */
export async function bumpGeneration({ db, stack }) {
  const generation = `fid${Date.now().toString(16)}${(generationSeq++).toString(36)}`;
  db.prepare("INSERT INTO cache_generation (id, generation, updated_at) VALUES ('default', ?, unixepoch()) ON CONFLICT(id) DO UPDATE SET generation = excluded.generation, updated_at = excluded.updated_at").run(generation);
  await stack.kvPut("cache:generation", generation);
  return generation;
}
