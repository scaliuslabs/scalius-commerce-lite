#!/usr/bin/env node
// The browser JavaScript graph of a built storefront (`dist/`), read statically.
//
// Astro records which file each page script became in the server manifest
// (`dist/server/chunks/entrypoints_*.mjs`): a source path such as
// `src/layouts/Layout.astro?astro&type=script&index=0&lang.ts` maps to a
// chunk under `dist/client/_astro/<BUILD_ID>/`, or to inline code (scripts
// under the 1 KB inline limit). From there the walk follows each chunk's
// static imports (what loads with it) and its dynamic imports together with
// the dependencies Vite preloads beside them (`__vite__mapDeps`), so a lazy
// load counts everything the browser fetches for it.
//
//   node apps/storefront/scripts/client-chunk-graph.mjs [storefront dir]
//
// prints the product page's first-paint JavaScript and what the first add to
// cart adds (raw and gzip). client-chunk-graph.test.ts holds the budgets.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** Runtimes buyer pages must not download: zod, the generated SDK and its client. */
export const FORBIDDEN_RUNTIMES = {
  zod: (name, code) => /\b_zod\b/.test(code),
  "generated SDK": (name, code) => name.startsWith("sdk.gen.") || /url:\s*[`'"]\/api\/v1\//.test(code),
  "generated SDK client": (name, code) => /\bserializedBody\b/.test(code),
};

/** The script entries of a default product page (layout, header, gallery, buy box, reviews, related cards). */
export const PRODUCT_PAGE_SCRIPTS = [
  "src/layouts/Layout.astro",
  "src/components/header/CoreHeader.astro",
  "src/components/header/HeaderLayout.astro",
  "src/components/header/MobileTabBar.astro",
  "src/components/footer/DirectoryFooter.astro",
  "src/components/markets/MarketSuggestion.astro",
  "src/components/product/ProductGallery.astro",
  "src/components/product/ProductSectionNav.astro",
  "src/components/product/ProductDetails.astro",
  "src/components/product/StickyBuyBar.astro",
  "src/components/product/reviews/ProductReviews.astro",
  "src/components/product/modules/ProductRecentlyViewed.astro",
  "src/components/cards/CoreProductCard.astro",
  "src/components/cards/parts/CardMedia.astro",
  ["src/pages/products/[slug].astro", 0],
  ["src/pages/products/[slug].astro", 1],
];

const CHROME_SCRIPTS = [
  "src/layouts/Layout.astro",
  "src/components/header/CoreHeader.astro",
  "src/components/header/HeaderLayout.astro",
  "src/components/header/MobileTabBar.astro",
  "src/components/footer/DirectoryFooter.astro",
  "src/components/markets/MarketSuggestion.astro",
  "src/components/newsletter/NewsletterForm.astro",
  "src/components/cards/CoreProductCard.astro",
  "src/components/cards/parts/CardMedia.astro",
];

/** Every buyer page whose scripts the budget checks: the product page, the home page sections, the listings. */
export const BUYER_PAGE_SCRIPTS = {
  product: PRODUCT_PAGE_SCRIPTS,
  home: [
    ...CHROME_SCRIPTS,
    "src/components/sliders/CustomCarousel.astro",
    "src/components/homepage/ProductRail.astro",
    "src/components/homepage/DealBlock.astro",
    "src/components/homepage/EndlessGrid.astro",
    "src/components/homepage/RecentlyViewed.astro",
  ],
  listing: [
    ...CHROME_SCRIPTS,
    "src/components/catalog/CatalogListing.astro",
    "src/components/catalog/CatalogDescription.astro",
    "src/components/catalog/CatalogEmbed.astro",
    "src/pages/categories/[slug].astro",
    "src/pages/search/index.astro",
  ],
};

/**
 * The lazy loads the first add to cart starts: the drawer (lazy-global-ui.ts),
 * the add's analytics (product-analytics.ts), and a card's quick add reading
 * the product (quick-add-card.ts).
 */
export const ADD_TO_CART_LAZY_CHUNKS = ["mount-cart-flyout", "analytics", "browser-products", "cart"];

/**
 * Lazy loads that only another action of the buyer starts: sign-in, search,
 * image zoom. (`buyer-ui`, the renderer of a store app's block in the drawer,
 * loads only when an app draws one; it still parses the block with zod.)
 */
export const OTHER_ACTION_LAZY_CHUNKS = ["mount-auth-modal", "mount-command-palette", "product-desktop-zoom-controller"];

function readJsonAt(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "[" || character === "{") depth += 1;
    else if (character === "]" || character === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, index + 1));
    }
  }
  throw new Error("Unterminated JSON in the server manifest");
}

/** The built graph, or null when `storefrontDir` has no client build. */
export function loadClientGraph(storefrontDir) {
  const serverChunks = join(storefrontDir, "dist/server/chunks");
  const clientDir = join(storefrontDir, "dist/client");
  if (!existsSync(serverChunks) || !existsSync(join(clientDir, "_astro"))) return null;
  const manifestFile = readdirSync(serverChunks).find((file) => file.startsWith("entrypoints_"));
  if (!manifestFile) return null;
  const manifest = readFileSync(join(serverChunks, manifestFile), "utf8");

  const scripts = new Map();
  for (const match of manifest.matchAll(/"[^"]*\/apps\/storefront\/(src\/[^"?]*\?astro&type=script&index=(\d+)&lang\.ts)":"(_astro\/[^"]+\.js)"/g)) {
    scripts.set(match[1], match[3]);
  }
  const inlined = new Map();
  const inlinedAt = manifest.indexOf('"inlinedScripts":');
  if (inlinedAt >= 0) {
    for (const [source, code] of readJsonAt(manifest, inlinedAt + '"inlinedScripts":'.length)) {
      const match = /\/apps\/storefront\/(src\/.*)$/.exec(source);
      if (match) inlined.set(match[1], code);
    }
  }

  const chunks = new Map();
  /** One chunk (or `inline:<source>`): its code, sizes, static imports and lazy loads. */
  function chunk(id) {
    const known = chunks.get(id);
    if (known) return known;
    const isInline = id.startsWith("inline:");
    const code = isInline ? inlined.get(id.slice(7)) : readFileSync(join(clientDir, id), "utf8");
    const directory = isInline ? "" : posix.dirname(id);
    const resolveImport = (specifier) =>
      specifier.startsWith("/") ? specifier.slice(1) : posix.join(directory, specifier);
    const imports = new Set();
    for (const match of code.matchAll(/(?:^|[;}\s])(?:import|export)\s*(?:[\w$*{},\s]*?from\s*)?"((?:\.{1,2}|\/_astro)\/[^"]+\.js)"/g)) {
      imports.add(resolveImport(match[1]));
    }
    const preloadList = /m\.f\|\|\(m\.f=\[([^\]]*)\]/.exec(code);
    const preloads = preloadList ? [...preloadList[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]) : [];
    const lazy = new Map();
    for (const match of code.matchAll(/import\(`((?:\.{1,2}|\/_astro)\/[^`]+\.js)`\)(?:[^;]{0,200}?__vite__mapDeps\(\[([\d,]*)\]\))?/g)) {
      const deps = match[2] ? match[2].split(",").map((index) => preloads[Number(index)]).filter(Boolean) : [];
      lazy.set(resolveImport(match[1]), deps);
    }
    const name = isInline ? `${id.slice(7).split("?")[0]} (inline)` : basename(id);
    const info = {
      id,
      name,
      code,
      imports,
      lazy,
      raw: Buffer.byteLength(code),
      gzip: gzipSync(code, { level: 9 }).byteLength,
    };
    chunks.set(id, info);
    return info;
  }

  /** The chunk id of a component's or page's script (`index` for a page with several). */
  function script(source, index = 0) {
    const key = `${source}?astro&type=script&index=${index}&lang.ts`;
    if (inlined.has(key)) return `inline:${key}`;
    const file = scripts.get(key);
    if (!file) throw new Error(`No built script for ${key}`);
    return file;
  }

  /** `roots` and everything they import statically. */
  function closure(roots, into = new Set()) {
    const stack = [...roots];
    while (stack.length > 0) {
      const id = stack.pop();
      if (into.has(id)) continue;
      into.add(id);
      for (const imported of chunk(id).imports) stack.push(imported);
    }
    return into;
  }

  /** The lazy loads of `loaded` (name prefix → chunk id and preloads), loaded or not. */
  function lazyLoads(loaded) {
    const found = new Map();
    for (const id of loaded) {
      for (const [target, deps] of chunk(id).lazy) found.set(target, deps);
    }
    return found;
  }

  /** `loaded` plus the lazy loads whose chunk name starts with one of `prefixes` (and what those load). */
  function withLazy(loaded, prefixes) {
    const result = new Set(loaded);
    const matched = new Set();
    let grew = true;
    while (grew) {
      grew = false;
      for (const [target, deps] of lazyLoads(result)) {
        const prefix = prefixes.find((candidate) => basename(target).startsWith(`${candidate}.`));
        if (!prefix || result.has(target)) continue;
        matched.add(prefix);
        closure([target, ...deps], result);
        grew = true;
      }
    }
    return { chunks: result, matched };
  }

  return { chunk, script, closure, lazyLoads, withLazy };
}

export function pageEntries(graph, scripts) {
  return scripts.map((entry) => (Array.isArray(entry) ? graph.script(entry[0], entry[1]) : graph.script(entry)));
}

export function productPageEntries(graph) {
  return pageEntries(graph, PRODUCT_PAGE_SCRIPTS);
}

/** The forbidden runtimes found in `ids`, as "name: chunk" lines. */
export function forbiddenRuntimes(graph, ids) {
  const found = [];
  for (const id of ids) {
    const { name, code } = graph.chunk(id);
    for (const [runtime, test] of Object.entries(FORBIDDEN_RUNTIMES)) {
      if (test(name, code)) found.push(`${runtime}: ${name}`);
    }
  }
  return found.sort();
}

export function totals(graph, ids) {
  let raw = 0;
  let gzip = 0;
  for (const id of ids) {
    raw += graph.chunk(id).raw;
    gzip += graph.chunk(id).gzip;
  }
  return { raw, gzip, count: ids.size ?? ids.length };
}

/** First paint and first add to cart of the product page. */
export function productPageBudget(graph) {
  const firstPaint = graph.closure(productPageEntries(graph));
  const { chunks: afterAdd, matched } = graph.withLazy(firstPaint, ADD_TO_CART_LAZY_CHUNKS);
  const added = new Set([...afterAdd].filter((id) => !firstPaint.has(id)));
  return { firstPaint, afterAdd, added, matched };
}

function printTable(graph, title, ids) {
  const list = [...ids].sort((left, right) => graph.chunk(right).raw - graph.chunk(left).raw);
  const sum = totals(graph, list);
  const kb = (bytes) => (bytes / 1024).toFixed(1).padStart(7);
  console.log(`\n${title}: ${list.length} files, ${kb(sum.raw).trim()} KB raw, ${kb(sum.gzip).trim()} KB gzip`);
  for (const id of list) console.log(`${kb(graph.chunk(id).raw)} ${kb(graph.chunk(id).gzip)}  ${graph.chunk(id).name}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const storefrontDir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const graph = loadClientGraph(storefrontDir);
  if (!graph) {
    console.error(`No storefront build under ${storefrontDir}/dist. Run: pnpm --filter ./apps/storefront build`);
    process.exit(1);
  }
  const { firstPaint, added, afterAdd } = productPageBudget(graph);
  printTable(graph, "Product page, first paint", firstPaint);
  printTable(graph, "Added by the first add to cart", added);
  const all = totals(graph, afterAdd);
  console.log(`\nAfter the first add to cart: ${(all.raw / 1024).toFixed(1)} KB raw, ${(all.gzip / 1024).toFixed(1)} KB gzip`);
  const lazy = graph.lazyLoads(afterAdd);
  for (const [target, deps] of lazy) {
    if (afterAdd.has(target)) continue;
    const extra = new Set([...graph.closure([target, ...deps])].filter((id) => !afterAdd.has(id)));
    const sum = totals(graph, extra);
    const found = forbiddenRuntimes(graph, extra);
    console.log(`Other lazy load ${basename(target)}: +${(sum.raw / 1024).toFixed(1)} KB raw, +${(sum.gzip / 1024).toFixed(1)} KB gzip${found.length ? `; ${found.join(", ")}` : ""}`);
  }
}
