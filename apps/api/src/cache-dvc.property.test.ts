/**
 * The DVC release gate (CACHE-DESIGN §7 items 1 and 3): a missed invalidation
 * cannot ship.
 *
 * The real API renders every cached public read in-process over a seeded
 * store; a random walk of row mutations of any table, curated service writes,
 * stock-band walks, category moves, JSON document edits and clock jumps
 * across promotion boundaries runs against it. After every step each cached
 * API part the validator calls valid must equal a fresh render byte for byte,
 * and each storefront page hit must satisfy G1 (frontier no older than Δ, no
 * dependency changed in (s0, F.S], body equal to the page at F.S).
 *
 * Modes (environment):
 *   (default)          quick: the coverage sweep plus DVC_STEPS (default 150) random steps; CI.
 *   DVC_MODE=long      DVC_STEPS (default 20000) steps per seed, DVC_SEEDS seeds; see scripts/cache-dvc-long.mjs.
 *   DVC_SEED=<seed>    replay one seed (with the DVC_STEPS the failure printed).
 *   DVC_SHARDS=<n>     quick mode with several seeds runs each seed in its own vitest process, n at a
 *                      time (default: the machine's cores less one); 1 keeps every seed in this process.
 *   DVC_PROVIDER=turso the real Turso adapter over the same SQLite store.
 *   DVC_CLOCK=reference|triggers|auto (default auto: S1's triggers once the migration exists).
 *   DVC_RACE=<p>       inject a committed write before a render statement with probability p.
 *   DVC_FRONTIER_CAP / DVC_FRONTIER_LIMIT  small values exercise frontier trimming and capped deltas.
 *   DVC_REPORT=<file>  write the run's stats as JSON.
 */
import "@hono/zod-openapi";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteTursoDatabase } from "@scalius/database/testing/sqlite-d1";
import { CACHE_DEP_TABLES } from "@scalius/shared/cache-deps";
import { DvcHarness, type DvcHarnessConfig } from "./testing/cache-dvc/harness";
import {
  s4Adapters,
  scopeRecorder,
  type S4AdapterOptions,
  type S4Adapters,
  type ScopeRecorderStats,
} from "./testing/cache-dvc/harness-adapters";
import { referencePartValidator } from "./testing/cache-dvc/validators";
import { Rng } from "./testing/cache-dvc/rng";
import { STRUCTURAL_OP_GAPS } from "./testing/cache-dvc/mutations";
import { DVC_SEED_EPOCH } from "./testing/cache-dvc/seed-store";
import { registryColumnsMissingFromSchema, registryTablesMissingFromSchema } from "./testing/cache-dvc/schema-model";

vi.mock("@scalius/database/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/database/client")>();
  return {
    ...actual,
    getDb: (env?: Record<string, unknown>) => (env && env.__DVC_DB ? env.__DVC_DB : actual.getDb(env as never)) as ReturnType<typeof actual.getDb>,
  };
});

// nanoid keeps a module-level byte pool, so an id minted inside a render
// depends on every id minted before it. Draw each id straight from
// crypto.getRandomValues, which the harness seeds per render; a render that
// mints an id (footer social links without one) is then a pure function.
vi.mock("nanoid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nanoid")>();
  return {
    ...actual,
    nanoid: (size = 21) => {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(size));
      let id = "";
      for (const byte of bytes) id += actual.urlAlphabet[byte & 63];
      return id;
    },
  };
});

const MODE = process.env.DVC_MODE === "long" ? "long" : "quick";
const STEPS = Number(process.env.DVC_STEPS ?? (MODE === "long" ? 20_000 : 150));
const PROVIDER = process.env.DVC_PROVIDER === "turso" ? "turso" : "d1";
const CLOCK = (process.env.DVC_CLOCK ?? "auto") as DvcHarnessConfig["clock"];
const RACE = Number(process.env.DVC_RACE ?? (MODE === "long" ? 0.02 : 0.01));
const SEEDS = process.env.DVC_SEED
  ? [process.env.DVC_SEED]
  : Array.from({ length: Number(process.env.DVC_SEEDS ?? 1) }, (_, index) => `${process.env.DVC_SEED_PREFIX ?? "dvc"}-${index + Number(process.env.DVC_SEED_OFFSET ?? 0)}`);
// A loaded machine slows the same steps down; DVC_TIMEOUT_MS gives them time
// without weakening the check.
const TIMEOUT = Number(process.env.DVC_TIMEOUT_MS ?? (MODE === "long" ? 24 * 3600_000 : 420_000));

/**
 * `s4` (default): S4's production part cache end to end (the part reader's
 * recording with a deliberately stale clock snapshot, its one-statement
 * validator, its frontier delta and the shared frontier rule). `scope`: S2's
 * recorder with the reference validator and frontier. `coarse`: table keys only.
 */
const RECORDER = process.env.DVC_RECORDER === "coarse" ? "coarse" : process.env.DVC_RECORDER === "scope" ? "scope" : "s4";
const scopeStats: ScopeRecorderStats = { coarse: new Map(), unobserved: new Map() };
const s4Runs: Array<S4Adapters["stats"]> = [];

function harnessConfig(seed: string, s4Options: S4AdapterOptions = {}): DvcHarnessConfig {
  const s4 = RECORDER === "s4"
    ? s4Adapters({
      snapshotRefreshRate: Number(process.env.DVC_SNAPSHOT_REFRESH ?? 0.5),
      random: (() => {
        const rng = new Rng(`s4-snapshot:${seed}`);
        return () => rng.next();
      })(),
      ...(PROVIDER === "turso" ? { database: (sqlite: DatabaseSync) => createSqliteTursoDatabase(sqlite) } : {}),
      ...s4Options,
    })
    : null;
  if (s4) s4Runs.push(s4.stats);
  return {
    ...(RECORDER === "scope" ? { recorder: ({ model }) => scopeRecorder(scopeStats, new Set(model.keys())) } : {}),
    ...(s4 ? { recorder: s4.recorder(scopeStats), partValidator: (clock) => s4.partValidator(clock), frontierModel: s4.frontierModel } : {}),
    seed,
    provider: PROVIDER,
    clock: CLOCK,
    raceRate: RACE,
    frontierCap: Number(process.env.DVC_FRONTIER_CAP ?? 24),
    frontierDeltaLimit: Number(process.env.DVC_FRONTIER_LIMIT ?? 16),
    fullCheckEvery: Number(process.env.DVC_FULL_CHECK_EVERY ?? (MODE === "long" ? 5 : 1)),
    setSystemTime: (ms) => vi.setSystemTime(ms),
    collect: process.env.DVC_COLLECT === "1",
    log: (line) => console.error(line),
    ...(PROVIDER === "turso" ? { providerDatabase: (sqlite: DatabaseSync) => createSqliteTursoDatabase(sqlite) } : {}),
  };
}

const reports: unknown[] = [];

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterAll(() => {
  vi.useRealTimers();
  if (process.env.DVC_REPORT) writeFileSync(process.env.DVC_REPORT, JSON.stringify(reports, null, 2));
});

describe("DVC registry", () => {
  it("names only tables and columns the schema has", async () => {
    const harness = await DvcHarness.create(harnessConfig("registry"));
    try {
      expect(registryTablesMissingFromSchema(harness.model)).toEqual([]);
      expect(registryColumnsMissingFromSchema(harness.model)).toEqual([]);
      expect(Object.keys(CACHE_DEP_TABLES).length).toBeGreaterThan(0);
    } finally {
      harness.close();
    }
  }, 60_000);
});

const PRODUCT_KEYS = /^(?:p:|t:products$|t:product_variants$|t:product_buyer_state$)/;

describe("DVC property harness has teeth", () => {
  it("catches a validator that ignores the product keys", async () => {
    const harness = await DvcHarness.create({
      ...(RECORDER === "s4"
        ? harnessConfig("teeth", { blindTo: PRODUCT_KEYS })
        : {
          ...harnessConfig("teeth"),
          partValidator: (clock) => {
            const inner = referencePartValidator(clock);
            return {
              name: "blind-to-products",
              validate: (entries, now) => inner.validate(entries.map((entry) => ({
                ...entry,
                deps: entry.deps.filter((dep) => !PRODUCT_KEYS.test(dep)),
              })), now),
            };
          },
        } satisfies DvcHarnessConfig),
      collect: true,
      raceRate: 0,
    });
    try {
      await harness.warm();
      for (let step = 0; step < 60 && harness.findings.size === 0; step += 1) await harness.runStep();
      expect(harness.findings.size, "a blind validator went unnoticed").toBeGreaterThan(0);
    } finally {
      harness.close();
    }
  }, 120_000);
});

/** Products whose only discount is on a sold-out SKU, newer than every seeded product, outside the seeded categories' grids. */
function onSaleFillers(count: number): string {
  const ids = Array.from({ length: count }, (_, index) => index);
  const rows = (make: (index: number) => string) => ids.map(make).join(",\n");
  return `
    INSERT INTO products (id, name, price_minor, slug, category_id, is_active, discount_type, discount_bps, discount_amount_minor, created_at, updated_at) VALUES
    ${rows((i) => `('p_fill_${i}', 'Filler ${i}', 100000, 'filler-${i}', 'cat_women', 1, NULL, 0, 0, ${DVC_SEED_EPOCH - 86_400 + i}, ${DVC_SEED_EPOCH})`)};
    INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position, standard_mapping) VALUES
    ${rows((i) => `('opt_fill_${i}', 'p_fill_${i}', 'Size', 'size', 0, 'size')`)};
    INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position) VALUES
    ${rows((i) => `('ov_fill_${i}_a', 'opt_fill_${i}', 'S', 's', 0), ('ov_fill_${i}_b', 'opt_fill_${i}', 'M', 'm', 1)`)};
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory, option_combination_key, discount_type, discount_bps, discount_amount_minor) VALUES
    ${rows((i) => `('v_fill_${i}_a', 'p_fill_${i}', 'FILL-${i}-S', 100000, 5, 0, 0, 1, 'S', NULL, 0, 0), ('v_fill_${i}_b', 'p_fill_${i}', 'FILL-${i}-M', 100000, 0, 0, 0, 1, 'M', 'percentage', 1000, 0)`)};
    INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id) VALUES
    ${rows((i) => `('v_fill_${i}_a', 'opt_fill_${i}', 'ov_fill_${i}_a'), ('v_fill_${i}_b', 'opt_fill_${i}', 'ov_fill_${i}_b')`)};
  `;
}

/**
 * Directed scenarios for edges a random walk reaches rarely: render a part,
 * commit one write that changes it, and require the cached entry to be
 * rejected. `equal: false` proves each write really changes the part.
 */
describe("DVC directed scenarios", () => {
  async function staleAfter(seed: string, path: string, write: (sqlite: DatabaseSync) => void, setup?: (sqlite: DatabaseSync) => void) {
    const harness = await DvcHarness.create({ ...harnessConfig(seed), raceRate: 0, collect: false });
    try {
      setup?.(harness.sqlite);
      await harness.readPart(path);
      write(harness.sqlite);
      return await harness.checkPart(path);
    } finally {
      harness.close();
    }
  }

  it("on-sale home list: a candidate window full of products discounted only on sold-out SKUs", async () => {
    // 36 newer products (the deal block's 12 cards x 3 candidates) each have a
    // discounted SKU, but it is sold out and the SKU in stock is not
    // discounted, so none pays less now: they fill the candidate window,
    // show nowhere on the list, and keep the real sale (p_cotton) out of it.
    const verdict = await staleAfter("scenario-on-sale", "/api/v1/storefront/homepage", (sqlite) => {
      // The oldest filler's SKU loses its discount: p_cotton enters the window and the list.
      sqlite.exec("UPDATE product_variants SET discount_type = NULL, discount_bps = 0 WHERE id = 'v_fill_0_b'");
    }, (sqlite) => sqlite.exec(onSaleFillers(36)));
    expect(verdict).toEqual({ cached: true, valid: false, equal: false });
  }, 120_000);

  it("published menu: an item moved to another menu invalidates the menu it left", async () => {
    const verdict = await staleAfter("scenario-nav-move", "/api/v1/navigation/menus/menu_main?revision=1&dependencyRevision=1", (sqlite) => {
      sqlite.exec("UPDATE navigation_menu_publication_items SET menu_id = 'menu_footer' WHERE menu_id = 'menu_main' AND item_id = 'nav_sale'");
    });
    expect(verdict).toEqual({ cached: true, valid: false, equal: false });
  }, 120_000);

  it("option definition moved to another product: a change still reaches the product whose SKUs assign it", async () => {
    // Moved to p_watch, the definition still names the linen SKUs' size
    // facet; retiring it changes that facet on the linen listing, which
    // declares p:p_linen, not p:p_watch.
    const path = "/api/v1/products?page=1&limit=20&category=panjabi&sort=newest";
    const verdict = await staleAfter("scenario-option-move", path, (sqlite) => {
      sqlite.exec("UPDATE product_option_definitions SET deleted_at = 1790000000 WHERE id = 'opt_linen_size'");
    }, (sqlite) => sqlite.exec("UPDATE product_option_definitions SET product_id = 'p_watch' WHERE id = 'opt_linen_size'"));
    expect(verdict).toEqual({ cached: true, valid: false, equal: false });
  }, 120_000);

  it("newest home list: a product the buyer state lists but whose SKU is gone comes back when the SKU does", async () => {
    // The cards drop a member with no live SKU; the list still depends on it.
    const verdict = await staleAfter("scenario-newest-member", "/api/v1/storefront/homepage", (sqlite) => {
      sqlite.exec("UPDATE product_variants SET deleted_at = NULL WHERE id = 'v_watch'");
    }, (sqlite) => sqlite.exec("UPDATE product_variants SET deleted_at = 1790000000 WHERE id = 'v_watch'"));
    expect(verdict).toEqual({ cached: true, valid: false, equal: false });
  }, 120_000);

  // A direct SQL write leaves the buyer state (product_buyer_state, whose
  // rows the `lm:` keys track) as it was. A product's public membership is
  // the buyer state's, so no such write may bring a product a read did not
  // show, and so declared no key of, into its answer (dvc-2 step 701: a raw
  // SKU delete made p_linen buyable to site search's live eligibility while
  // the cached answer held only its hits' keys). Each setup makes the live
  // rows disagree with the buyer state; each write puts them back.
  // `changes`: the write changes the answer.
  const LINEN_SKUS_GONE = "UPDATE product_variants SET deleted_at = 1790000000 WHERE product_id = 'p_linen'";
  const LINEN_SKUS_BACK = "UPDATE product_variants SET deleted_at = NULL WHERE product_id = 'p_linen'";
  const LINEN_OFF = "UPDATE products SET is_active = 0 WHERE id = 'p_linen'";
  const LINEN_ON = "UPDATE products SET is_active = 1 WHERE id = 'p_linen'";
  // A draft in the Panjabi category (search matches it by category name).
  const DRAFT_ON = "UPDATE products SET is_active = 1 WHERE id = 'p_draft'";
  // The buyer state lists the draft in the Panjabi window, but it has no live
  // SKU: no card shows it until its SKU is back. As the newest Panjabi
  // product (with a photo) it is the whole one-product window of the
  // collection directory's Panjabi edit, its cover: only that window's own
  // keys can see the cover change.
  const DRAFT_LISTED_WITHOUT_SKU = `
    UPDATE product_buyer_state SET is_public = 1, product_created_at = ${DVC_SEED_EPOCH + 86_400} WHERE product_id = 'p_draft';
    UPDATE product_variants SET deleted_at = 1790000000 WHERE product_id = 'p_draft';
    INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order, alt_text) VALUES ('pmed_draft01', 'p_draft', 'media_story', 1, 0, NULL);`;
  const DRAFT_SKU_BACK = "UPDATE product_variants SET deleted_at = NULL WHERE product_id = 'p_draft'";
  const SEARCH = "/api/v1/search?q=panjabi";
  const HOME = "/api/v1/storefront/homepage";
  const FEED = "/api/v1/products/feed";
  const DYNAMIC = "/api/v1/collections/col_dynamic";
  it.each([
    ["site search: a SKU back makes a product buyable", SEARCH, LINEN_SKUS_GONE, LINEN_SKUS_BACK, false],
    ["site search: a product switched back on", SEARCH, LINEN_OFF, LINEN_ON, false],
    ["site search: a draft switched on", SEARCH, null, DRAFT_ON, false],
    ["site search with a price range: a SKU back", `${SEARCH}&minPrice=1000&maxPrice=3000`, LINEN_SKUS_GONE, LINEN_SKUS_BACK, true],
    ["dynamic collection: a SKU back", DYNAMIC, LINEN_SKUS_GONE, LINEN_SKUS_BACK, true],
    ["dynamic collection: a draft switched on", DYNAMIC, null, DRAFT_ON, false],
    ["home collections: a product switched back on", HOME, LINEN_OFF, LINEN_ON, true],
    ["home collections: a draft switched on", HOME, null, DRAFT_ON, false],
    ["home collections: a window member's SKU back", HOME, DRAFT_LISTED_WITHOUT_SKU, DRAFT_SKU_BACK, true],
    ["collection directory: a window member's SKU back", "/api/v1/collections/directory", DRAFT_LISTED_WITHOUT_SKU, DRAFT_SKU_BACK, true],
    ["category listing: a draft switched on", "/api/v1/categories/panjabi/products?page=1&limit=20&sort=newest", null, DRAFT_ON, false],
    ["product feed: a SKU back makes a product buyable", FEED, LINEN_SKUS_GONE, LINEN_SKUS_BACK, true],
    ["product feed: a product switched back on", FEED, LINEN_OFF, LINEN_ON, true],
  ] as Array<[string, string, string | null, string, boolean]>)("membership is the buyer state's: %s", async (name, path, setup, write, changes) => {
    const verdict = await staleAfter(`scenario-membership-${name}`, path, (sqlite) => sqlite.exec(write), setup ? (sqlite) => sqlite.exec(setup) : undefined);
    expect(verdict.cached).toBe(true);
    expect(verdict.equal, "the write changes the answer").toBe(!changes);
    // A cached entry the validator keeps must equal a fresh render.
    expect(verdict.valid && !verdict.equal, "a stale entry validated").toBe(false);
  }, 120_000);

  it("brand listing: a facet value's label and order come from a product of the brand", async () => {
    // The tote's SKU (no brand, and before the linen by id) also carries the
    // linen's size M. Its row's edit advances only the tote's own scopes, so
    // the Aarong listing must not take that value's label or order from it
    // (dvc-5: a SKU row of a product outside the scope reordered the brand
    // page's size values).
    const verdict = await staleAfter("scenario-facet-sample", "/api/v1/brands/aarong/products?page=1&limit=20", (sqlite) => {
      sqlite.exec("UPDATE product_facet_values SET value_label = 'Medium', sort_order = 9 WHERE owner_id = 'v_bag' AND facet_key = 'option.size'");
    }, (sqlite) => sqlite.exec(`INSERT INTO product_facet_values (owner_id, product_id, variant_id, facet_kind, facet_key, value_key, value_label, value_number, sort_order)
      SELECT 'v_bag', 'p_bag', 'v_bag', facet_kind, facet_key, value_key, value_label, value_number, sort_order
      FROM product_facet_values WHERE owner_id = 'v_linen_m' AND facet_key = 'option.size'`));
    expect(verdict).toEqual({ cached: true, valid: true, equal: true });
  }, 120_000);

  it("published menu: a draft edit (menu revision) invalidates nothing", async () => {
    const verdict = await staleAfter("scenario-nav-draft", "/api/v1/storefront/layout", (sqlite) => {
      sqlite.exec("UPDATE navigation_menus SET revision = revision + 1 WHERE id = 'menu_main'");
    });
    expect(verdict).toEqual({ cached: true, valid: true, equal: true });
  }, 120_000);

  it.each([
    ["merchant title", "UPDATE theme_settings SET colors = json_set(colors, '$.pages.landing.eid.title', 'Eid campaign II') WHERE id = 'default'"],
    ["section visibility", "UPDATE theme_settings SET colors = json_set(colors, '$.pages.landing.eid.sections[0].hidden', json('true')) WHERE id = 'default'"],
    ["section media", "UPDATE media SET alt_text = 'New campaign photo' WHERE id = 'media_hero'"],
    ["product title", "UPDATE products SET name = name || ' II' WHERE id = 'p_linen'"],
    ["referenced collection", "UPDATE collections SET name = name || ' II' WHERE id = 'col_manual'"],
    ["category tile", "UPDATE categories SET name = name || ' II' WHERE id = 'cat_panjabi'"],
  ])("landing page: %s invalidates its composed section read", async (name, sql) => {
    const verdict = await staleAfter(`scenario-landing-${name}`, "/api/v1/storefront/landing/eid", (sqlite) => sqlite.exec(sql));
    expect(verdict).toEqual({ cached: true, valid: false, equal: false });
  }, 120_000);

  it.each([
    ["product modules", "$.blocks.product.below[0]", "'policies'"],
    ["listing toolbar", "$.blocks.listing.toolbar[0]", "'per-page'"],
  ])("%s: the theme editor's product and listing blocks invalidate the layout's theme", async (name, path, value) => {
    const verdict = await staleAfter(`scenario-blocks-${name}`, "/api/v1/storefront/layout", (sqlite) => {
      sqlite.prepare(`UPDATE theme_settings SET colors = json_set(colors, ?, ${value}) WHERE id = 'default'`).run(path);
    });
    expect(verdict).toEqual({ cached: true, valid: false, equal: false });
  }, 120_000);

  const INVALID = { cached: true, valid: false, equal: false };
  const VALID = { cached: true, valid: true, equal: true };
  it.each([
    ["its name", "/api/v1/checkout/config?presence=en-in", "UPDATE markets SET name = 'India II' WHERE id = 'mkt_dvc_india'", INVALID],
    ["its country", "/api/v1/storefront/markets", "INSERT INTO market_countries (country_code, market_id) VALUES ('LK', 'mkt_dvc_india')", INVALID],
    ["its status", "/api/v1/storefront/markets", "UPDATE markets SET status = 'draft' WHERE id = 'mkt_dvc_india'", INVALID],
    ["its subfolder language", "/api/v1/storefront/layout", "UPDATE market_presences SET value = 'bn-np', locale = 'bn' WHERE id = 'mkp_dvc_india'", INVALID],
    // The checkout config carries the countries every active market sells to (its accepted phone
    // countries, `mk:selling`): another market's country or status reaches it, its rename does not.
    ["another market's country, in the accepted phone countries", "/api/v1/checkout/config", "INSERT INTO market_countries (country_code, market_id) VALUES ('LK', 'mkt_dvc_india')", INVALID],
    ["another market's status, in the accepted phone countries", "/api/v1/checkout/config", "UPDATE markets SET status = 'draft' WHERE id = 'mkt_dvc_india'", INVALID],
    ["another market's name, in the config", "/api/v1/checkout/config?presence=en-in", "UPDATE markets SET name = 'Bangladesh II' WHERE id = 'mkt_backup'", VALID],
    ["another market's rename, in the root config", "/api/v1/checkout/config", "UPDATE markets SET name = 'India II' WHERE id = 'mkt_dvc_india'", VALID],
    // A draft market sells nothing: its countries leave every config valid.
    ["a draft market's country", "/api/v1/checkout/config?presence=en-in", "INSERT INTO market_countries (country_code, market_id) VALUES ('LK', 'mkt_dvc_draft')", VALID],
    // A market edit never reaches the catalogue: every catalogue read is the same in every market.
    ["a product read", "/api/v1/products/linen-panjabi", "UPDATE markets SET name = 'India II' WHERE id = 'mkt_dvc_india'", VALID],
  ])("markets: %s", async (name, path, sql, expected) => {
    const verdict = await staleAfter(`scenario-markets-${name}`, path, (sqlite) => sqlite.exec(sql));
    expect(verdict).toEqual(expected);
  }, 120_000);

  // Translations (MARKETS-DESIGN D9): a presence folds its language; the root folds none.
  it.each([
    ["a product's text, in its language", "/api/v1/products/linen-panjabi?presence=bn-in", `UPDATE translations SET fields = json_set(fields, '$.name', 'নতুন') WHERE id = 'tr_dvc_linen'`, INVALID],
    ["an option value, on its product", "/api/v1/products/silk-panjabi?presence=bn-in", `UPDATE translations SET fields = json_set(fields, '$.value', 'সোনা') WHERE id = 'tr_dvc_ov_gold'`, INVALID],
    ["a market adaptation, in its market", "/api/v1/products/linen-panjabi?presence=en-in", `UPDATE translations SET fields = json_set(fields, '$.name', 'Linen Shirt') WHERE id = 'tr_dvc_linen_in'`, INVALID],
    ["a draft language's text, at the root", "/api/v1/products/cotton-panjabi", `INSERT INTO translations (id, resource_type, resource_id, locale, fields) VALUES ('tr_dvc_cotton_fr', 'product', 'p_cotton', 'fr', '{"name":"Coton"}')`, VALID],
    ["a localized handle, in the sitemap", "/api/v1/products/sitemap?presence=bn-in", "INSERT INTO localized_slugs (resource_type, locale, slug, resource_id) VALUES ('product', 'bn', 'cotton-bn', 'p_cotton')", INVALID],
    ["a localized handle moved to another product", "/api/v1/products/linen-panjabi-bn?presence=bn-in", "UPDATE localized_slugs SET resource_id = 'p_cotton' WHERE slug = 'linen-panjabi-bn'", INVALID],
    ["a localized handle, in the root page's alternates", "/api/v1/products/cotton-panjabi", "INSERT INTO localized_slugs (resource_type, locale, slug, resource_id) VALUES ('product', 'bn', 'cotton-bn', 'p_cotton')", INVALID],
    ["a menu link label", "/api/v1/storefront/layout?presence=bn-in", `UPDATE translations SET fields = json_set(fields, '$."item:nav_sale"', 'অফার') WHERE id = 'tr_dvc_menu_main'`, INVALID],
    ["a delivery rate name", "/api/v1/shipping-methods?presence=bn-in", `UPDATE translations SET fields = json_set(fields, '$.name', 'ঢাকা') WHERE id = 'tr_dvc_ship_dhaka'`, INVALID],
    ["a payment method name", "/api/v1/checkout/config?presence=bn-in", `UPDATE translations SET fields = json_set(fields, '$.name', 'নগদে') WHERE id = 'tr_dvc_cod'`, INVALID],
    ["the language's publication", "/api/v1/products/linen-panjabi?presence=bn-in", "UPDATE store_languages SET published = 0 WHERE locale = 'bn'", INVALID],
  ])("translations: %s", async (name, path, sql, expected) => {
    const verdict = await staleAfter(`scenario-translations-${name}`, path, (sqlite) => sqlite.exec(sql));
    expect(verdict).toEqual(expected);
  }, 120_000);

  it("markets: the backup market's price increment invalidates the prices that round to it", async () => {
    const verdict = await staleAfter("scenario-markets-increment", "/api/v1/products/linen-panjabi", (sqlite) => {
      sqlite.exec("UPDATE markets SET price_increment_minor = CASE price_increment_minor WHEN 100 THEN 1 ELSE 100 END WHERE is_backup = 1");
    });
    expect(verdict.cached).toBe(true);
    expect(verdict.valid).toBe(false);
  }, 120_000);

  it("landing page: a merchant's draft edit leaves the live cached page valid", async () => {
    const verdict = await staleAfter("scenario-landing-draft", "/api/v1/storefront/landing/eid", (sqlite) => {
      sqlite.exec(`INSERT INTO theme_settings_drafts (id, theme, revision, base_published_revision, created_at, updated_at)
        SELECT 'default', json_set(colors, '$.pages.landing.eid.title', 'Unpublished campaign'), 1, revision, ${DVC_SEED_EPOCH}, ${DVC_SEED_EPOCH}
        FROM theme_settings WHERE id = 'default'`);
    });
    expect(verdict).toEqual({ cached: true, valid: true, equal: true });
  }, 120_000);
});

/**
 * A seed is CPU-bound and single-threaded, so seeds of one process queue behind
 * each other. With several seeds in quick mode each one runs in its own vitest
 * process (`DVC_SHARD=1`: the same file, one seed, the same checks, the full
 * coverage sweep), up to DVC_SHARDS at a time; the wall time is the slowest
 * seed, not their sum. A shard that fails fails its seed's test with its output.
 */
const IS_SHARD = process.env.DVC_SHARD === "1";
const SHARDS = Math.max(1, Number(process.env.DVC_SHARDS ?? availableParallelism() - 1));
const SHARDED = MODE === "quick" && !IS_SHARD && !process.env.DVC_SEED && SEEDS.length > 1 && SHARDS > 1;

interface ShardResult {
  seed: string;
  code: number | null;
  output: string;
  reports: unknown[];
}

function runShard(seed: string, offset: number, directory: string): Promise<ShardResult> {
  const vitest = join(createRequire(import.meta.url).resolve("vitest/package.json"), "..", "vitest.mjs");
  const report = join(directory, `${seed}.json`);
  const file = decodeURIComponent(new URL(import.meta.url).pathname);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [vitest, "run", file, "-t", `never serves a stale entry as valid: ${seed}$`], {
      env: {
        ...process.env,
        DVC_SHARD: "1",
        DVC_SEEDS: "1",
        DVC_SEED_OFFSET: String(offset),
        DVC_REPORT: report,
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => {
      let reports: unknown[] = [];
      try { reports = JSON.parse(readFileSync(report, "utf8")); } catch { /* the shard died before it wrote one */ }
      resolve({ seed, code, output, reports });
    });
  });
}

function runShards(directory: string): Array<Promise<ShardResult>> {
  const offset = Number(process.env.DVC_SEED_OFFSET ?? 0);
  const results: Array<Promise<ShardResult>> = [];
  let running = 0;
  const waiting: Array<() => void> = [];
  const next = () => {
    running -= 1;
    waiting.shift()?.();
  };
  SEEDS.forEach((seed, index) => {
    results.push(new Promise<ShardResult>((resolve) => {
      const start = () => {
        running += 1;
        void runShard(seed, offset + index, directory).then((result) => { next(); resolve(result); });
      };
      if (running < SHARDS) start();
      else waiting.push(start);
    }));
  });
  return results;
}

describe(`DVC differential property (${MODE}, ${PROVIDER})`, () => {
  if (SHARDED) {
    let directory = "";
    let shards: Array<Promise<ShardResult>> = [];
    beforeAll(() => {
      directory = mkdtempSync(join(tmpdir(), "dvc-shards-"));
      shards = runShards(directory);
    });
    afterAll(async () => {
      await Promise.allSettled(shards);
      rmSync(directory, { recursive: true, force: true });
    });
    SEEDS.forEach((seed, index) => {
      it(`never serves a stale entry as valid: ${seed}`, async () => {
        const result = await shards[index]!;
        reports.push(...result.reports);
        if (process.env.DVC_REPORT) writeFileSync(process.env.DVC_REPORT, JSON.stringify(reports, null, 2));
        const lines = result.output.split("\n");
        if (result.code !== 0) {
          throw new Error(`seed ${seed} failed in its own process (exit ${result.code})\n${lines.slice(-400).join("\n")}`);
        }
        console.info(`[DVC shard ${seed}]\n${lines.slice(-30).join("\n")}`);
      // The test waits for its shard, which may queue behind earlier waves.
      }, TIMEOUT * Math.ceil(SEEDS.length / SHARDS));
    });
    return;
  }
  for (const seed of SEEDS) {
    it(`never serves a stale entry as valid: ${seed}`, async () => {
      const harness = await DvcHarness.create(harnessConfig(seed));
      const s4Stats = RECORDER === "s4" ? s4Runs[s4Runs.length - 1]! : null;
      const started = performance.now();
      let nonOk: string[] = [];
      let failure: unknown = null;
      let completed = 0;
      try {
        await harness.warm();
        nonOk = harness.nonOkParts();
        expect.soft(harness.stats.nondeterministicRoutes, "routes whose output is not a function of the database and time").toEqual([]);
        if (MODE === "quick" && !process.env.DVC_SEED) await harness.sweep();
        for (let step = 0; step < STEPS; step += 1) {
          await harness.runStep();
          completed = step + 1;
          if (MODE === "long" && completed % 1000 === 0) {
            console.error(`[DVC progress] ${seed} ${completed}/${STEPS} steps, ${harness.stats.writes} writes, ${harness.stats.partChecks} part checks, ${harness.findings.size} findings, rss ${Math.round(process.memoryUsage().rss / 1e6)}MB`);
          }
        }
      } catch (error) {
        failure = error;
      } finally {
        const gaps = harness.coverage.gaps(harness.model);
        reports.push({
          seed, mode: MODE, provider: PROVIDER, steps: completed, wallSeconds: (performance.now() - started) / 1000,
          stats: harness.stats, coverage: gaps, nonOk, refusals: Object.fromEntries(harness.coverage.refusals),
          findings: [...harness.findings.values()].map(({ signature, count, firstReport }) => ({ signature, count, firstReport })),
          error: failure ? String(failure instanceof Error ? failure.message : failure) : null,
        });
        if (process.env.DVC_REPORT) writeFileSync(process.env.DVC_REPORT, JSON.stringify(reports, null, 2));
        console.info(`[DVC] findings:\n${[...harness.findings.values()].map((finding) => `- (${finding.count}x) ${finding.signature}`).join("\n") || "none"}`);
        console.info(`[DVC] coverage gaps:\n  ops: ${gaps.ops.join(" ")}\n  noise columns: ${gaps.noise.join(" ") || "none"}\n  columns: ${gaps.columns.join(" ")}\n[DVC] refusals:\n${[...harness.coverage.refusals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([key, count]) => `  ${count}x ${key}`).join("\n")}`);
        console.info(`[DVC] ${harness.summary()}\nnon-200 parts: ${nonOk.join(" ") || "none"}\nwall ${((performance.now() - started) / 1000).toFixed(1)}s`);
        if (RECORDER === "s4") console.info(`[DVC] s4 snapshot: ${JSON.stringify(s4Runs[s4Runs.length - 1])}`);
        if (RECORDER !== "coarse") {
          const top = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([key, count]) => `  ${count}x ${key}`).join("\n") || "  none";
          console.info(`[DVC] coarse fallbacks (route table):\n${top(scopeStats.coarse)}\n[DVC] tables the harness saw but S2 did not report:\n${top(scopeStats.unobserved)}`);
        }
        harness.close();
      }
      if (failure) throw failure;
      if (MODE === "quick" && !process.env.DVC_SEED) {
        const gaps = harness.coverage.gaps(harness.model);
        expect(gaps.noise, "noise columns the run never changed").toEqual([]);
        expect(gaps.ops.filter((op) => !(op in STRUCTURAL_OP_GAPS)), "registered table operations the run never performed").toEqual([]);
        // The reader's s0 came from a snapshot older than the clock (a lower bound) on real renders.
        if (s4Stats) expect(s4Stats.staleSnapshotRenders, "renders from a stale clock snapshot").toBeGreaterThan(0);
      }
      harness.assertNoFindings();
    }, TIMEOUT);
  }
});
