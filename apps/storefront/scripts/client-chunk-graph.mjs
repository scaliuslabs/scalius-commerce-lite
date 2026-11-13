#!/usr/bin/env node
// The browser JavaScript graph of a built storefront (`dist/`), read statically.
//
// Astro records which file each page script became in the server manifest
// (`dist/server/chunks/entrypoints_*.mjs`): a source path such as
// `src/layouts/Layout.astro?astro&type=script&index=0&lang.ts` maps to a
// chunk under `dist/client/_astro/<BUILD_ID>/`, or to inline code (none
// today: astro.config.mjs never inlines a page script, which the page policy
// would not name). From there the walk follows each chunk's
// static imports (what loads with it) and its dynamic imports together with
// the dependencies Vite preloads beside them (`__vite__mapDeps`), so a lazy
// load counts everything the browser fetches for it.
//
//   node apps/storefront/scripts/client-chunk-graph.mjs [storefront dir] [--check]
//
// prints the product page's first-paint JavaScript and what the first add to
// cart adds (raw and gzip). `--check` also holds the buyer pages to their
// budgets (`buyerPageProblems`) and exits 1 on a problem or without a build:
// every storefront deploy runs it on the build it ships (scripts/deploy.mjs),
// and client-chunk-graph.test.ts runs the same checks on a local build.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** The checkout pages (`BUYER_PAGE_SCRIPTS.cart`, `.checkout`): they word refusals on first paint. */
const CHECKOUT_PAGES = new Set(["cart", "checkout"]);

/** Runtimes buyer pages must not download: zod, the generated SDK and its client. */
export const FORBIDDEN_RUNTIMES = {
  zod: (name, code) => /\b_zod\b/.test(code),
  "generated SDK": (name, code) => name.startsWith("sdk.gen.") || /url:\s*[`'"]\/api\/v1\//.test(code),
  "generated SDK client": (name, code) => /\bserializedBody\b/.test(code),
};

/**
 * Server-side tables a buyer page's first paint must never carry, found by a
 * value only they hold. Each came in once through a small import of something
 * else from their module: the plan profile table through the cart store's
 * line-entry words (buyer-uploads.ts bounds a declaration by the plan), the
 * English checkout catalogue through a bare type import. The problem names
 * the import chain that brought it, from the page's script.
 */
export const HEAVY_TABLES = {
  "the plan profile table (@scalius/shared/plan-limits)": (code) => /algorithm:`pbkdf2-sha256`/.test(code) || /sameOriginMedia:!?[01]/.test(code),
  "the English checkout catalogue (@scalius/shared/checkout-language)": (code) => /checkoutSectionTitle:`Checkout information`/.test(code),
};

/** The static import chain from `roots` to `target`, as chunk names (shortest). */
export function importChain(graph, roots, target) {
  const previous = new Map(roots.map((root) => [root, null]));
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === target) {
      const chain = [];
      for (let at = id; at; at = previous.get(at)) chain.unshift(graph.chunk(at).name);
      return chain;
    }
    for (const next of graph.chunk(id).imports) {
      if (!previous.has(next)) {
        previous.set(next, id);
        queue.push(next);
      }
    }
  }
  return [graph.chunk(target).name];
}

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
    "src/components/catalog/CatalogListingPage.astro",
  ],
  // The checkout form (the cart page) and the payment step: their own script draws the lines, so
  // every file it loads statically is on the way to the buyer seeing their order.
  cart: ["src/layouts/Layout.astro", ["src/pages/cart.astro", 0]],
  checkout: ["src/layouts/Layout.astro", ["src/pages/checkout.astro", 0]],
};

/**
 * The lazy loads the first add to cart starts: the drawer (lazy-global-ui.ts),
 * the store's tags hearing the add (lib/buyer-events/bus.ts loads lib/analytics.ts), and a card's quick add reading
 * the product (quick-add-card.ts), and an app purchase option validating its
 * authoritative price (new-line.ts).
 */
export const ADD_TO_CART_LAZY_CHUNKS = ["mount-cart-flyout", "analytics", "browser-products", "cart", "new-line"];

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

/** A build the walk cannot measure as it stands; the message says what to do. */
export class ClientBuildError extends Error {}

/**
 * The built graph, or null when `storefrontDir` has no client build. A build
 * with more than one server manifest is refused: one is a leftover of an
 * earlier build, and measuring it would judge files this build never ships.
 */
export function loadClientGraph(storefrontDir) {
  const serverChunks = join(storefrontDir, "dist/server/chunks");
  const clientDir = join(storefrontDir, "dist/client");
  if (!existsSync(serverChunks) || !existsSync(join(clientDir, "_astro"))) return null;
  const manifests = readdirSync(serverChunks).filter((file) => file.startsWith("entrypoints_")).sort();
  if (manifests.length === 0) return null;
  if (manifests.length > 1) {
    throw new ClientBuildError(
      `${serverChunks} holds ${manifests.length} server manifests (${manifests.join(", ")}), so the build to measure is unclear: `
      + "one is left over from an earlier build. Remove apps/storefront/dist and build again: pnpm --filter ./apps/storefront build",
    );
  }
  const manifest = readFileSync(join(serverChunks, manifests[0]), "utf8");

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
    if (!isInline && !existsSync(join(clientDir, id))) {
      throw new ClientBuildError(`The build names ${id}, which is not under ${clientDir}: the build is incomplete. Remove apps/storefront/dist and build again.`);
    }
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

  /** The chunk id of a component's or page's script (`index` for a page with several), or null when the build has none. */
  function script(source, index = 0) {
    const key = `${source}?astro&type=script&index=${index}&lang.ts`;
    if (inlined.has(key)) return `inline:${key}`;
    return scripts.get(key) ?? null;
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

/**
 * Astro renders a component's script wherever the component renders, so the
 * server manifest names every script but not which pages draw it: the pages'
 * scripts are listed above. An entry the build has no script for is said, with
 * what to change, and nothing is measured until the list matches the build.
 */
export function missingPageScripts(graph) {
  const missing = [];
  for (const [page, scripts] of Object.entries(BUYER_PAGE_SCRIPTS)) {
    for (const entry of scripts) {
      const [source, index] = Array.isArray(entry) ? entry : [entry, 0];
      if (graph.script(source, index) !== null) continue;
      missing.push(
        `the ${page} page lists ${source}${index ? ` (script ${index})` : ""}, but the build has no script for it. `
        + "If that component was removed or renamed, or no longer has a <script>, update its entry in BUYER_PAGE_SCRIPTS "
        + "(apps/storefront/scripts/client-chunk-graph.mjs); a script the list leaves out is not measured.",
      );
    }
  }
  return missing;
}

export function pageEntries(graph, scripts) {
  return scripts.map((entry) => {
    const [source, index] = Array.isArray(entry) ? entry : [entry, 0];
    const id = graph.script(source, index);
    if (id === null) throw new ClientBuildError(`The build has no script for ${source}${index ? ` (script ${index})` : ""}: update BUYER_PAGE_SCRIPTS in apps/storefront/scripts/client-chunk-graph.mjs.`);
    return id;
  });
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

/**
 * Gzip KiB ceilings of the product page, measured on 2026-10-21 (57.0 and
 * 107.9) plus about 3 KiB of headroom for copy and shared-chunk regrouping.
 * Shrink the output to fit; do not raise them to admit a runtime. Before, the
 * first add to cart added 150 KiB gzip (zod, the checkout language catalog),
 * and a card's quick add 25.5 KiB more (the generated SDK and the SSR transport).
 */
export const BUDGET_GZIP_KIB = {
  /**
   * 2026-11-09: 60.1 and 110.4 on the merged build (the buy-again, restore and
   * draft-lifetime work); 57.6 and 106.9 once the reviews section's script
   * loaded as the buyer nears it and the API error catalogue with a failure.
   * Keep at least 2 KiB of headroom on each by moving work off these paths.
   */
  firstPaint: 60,
  addedByFirstAddToCart: 111,
  /**
   * The cart page's and the payment step's first paint, measured on
   * 2026-11-09 (89.4 and 77.5) plus about 3 KiB. Before, they were 135.8 and
   * 117.0: the app blocks' renderer (zod) and the generated SDK client loaded
   * with every checkout, app blocks or not.
   */
  cartFirstPaint: 93,
  checkoutFirstPaint: 81,
};

const chunkName = (id) => id.split("/").pop();

/** Gzip KiB of `ids`, to one decimal, as the budgets read it. */
export function gzipKib(graph, ids) {
  return Math.round((totals(graph, ids).gzip / 1024) * 10) / 10;
}

/**
 * Every promise the built buyer pages keep, as the problems found (none when
 * all hold), each tagged with its check: `scripts` (a listed page script the
 * build does not have; then nothing else is measured), `walk` (the graph found the page
 * scripts and the add's lazy loads), `runtimes:<page>` (no zod or generated
 * SDK on first paint, the first add to cart, sign-in, search or zoom),
 * `deferred:<page>` (optional validation off first paint, unrelated
 * catalogues off the first add) and `gzip` (the product page's budgets, and
 * the cart page's and the payment step's first paint).
 * The deploy runs it on the build it ships (`--check`); the test runs it on a
 * local build.
 */
export function buyerPageProblems(graph, budgets = BUDGET_GZIP_KIB) {
  const problems = [];
  const fail = (check, message) => problems.push({ check, message });

  const missing = missingPageScripts(graph);
  if (missing.length > 0) return missing.map((message) => ({ check: "scripts", message }));

  const budget = productPageBudget(graph);
  if (budget.firstPaint.size <= 10) fail("walk", `the product page's first paint is ${budget.firstPaint.size} files: the walk missed its scripts`);
  const expected = ADD_TO_CART_LAZY_CHUNKS.filter((name) => name !== "cart").sort();
  const matched = [...budget.matched].sort();
  // The cart store is already on the page; the others load on the add.
  if (matched.join() !== expected.join()) {
    fail("walk", `the first add to cart starts ${matched.join(", ") || "no lazy load"}, not ${expected.join(", ")}`);
  }
  // React's DOM renderer comes with the drawer: the walk followed the drawer's imports.
  if (![...budget.added].some((id) => graph.chunk(id).code.includes("react-dom"))) {
    fail("walk", "the first add to cart loads no React DOM renderer: the walk missed the drawer's imports");
  }

  for (const [page, scripts] of Object.entries(BUYER_PAGE_SCRIPTS)) {
    const entries = pageEntries(graph, scripts);
    const firstPaint = graph.closure(entries);
    for (const id of firstPaint) {
      for (const [table, holds] of Object.entries(HEAVY_TABLES)) {
        if (holds(graph.chunk(id).code)) {
          fail(`heavy:${page}`, `the ${page} page's first paint downloads ${table}, through ${importChain(graph, entries, id).join(" -> ")}: import what the page needs from a module that does not load it`);
        }
      }
    }
    const { chunks: afterAdd } = graph.withLazy(firstPaint, ADD_TO_CART_LAZY_CHUNKS);
    for (const found of forbiddenRuntimes(graph, afterAdd)) fail(`runtimes:${page}`, `first paint or the first add to cart downloads ${found}`);
    const others = [...graph.lazyLoads(afterAdd)].filter(([target]) =>
      OTHER_ACTION_LAZY_CHUNKS.some((name) => chunkName(target).startsWith(`${name}.`)));
    if (others.length < 2) fail(`runtimes:${page}`, `only ${others.length} of the sign-in, search and zoom lazy loads were found`);
    for (const [target, deps] of others) {
      const action = graph.closure([target, ...deps]);
      for (const found of forbiddenRuntimes(graph, action)) fail(`runtimes:${page}`, `${chunkName(target)} downloads ${found}`);
      if (chunkName(target).startsWith("mount-auth-modal.")) {
        for (const id of action) {
          if (chunkName(id).startsWith("storefront-copy.")) fail(`runtimes:${page}`, `sign-in downloads the whole storefront catalogue (${chunkName(id)})`);
        }
      }
    }
    for (const id of firstPaint) {
      if (chunkName(id).startsWith("new-line.")) fail(`deferred:${page}`, `first paint downloads the app purchase-option validation (${chunkName(id)})`);
      if (chunkName(id).startsWith("reviews-boot.")) fail(`deferred:${page}`, `first paint downloads the reviews section's script, which loads as the buyer nears it (${chunkName(id)})`);
    }
    for (const id of afterAdd) {
      if (chunkName(id).startsWith("storefront-copy.")) fail(`deferred:${page}`, `the first add to cart downloads the whole storefront catalogue (${chunkName(id)})`);
      // The cart and payment pages word failures on first paint; the browsing pages load the words with a failure.
      if (!CHECKOUT_PAGES.has(page) && chunkName(id).startsWith("buyer-api-errors.")) {
        fail(`deferred:${page}`, `the first add to cart downloads the API error catalogue, which loads with a failure (${chunkName(id)})`);
      }
    }
  }

  const firstPaintKib = gzipKib(graph, budget.firstPaint);
  const addedKib = gzipKib(graph, budget.added);
  if (firstPaintKib > budgets.firstPaint) {
    fail("gzip", `the product page's first paint is ${firstPaintKib} KiB gzip, over its ${budgets.firstPaint} KiB budget`);
  }
  if (addedKib > budgets.addedByFirstAddToCart) {
    fail("gzip", `the first add to cart adds ${addedKib} KiB gzip, over its ${budgets.addedByFirstAddToCart} KiB budget`);
  }
  for (const [page, budget] of [["cart", budgets.cartFirstPaint], ["checkout", budgets.checkoutFirstPaint]]) {
    const kib = gzipKib(graph, graph.closure(pageEntries(graph, BUYER_PAGE_SCRIPTS[page])));
    if (kib > budget) fail("gzip", `the ${page} page's first paint is ${kib} KiB gzip, over its ${budget} KiB budget`);
  }
  return problems;
}

/** What `--check` prints when there is no build to check: never a silent pass. */
export function missingBuildMessage(storefrontDir) {
  return `No storefront build under ${storefrontDir}/dist, so the buyer-page JavaScript budgets were not checked. Run: pnpm --filter ./apps/storefront build`;
}

function printTable(graph, title, ids) {
  const list = [...ids].sort((left, right) => graph.chunk(right).raw - graph.chunk(left).raw);
  const sum = totals(graph, list);
  const kb = (bytes) => (bytes / 1024).toFixed(1).padStart(7);
  console.log(`\n${title}: ${list.length} files, ${kb(sum.raw).trim()} KB raw, ${kb(sum.gzip).trim()} KB gzip`);
  for (const id of list) console.log(`${kb(graph.chunk(id).raw)} ${kb(graph.chunk(id).gzip)}  ${graph.chunk(id).name}`);
}

function report(graph) {
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

/** The command line; its exit code (1: a broken budget, or a build it cannot measure). */
function main(cliArgs) {
  const check = cliArgs.includes("--check");
  const dirArg = cliArgs.find((arg) => !arg.startsWith("--"));
  const storefrontDir = resolve(dirArg ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  try {
    const graph = loadClientGraph(storefrontDir);
    if (!graph) {
      console.error(missingBuildMessage(storefrontDir));
      return 1;
    }
    const problems = check ? buyerPageProblems(graph) : [];
    // Without its listed scripts the page cannot be measured: say only what to fix.
    if (!problems.some(({ check: name }) => name === "scripts")) report(graph);
    if (!check) return 0;
    if (problems.length > 0) {
      console.error(`\n✗ The built buyer pages break ${problems.length} JavaScript budget${problems.length === 1 ? "" : "s"}:`);
      for (const { check: name, message } of problems) console.error(`  [${name}] ${message}`);
      return 1;
    }
    console.log(`\n✓ Buyer pages within their JavaScript budgets (product: ${BUDGET_GZIP_KIB.firstPaint} KiB first paint, ${BUDGET_GZIP_KIB.addedByFirstAddToCart} KiB added by the first add to cart; cart ${BUDGET_GZIP_KIB.cartFirstPaint} KiB and payment step ${BUDGET_GZIP_KIB.checkoutFirstPaint} KiB first paint; no zod or generated SDK)`);
    return 0;
  } catch (error) {
    if (!(error instanceof ClientBuildError)) throw error;
    console.error(`\n✗ The buyer-page JavaScript budgets were not checked: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
