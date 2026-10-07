/**
 * Dependency keys of the dependency-validated public cache (DVC), and the one
 * registry that says which committed row change advances which key.
 *
 * - The database triggers are generated from `CACHE_DEP_TABLES`
 *   (`packages/database/scripts/cache-dep-triggers.ts`); a test keeps the
 *   checked-in migration equal to that output.
 * - Read recording declares keys with `cacheDep.*` and checks, per table a
 *   scope read, that a declared key of one of `cacheDepKindsForTable(table)`
 *   covers it; otherwise it falls back to `cacheDep.table(table)`.
 * - Tables that public reads may touch but that never need a key are listed in
 *   `CACHE_DEP_EXEMPT_TABLES` with the reason.
 *
 * Grammar: `kind:id[:facet]`, or a bare constant (`srch`, `theme`, `store`).
 * Keys are opaque ASCII; ids are the row ids the database already uses.
 *
 * Invariants the triggers keep (audit/rewrite-2026-09-23/CACHE-DESIGN.md §6):
 * - every buyer-visible committed change of a registered row advances every
 *   key its rule derives, from the old and the new row image, in the same
 *   transaction as the change (an update rule written for the new image gets
 *   a derived old-image companion, `withOldImageCompanions`, whenever a
 *   column its keys or guard read can change: a move out of a menu, category,
 *   brand, product or promotion advances the one it left);
 * - stock that stays inside its availability band advances nothing;
 * - every change of a registered table also advances `t:<table>`, the
 *   coarse fallback key;
 * - while `cache_clock.coarse = 1` (a catalogue-wide rebuild batch), every
 *   trigger advances `store` instead of its keys.
 */

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** Every key kind, the part before the first `:` (or the whole constant key). */
export const CACHE_DEP_KINDS = [
  /** `p:<productId>`: any buyer-visible fact of one product (page, card, JSON-LD, feed row). */
  "p",
  /** Stored recommendation ordering of one source product. */
  "rec",
  /** Visible sold count of one product, independent of its card identity. */
  "sold",
  /** Popular home-list membership and ordering. */
  "popular",
  /** Private order signals used only by the live recommendation fallback. */
  "recommendation-signals",
  /** `lm:<scope>`: membership (and newest order) of a public product set; `lm:seo` the sitemap/feed flags and lastmods; `lm:shape` the store-shape counts. */
  "lm",
  /** `lo:<facet>:<scope>`: an ordering/filter fact of a member (price, band, discount, name). */
  "lo",
  /** `lf:<scope>`: the facet values of a member (facet counts). */
  "lf",
  /** `srch`: searchable text of any product or category. */
  "srch",
  /** `c:<categoryId>`, `c:*`: one category row (or any), its closure and filter set. */
  "c",
  /** `b:<brandId>`, `b:*`. */
  "b",
  /** `col:<collectionId>`, `col:*`. */
  "col",
  /** `pg:<pageId>`, `pg:*`: CMS pages and articles. */
  "pg",
  /** `m:<mediaId>`. */
  "m",
  /** `attr:<attributeId>`, `attr:*`: attribute definitions, values and groups. */
  "attr",
  /** `set:<category>:<key>`: one settings document row. */
  "set",
  /** `theme`: the published theme. */
  "theme",
  /** `nav:<menuId>`, `nav:*`: published menus and placements. */
  "nav",
  /** `ship`: shipping methods and delivery zones. */
  "ship",
  /** `loc`: the place directory (delivery places). */
  "loc",
  /** `tax`: tax classes, rates and settings. */
  "tax",
  /** `lang`: checkout languages. */
  "lang",
  /** `promo:<promotionId>`, `promo:*`. */
  "promo",
  /** `an`: analytics snippets. */
  "an",
  /** `cf:<ownerType>`: the storefront-visible custom field definitions of an owner type. */
  "cf",
  /**
   * `plg:<pluginId>`: one app installation (status, version, grant,
   * manifest, settings) and its registrations; `plg:*`: any installation
   * (which apps are active, which provide what). Storefront app output is
   * cached on it.
   */
  "plg",
  /** `plgs:<pluginId>:<collection>`: one storage collection of an app, advanced with every record write in it. */
  "plgs",
  /**
   * `mk:<marketId>`: one market (status, name, handle, countries, presences);
   * `mk:*`: any market (the active presence matrix); `mk:backup`: the backup
   * market's pricing facts (its price increment), which every price read in
   * the shop currency uses; `mk:selling`: the set of countries the active
   * markets sell to (a rename or a presence change leaves it alone).
   */
  "mk",
  /**
   * `pl:<marketId>`: how one market prices (MARKETS-DESIGN D5): its price
   * mode and FX policy, and its active public price lists (status, kind,
   * schedule, priority); `pl:<marketId>:<productId>`: the active public list
   * prices of one product's SKUs in that market. Segment lists are never
   * public, so they advance nothing.
   */
  "pl",
  /**
   * Translations (MARKETS-DESIGN D9): `tr:<type>:<id>`: one resource's
   * translations and localized URL handles in every locale and market (a
   * SKU's, an option's and an option value's advance their product's
   * `tr:product:<id>`); `tr:slugs:<type>:<locale>`: which resource a
   * localized handle names (a handle lookup that found none);
   * `tr:locales`: which locale and market each presence is, the store
   * default locale, and which languages are published.
   */
  "tr",
  /** `t:<table>`: coarse fallback, any buyer-visible change of the table. */
  "t",
  /** `store`: everything (dashboard "clear cache", catalogue-wide rebuilds). */
  "store",
] as const;

export type CacheDepKind = (typeof CACHE_DEP_KINDS)[number];

/** A listing scope: the whole public catalogue, a category subtree or a brand. */
export type CacheDepScope = "all" | `cat:${string}` | `brand:${string}`;

/**
 * Ordering and filter facts of a listing member, each its own key per scope.
 * `sale` is only ever `lo:sale:all`: the set of discount-marked products and
 * live SKUs (and their newest order) that the on-sale home list takes its
 * candidate window from. `rating` is a member's published-review rating
 * (the rating facet and the `rating` order).
 */
export const CACHE_DEP_LIST_ORDER_FACETS = ["price", "band", "disc", "name", "sale", "rating"] as const;
export type CacheDepListOrderFacet = (typeof CACHE_DEP_LIST_ORDER_FACETS)[number];

/** Suffix of the "any row of this kind" key (`c:*`, `b:*`, ...). */
export const CACHE_DEP_ANY = "*";

/** An entry holding more keys than this collapses each kind to its coarse `t:` keys. */
export const CACHE_DEP_ENTRY_KEY_BUDGET = 256;

export const cacheDep = {
  product: (productId: string) => `p:${productId}`,
  recommendations: (productId: string) => `rec:${productId}`,
  sold: (productId: string) => `sold:${productId}`,
  popular: () => "popular",
  recommendationSignals: () => "recommendation-signals",
  listMembership: (scope: CacheDepScope) => `lm:${scope}`,
  /** Sitemap and product-feed facts: noindex/exclusion flags and every sitemap lastmod. */
  discoveryMembership: () => "lm:seo",
  /** The layout's store-shape counts: active products and their live SKUs. */
  storeShape: () => "lm:shape",
  listOrder: (facet: CacheDepListOrderFacet, scope: CacheDepScope) => `lo:${facet}:${scope}`,
  listFacets: (scope: CacheDepScope) => `lf:${scope}`,
  search: () => "srch",
  category: (categoryId: string) => `c:${categoryId}`,
  anyCategory: () => `c:${CACHE_DEP_ANY}`,
  brand: (brandId: string) => `b:${brandId}`,
  anyBrand: () => `b:${CACHE_DEP_ANY}`,
  collection: (collectionId: string) => `col:${collectionId}`,
  anyCollection: () => `col:${CACHE_DEP_ANY}`,
  page: (pageId: string) => `pg:${pageId}`,
  anyPage: () => `pg:${CACHE_DEP_ANY}`,
  media: (mediaId: string) => `m:${mediaId}`,
  attribute: (attributeId: string) => `attr:${attributeId}`,
  anyAttribute: () => `attr:${CACHE_DEP_ANY}`,
  settings: (category: string, key: string) => `set:${category}:${key}`,
  theme: () => "theme",
  navigation: (menuId: string) => `nav:${menuId}`,
  anyNavigation: () => `nav:${CACHE_DEP_ANY}`,
  shipping: () => "ship",
  locations: () => "loc",
  tax: () => "tax",
  checkoutLanguages: () => "lang",
  promotion: (promotionId: string) => `promo:${promotionId}`,
  anyPromotion: () => `promo:${CACHE_DEP_ANY}`,
  analytics: () => "an",
  /** Storefront-visible custom field definitions of one owner type (`product`, `variant`, …). */
  customFieldDefinitions: (ownerType: string) => `cf:${ownerType}`,
  /** One app installation: its status, version, grant, manifest and settings. */
  plugin: (pluginId: string) => `plg:${pluginId}`,
  /** Any app installation: the set of active apps and what they put on the storefront. */
  anyPlugin: () => `plg:${CACHE_DEP_ANY}`,
  /** One storage collection of an app. */
  pluginCollection: (pluginId: string, collection: string) => `plgs:${pluginId}:${collection}`,
  /** One market: its status, identity, countries and presences. */
  market: (marketId: string) => `mk:${marketId}`,
  /** Any market: the set of markets, their countries and presences (the presence matrix). */
  anyMarket: () => `mk:${CACHE_DEP_ANY}`,
  /** The backup market's pricing facts: the price increment every shop-currency price rounds to. */
  backupMarketPricing: () => "mk:backup",
  /** The set of countries the active markets sell to: only a country or a status change advances it. */
  sellingCountries: () => "mk:selling",
  /** How one market prices: its FX policy and its active public price lists. */
  marketPricing: (marketId: string) => `pl:${marketId}`,
  /** The active public list prices of one product's SKUs in one market. */
  marketProductPricing: (marketId: string, productId: string) => `pl:${marketId}:${productId}`,
  /** One resource's translations and localized handles (a product's parts advance their product's). */
  translation: (resourceType: string, resourceId: string) => `tr:${resourceType}:${resourceId}`,
  /** Which resource of a type a localized handle names in one locale. */
  localizedSlugs: (resourceType: string, locale: string) => `tr:slugs:${resourceType}:${locale}`,
  /** One resource's localized handles (a root page's alternates; a presence page declares `tr:<type>:<id>`). */
  localizedHandles: (resourceType: string, resourceId: string) => `tr:handles:${resourceType}:${resourceId}`,
  /** Which resource of a type a localized handle in any locale names (a handle lookup). */
  localizedSlugSpace: (resourceType: string) => `tr:slugs:${resourceType}`,
  /** The locale and market of each presence, the default locale and the published languages. */
  translationLocales: () => "tr:locales",
  table: (table: string) => `t:${table}`,
  store: () => "store",
} as const;

export const categoryScope = (categoryId: string): CacheDepScope => `cat:${categoryId}`;
export const brandScope = (brandId: string): CacheDepScope => `brand:${brandId}`;

/** The kind of a key, or null when it is not a registered kind. */
export function cacheDepKind(dep: string): CacheDepKind | null {
  const colon = dep.indexOf(":");
  const kind = colon === -1 ? dep : dep.slice(0, colon);
  return (CACHE_DEP_KINDS as readonly string[]).includes(kind) ? (kind as CacheDepKind) : null;
}

const KEY_PATTERN = /^[\x21-\x7e]{1,512}$/;

/** Whether a string is a well-formed key of a registered kind. */
export function isCacheDep(dep: string): boolean {
  const kind = cacheDepKind(dep);
  if (kind === null || !KEY_PATTERN.test(dep)) return false;
  const constant = kind === "srch" || kind === "theme" || kind === "ship"
    || kind === "loc" || kind === "tax" || kind === "lang" || kind === "an" || kind === "store"
    || kind === "popular" || kind === "recommendation-signals";
  return constant ? dep === kind : dep.length > kind.length + 1;
}

// ---------------------------------------------------------------------------
// Registry: which row change advances which key
// ---------------------------------------------------------------------------

/**
 * Where a rule reads the row: the new image (insert, update) or the old one
 * (delete, update).
 */
export type CacheDepImage = "new" | "old";

/**
 * One key a rule derives from a row image `R` (`NEW` or `OLD`). A key whose
 * expression is NULL (a NULL column) is skipped.
 */
export type CacheDepKeyTemplate =
  /** A constant key. */
  | { readonly dep: string }
  /** `prefix || R.col1 [|| ':' || R.col2 ...]`. */
  | { readonly prefix: string; readonly columns: readonly string[] }
  /** `prefix || (SELECT <select> FROM <table> WHERE <key> = R.<column>)`: a parent id one lookup away. */
  | {
      readonly prefix: string;
      readonly lookup: { readonly table: string; readonly select: string; readonly key: string; readonly column: string };
    }
  /**
   * `prefix || ref` for every row of `rows`, a query (in the SQL both SQLite
   * and PostgreSQL accept, `R.` for the row image) whose one column is `ref`:
   * the ids of every other row that references this one, whatever parent the
   * row itself names.
   */
  | { readonly prefix: string; readonly rows: string }
  /**
   * Listing scope keys `<facet>:<scope>` of a product: `all`, `cat:<a>` for the
   * category and each ancestor (via `category_closure`), and `brand:<id>`.
   * `row` reads is_public/category_id/brand_id from R itself (the
   * `product_buyer_state` row); `product` looks up the public buyer state of
   * the product id in `R.<column>`.
   */
  | {
      readonly scopes: "lm" | `lo:${CacheDepListOrderFacet}` | "lf";
      readonly from: { readonly row: true } | { readonly product: string };
    };

export type CacheDepEvent = "insert" | "update" | "delete";

export interface CacheDepRule {
  /** Trigger name suffix, unique per table. */
  readonly name: string;
  readonly event: CacheDepEvent;
  /** The row image the keys (and `where`) read. */
  readonly image: CacheDepImage;
  /**
   * Update rules: fire only when one of these columns changed (`IS NOT`).
   * `"visible"` means any column not in the table's `noise` list.
   */
  readonly changed?: readonly string[] | "visible";
  /**
   * Update rules on `product_variants`: also fire when the SKU's buyer
   * availability band changed (stock inside a band never fires).
   */
  readonly bandChanged?: true;
  /**
   * Extra guard over the row image, as `column = value` pairs (ANDed) and an
   * optional EXISTS subquery written in the SQL both SQLite and PostgreSQL
   * accept (`R.` stands for the row image).
   */
  readonly where?: { readonly equals?: Readonly<Record<string, number | string>>; readonly exists?: string };
  readonly keys: readonly CacheDepKeyTemplate[];
  /**
   * Set only on a derived old-image companion (`withOldImageCompanions`): the
   * rule it mirrors, and the key-bearing columns of which at least one must
   * have changed for the old image's keys to differ from the new image's.
   */
  readonly companionOf?: string;
  readonly keyColumnsChanged?: readonly string[];
}

export interface CacheDepTableSpec {
  /** Key kinds a change of this table advances; a read of it is covered by a declared key of any of them. */
  readonly kinds: readonly CacheDepKind[];
  /** Columns whose change is never buyer-visible (revisions, timestamps, raw stock). */
  readonly noise: readonly string[];
  readonly rules: readonly CacheDepRule[];
  /** Why the keys are what they are, when it is not obvious. */
  readonly note?: string;
}

const p = (column: string): CacheDepKeyTemplate => ({ prefix: "p:", columns: [column] });
const own = (kind: string, column = "id"): CacheDepKeyTemplate[] => [
  { prefix: `${kind}:`, columns: [column] },
  { dep: `${kind}:${CACHE_DEP_ANY}` },
];

/**
 * insert (new image), delete (old image) and update of any visible column
 * (new image; its old-image companion is derived, see `withOldImageCompanions`).
 */
function everyChange(keys: readonly CacheDepKeyTemplate[]): CacheDepRule[] {
  return [
    { name: "ins", event: "insert", image: "new", keys },
    { name: "del", event: "delete", image: "old", keys },
    { name: "upd", event: "update", image: "new", changed: "visible", keys },
  ];
}

/** Row-image columns a key template reads (`R.<column>`). */
function templateColumns(template: CacheDepKeyTemplate): string[] {
  if ("dep" in template) return [];
  if ("columns" in template) return [...template.columns];
  if ("lookup" in template) return [template.lookup.column];
  if ("rows" in template) return [...template.rows.matchAll(/\bR\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]!);
  return "row" in template.from ? ["category_id", "brand_id"] : [template.from.product];
}

/**
 * Every row-image column an update rule's keys and guard read: when none of
 * them changed, the old image derives exactly the new image's keys (lookups
 * and scopes are read from the same committed state), so the companion only
 * needs to fire when one did.
 */
export function cacheDepKeyBearingColumns(rule: CacheDepRule): string[] {
  const columns = new Set<string>();
  for (const template of rule.keys) for (const column of templateColumns(template)) columns.add(column);
  for (const column of Object.keys(rule.where?.equals ?? {})) columns.add(column);
  for (const match of (rule.where?.exists ?? "").matchAll(/\bR\.([A-Za-z_][A-Za-z0-9_]*)/g)) columns.add(match[1]!);
  return [...columns];
}

/**
 * Every update rule written for the new row image, plus its old-image
 * companion `<name>_old` when a key-bearing column can change: the same
 * guard and keys over OLD, firing only when one of those columns changed. A
 * row moved out of a menu, category, brand, product or promotion therefore
 * advances the scope it left as well as the one it joined.
 */
export function withOldImageCompanions(rules: readonly CacheDepRule[]): CacheDepRule[] {
  const expanded: CacheDepRule[] = [];
  for (const rule of rules) {
    expanded.push(rule);
    if (rule.event !== "update" || rule.image !== "new" || rule.companionOf !== undefined) continue;
    const keyColumns = cacheDepKeyBearingColumns(rule);
    if (keyColumns.length === 0) continue;
    expanded.push({ ...rule, name: `${rule.name}_old`, image: "old", companionOf: rule.name, keyColumnsChanged: keyColumns });
  }
  return expanded;
}

/** The market columns that say how a market prices (0120). */
const MARKET_PRICING_COLUMNS = ["price_mode", "fx_rate", "price_adjustment_bps", "price_rounding_minor", "price_ending_minor"] as const;

/** A price list a public read applies: active, and a market or sale list. */
const PUBLIC_PRICE_LIST = "SELECT 1 WHERE R.kind <> 'segment' AND R.status = 'active'";

/** A country row whose market is active (`R.market_id`): only such a country is one the store sells to. */
const SELLS_ACTIVE_MARKET = "SELECT 1 FROM markets WHERE markets.id = R.market_id AND markets.status = 'active'";

const TIMESTAMPS = ["created_at", "updated_at"] as const;

/** A translation of a resource with its own key (every type but a product's SKUs, options and values). */
const TRANSLATION_OWNS_ITS_KEY = "SELECT 1 WHERE R.resource_type NOT IN ('product_variant', 'product_option', 'product_option_value')";

/**
 * A merchant unlinked some location from some channel (MARKETS-DESIGN D6): a
 * channel's sellable stock is then the on-hand of its linked locations, which
 * a stock or reservation change can move inside a SKU's raw availability
 * band. A new channel links every location and a new location every channel
 * (triggers), so a store that never unlinked one never matches.
 */
const CHANNEL_STOCK_PARTIAL = "SELECT 1 FROM sales_channels AS partial_channel, inventory_locations AS partial_location WHERE NOT EXISTS (SELECT 1 FROM sales_channel_locations AS partial_link WHERE partial_link.channel_id = partial_channel.id AND partial_link.location_id = partial_location.id)";

/** The default online store's id (`ONLINE_STORE_CHANNEL_ID` in `@scalius/shared/sales-channels`). */
const ONLINE_STORE_CHANNEL = "sc_online_store";

/** A stock level at a location some channel does not sell (`R.location_id`). */
const LEVEL_AT_UNLINKED_LOCATION = "SELECT 1 FROM sales_channels AS unlinked_channel WHERE NOT EXISTS (SELECT 1 FROM sales_channel_locations AS unlinked_link WHERE unlinked_link.channel_id = unlinked_channel.id AND unlinked_link.location_id = R.location_id)";

const BUYER_MEMBERSHIP = ["is_public", "category_id", "brand_id", "product_created_at"] as const;
const PUBLIC_ROW = { equals: { is_public: 1 } } as const;

/**
 * A sitemap `<lastmod>` (and the product feed's `updatedAt`): the one public
 * output of `updated_at`. List and detail payloads do not output it, so it is
 * noise for the entity's generic rule, and this rule advances the discovery
 * key and the entity's own keys when it moves. Writes that change nothing do
 * not touch `updated_at`, so the lastmod stays truthful.
 */
function lastmod(keys: readonly CacheDepKeyTemplate[]): CacheDepRule {
  return { name: "lastmod", event: "update", image: "new", changed: ["updated_at"], keys: [{ dep: "lm:seo" }, ...keys] };
}

/** The products whose SKUs assign this option definition or value (`R.id`). */
const SKUS_ASSIGNING = (column: "option_definition_id" | "option_value_id") =>
  `SELECT assigning_sku.product_id AS ref FROM product_variant_option_values AS assignment JOIN product_variants AS assigning_sku ON assigning_sku.id = assignment.variant_id WHERE assignment.${column} = R.id`;

/** Products and SKUs whose existence or activity the layout's store-shape counts read. */
const SHAPE = { dep: "lm:shape" } as const;

/**
 * The on-sale home list's candidate window (catalog/home-lists.ts): the
 * newest public discount-marked products and the products of the newest
 * live discount-marked SKUs. A row enters or leaves that window, or moves in
 * its order, only through a write to a marked row (or a product with a
 * marked SKU), which advances `lo:sale:all`; the candidates themselves are
 * each read's own `p:` keys. The marker is the partial indexes' predicate
 * (`ON_SALE_DISCOUNT_SQL` in the database schema).
 */
const SALE = { dep: "lo:sale:all" } as const;
const saleMarked = (row: string) =>
  `((${row}.discount_type = 'flat' AND ${row}.discount_amount_minor > 0) OR (${row}.discount_type = 'percentage' AND ${row}.discount_bps > 0))`;
const SALE_PRODUCT = {
  exists: `SELECT 1 WHERE ${saleMarked("R")} OR EXISTS (SELECT 1 FROM product_variants AS sale_sku WHERE sale_sku.product_id = R.id AND sale_sku.deleted_at IS NULL AND ${saleMarked("sale_sku")})`,
} as const;
const SALE_SKU = { exists: `SELECT 1 WHERE R.deleted_at IS NULL AND ${saleMarked("R")}` } as const;
const SALE_DISCOUNT = ["discount_type", "discount_amount_minor", "discount_bps"] as const;

/**
 * Every buyer-visible table. Columns in `noise` are never buyer-visible; any
 * other column is (a new column is visible until someone lists it as noise).
 * A column is noise only when no public payload outputs it (the opt-in audit
 * apps/api/src/cache-deps-noise-audit.test.ts renders every cached route while
 * changing each noise column) and it churns on writes a buyer cannot see.
 */
const CACHE_DEP_TABLE_RULES = {
  // --- Catalogue: products and their parts ---------------------------------
  products: {
    kinds: ["p", "lo", "lm", "srch"],
    noise: ["aggregate_revision", "updated_at", "tax_classification_version"],
    note: "Membership, price and band come from product_buyer_state, refreshed in the same batch; the price filter alone reads the product discount live (`price_order`). `lm:shape`: the layout's count of active products and their SKUs.",
    rules: [
      { name: "ins", event: "insert", image: "new", keys: [p("id"), { dep: "srch" }, SHAPE] },
      { name: "del", event: "delete", image: "old", keys: [p("id"), { dep: "srch" }, SHAPE] },
      { name: "upd", event: "update", image: "new", changed: "visible", keys: [p("id")] },
      // Search matches a product by its text and by its category's name or slug
      // (`productCategoryNameMatch` reads products.category_id).
      { name: "srch", event: "update", image: "new", changed: ["name", "description", "category_id"], keys: [{ dep: "srch" }] },
      { name: "shape", event: "update", image: "new", changed: ["is_active", "deleted_at"], keys: [SHAPE] },
      lastmod([p("id")]),
      {
        name: "name_order", event: "update", image: "new", changed: ["name"],
        keys: [{ scopes: "lo:name", from: { product: "id" } }],
      },
      // The price filter (buyerCatalogHasSkuInPriceRange) computes each SKU's
      // effective price live from these product columns, so a raw product
      // discount write can move the product across a listing's price bounds
      // before its buyer state is refreshed (0122).
      {
        name: "price_order", event: "update", image: "new", changed: [...SALE_DISCOUNT],
        keys: [{ scopes: "lo:price", from: { product: "id" } }],
      },
      {
        name: "seo", event: "update", image: "new",
        // Deployed 0100 also named exclude_from_product_feed, dropped in 0122
        // (the feed channels' publications replace it): CACHE_DEP_BASELINE_CHANGED.
        changed: ["no_index", "exclude_from_sitemap"],
        keys: [{ dep: "lm:seo" }],
      },
      { name: "sale_ins", event: "insert", image: "new", where: SALE_PRODUCT, keys: [SALE] },
      { name: "sale_del", event: "delete", image: "old", where: SALE_PRODUCT, keys: [SALE] },
      {
        name: "sale_upd", event: "update", image: "new", where: SALE_PRODUCT,
        changed: [...SALE_DISCOUNT, "created_at", "is_active", "deleted_at"], keys: [SALE],
      },
    ],
  },
  product_buyer_state: {
    kinds: ["p", "lm", "lo"],
    noise: ["refreshed_at"],
    note: "Only public rows are in listings; a flip of is_public or a category/brand move is a membership change of both images (the old image through the derived companions).",
    rules: [
      { name: "ins", event: "insert", image: "new", where: PUBLIC_ROW, keys: [p("product_id"), { scopes: "lm", from: { row: true } }] },
      { name: "del", event: "delete", image: "old", where: PUBLIC_ROW, keys: [p("product_id"), { scopes: "lm", from: { row: true } }] },
      {
        name: "member", event: "update", image: "new", changed: BUYER_MEMBERSHIP, where: PUBLIC_ROW,
        keys: [p("product_id"), { scopes: "lm", from: { row: true } }],
      },
      {
        name: "price", event: "update", image: "new", changed: ["from_minor", "to_minor", "base_minor"], where: PUBLIC_ROW,
        keys: [p("product_id"), { scopes: "lo:price", from: { row: true } }],
      },
      {
        name: "band", event: "update", image: "new", changed: ["available_for_sale", "availability_band"], where: PUBLIC_ROW,
        keys: [p("product_id"), { scopes: "lo:band", from: { row: true } }],
      },
      {
        name: "disc", event: "update", image: "new", changed: ["has_discount", "discount_depth_bps"], where: PUBLIC_ROW,
        keys: [p("product_id"), { scopes: "lo:disc", from: { row: true } }],
      },
      {
        name: "card", event: "update", image: "new", changed: ["sku_id", "has_customer_options"], where: PUBLIC_ROW,
        keys: [p("product_id")],
      },
    ],
  },
  product_facet_values: {
    kinds: ["lf"],
    noise: [],
    note: "Facet counts of the product's public scopes. The per-write refresh rewrites only rows that differ.",
    rules: everyChange([{ scopes: "lf", from: { product: "product_id" } }]),
  },
  product_variants: {
    kinds: ["p", "lm", "lo"],
    noise: ["stock", "reserved_stock", "stock_version", "version", "updated_at", "tax_classification_version", "cost_minor"],
    note: "Raw stock (and updated_at, which every stock write sets) is noise; a change of the SKU's availability band (the SQL twin of resolveBuyerAvailabilityBand with the store default threshold) is not. The unit cost (0109) is staff-only and never read by a public route. `lm:shape`: SKU existence for the layout's store-shape counts.",
    rules: [
      { name: "ins", event: "insert", image: "new", keys: [p("product_id"), SHAPE] },
      { name: "del", event: "delete", image: "old", keys: [p("product_id"), SHAPE] },
      { name: "upd", event: "update", image: "new", changed: "visible", keys: [p("product_id")] },
      { name: "shape", event: "update", image: "new", changed: ["deleted_at", "product_id", "fulfillment_kind"], keys: [SHAPE] },
      { name: "band", event: "update", image: "new", bandChanged: true, keys: [p("product_id")] },
      // A channel's band reads the on-hand of its linked locations; only once
      // a merchant unlinked one can raw stock inside its band move it (0122).
      {
        name: "chstock", event: "update", image: "new", changed: ["stock", "reserved_stock"],
        where: { exists: CHANNEL_STOCK_PARTIAL }, keys: [p("product_id")],
      },
      { name: "sale_ins", event: "insert", image: "new", where: SALE_SKU, keys: [SALE] },
      { name: "sale_del", event: "delete", image: "old", where: SALE_SKU, keys: [SALE] },
      {
        name: "sale_upd", event: "update", image: "new", where: SALE_SKU,
        changed: [...SALE_DISCOUNT, "created_at", "deleted_at", "product_id"], keys: [SALE],
      },
    ],
  },
  inventory_levels: {
    kinds: ["p"],
    noise: ["updated_at"],
    note: "A channel's sellable stock subtracts its SKU's on-hand at the locations it does not sell (0122), so only a level at such a location is buyer-visible: it advances its SKU's product. Levels at linked locations sum into the SKU's stock, whose own rules (band, chstock) cover them.",
    rules: everyChange([{
      prefix: "p:",
      lookup: { table: "product_variants", select: "product_id", key: "id", column: "variant_id" },
    }]).map((rule): CacheDepRule => ({ ...rule, where: { exists: LEVEL_AT_UNLINKED_LOCATION } })),
  },
  product_media: { kinds: ["p"], noise: [...TIMESTAMPS], rules: everyChange([p("product_id")]) },
  product_option_definitions: {
    kinds: ["p"],
    noise: [...TIMESTAMPS],
    note: "A product's option topology is read through its SKUs' option assignments, so a definition also advances every product whose SKUs reference it (a definition moved to another product keeps the SKUs that still point at it).",
    rules: everyChange([p("product_id"), { prefix: "p:", rows: SKUS_ASSIGNING("option_definition_id") }]),
  },
  product_option_values: {
    kinds: ["p"],
    noise: [...TIMESTAMPS],
    rules: everyChange([
      {
        prefix: "p:",
        lookup: { table: "product_option_definitions", select: "product_id", key: "id", column: "option_definition_id" },
      },
      { prefix: "p:", rows: SKUS_ASSIGNING("option_value_id") },
    ]),
  },
  product_variant_option_values: {
    kinds: ["p"],
    noise: [],
    rules: everyChange([{
      prefix: "p:",
      lookup: { table: "product_variants", select: "product_id", key: "id", column: "variant_id" },
    }]),
  },
  product_attribute_values: {
    kinds: ["p", "lm"],
    noise: ["created_at"],
    note: "`lm:shape`: the layout asks whether any public product has a key-spec value, so a value of a key-spec attribute advances it (the attribute's own flag is `attr:*`).",
    rules: [
      ...everyChange([p("product_id")]),
      ...everyChange([SHAPE]).map((rule): CacheDepRule => ({
        ...rule,
        name: `spec_${rule.name}`,
        where: { exists: "SELECT 1 FROM product_attributes AS spec_attribute WHERE spec_attribute.id = R.attribute_id AND spec_attribute.key_spec = 1" },
      })),
    ],
  },
  product_rich_content: { kinds: ["p"], noise: [...TIMESTAMPS], rules: everyChange([p("product_id")]) },
  product_content_blocks: { kinds: ["p"], noise: [...TIMESTAMPS], rules: everyChange([p("product_id")]) },
  product_bundles: { kinds: ["p"], noise: [...TIMESTAMPS], rules: everyChange([p("product_id")]) },
  product_reviews: {
    kinds: ["p"],
    noise: ["updated_at", "version", "edit_count_day", "edit_day", "check_flags", "moderation_reason", "reply_user_id", "reviewer_key"],
    note: "Published reviews on the product page and its review pages. A review exists only on a real order line, so no key is shared across products.",
    rules: everyChange([p("product_id")]),
  },
  product_review_stats: {
    kinds: ["p", "lo", "lm"],
    noise: ["updated_at"],
    note: "The review projection (triggers on product_reviews keep it): the product's summary and card rating, and the rating facet and order of its scopes. Every review write that changes a published count advances the keys at commit, so reviews need no scheduled bump.",
    rules: [
      ...everyChange([p("product_id"), { scopes: "lo:rating", from: { product: "product_id" } }]),
      // `lm:shape`: the layout asks whether any product has a published
      // review. Only a rank appearing or disappearing changes that; the
      // update rule's old-image companion covers null -> rated.
      { name: "shape_ins", event: "insert", image: "new", where: { exists: "SELECT 1 WHERE R.rating_rank_milli IS NOT NULL" }, keys: [SHAPE] },
      { name: "shape_del", event: "delete", image: "old", where: { exists: "SELECT 1 WHERE R.rating_rank_milli IS NOT NULL" }, keys: [SHAPE] },
      {
        name: "shape", event: "update", image: "new", changed: ["rating_rank_milli"],
        where: { exists: "SELECT 1 WHERE R.rating_rank_milli IS NULL" }, keys: [SHAPE],
      },
    ],
  },
  warranty_policies: {
    kinds: ["p"],
    noise: ["version", "current_revision_id", ...TIMESTAMPS],
    note: "The product page shows its live policy's current terms; a policy edit advances every product that points at it (policy edits are rare).",
    rules: everyChange([{ prefix: "p:", rows: "SELECT warranty_product.id AS ref FROM products AS warranty_product WHERE warranty_product.warranty_policy_id = R.id" }]),
  },

  // --- Catalogue structure ------------------------------------------------------
  categories: {
    kinds: ["c", "srch", "lm"],
    noise: ["revision", "updated_at"],
    rules: [
      ...everyChange(own("c")),
      { name: "srch", event: "update", image: "new", changed: ["name", "description"], keys: [{ dep: "srch" }] },
      lastmod(own("c")),
    ],
  },
  category_closure: {
    kinds: ["c", "lm"],
    noise: [],
    note: "A tree move changes which ancestor subtrees list the moved products, and every descendant's breadcrumb.",
    rules: everyChange([
      { prefix: "lm:cat:", columns: ["ancestor_id"] },
      { prefix: "c:", columns: ["ancestor_id"] },
      { prefix: "c:", columns: ["descendant_id"] },
      { dep: "c:*" },
    ]),
  },
  category_attribute_sets: {
    kinds: ["c"],
    noise: [],
    rules: everyChange([{ prefix: "c:", columns: ["category_id"] }]),
  },
  brands: { kinds: ["b", "lm"], noise: ["revision", "updated_at"], rules: [...everyChange(own("b")), lastmod(own("b"))] },
  collections: { kinds: ["col", "lm"], noise: ["version", "updated_at"], rules: [...everyChange(own("col")), lastmod(own("col"))] },
  product_attributes: { kinds: ["attr"], noise: [...TIMESTAMPS], rules: everyChange(own("attr")) },
  attribute_values: {
    kinds: ["attr"],
    noise: [...TIMESTAMPS],
    rules: everyChange([{ prefix: "attr:", columns: ["attribute_id"] }, { dep: "attr:*" }]),
  },
  attribute_groups: { kinds: ["attr"], noise: [...TIMESTAMPS], rules: everyChange([{ dep: "attr:*" }]) },
  media: {
    kinds: ["m"],
    noise: ["version", "updated_at", "folder_id"],
    rules: everyChange([{ prefix: "m:", columns: ["id"] }]),
  },

  // --- Content, layout and settings ---------------------------------------------
  pages: { kinds: ["pg", "lm"], noise: ["revision", "updated_at"], rules: [...everyChange(own("pg")), lastmod(own("pg"))] },
  settings: {
    kinds: ["set"],
    noise: ["revision", "updated_at"],
    rules: everyChange([{ prefix: "set:", columns: ["category", "key"] }]),
  },
  theme_settings: { kinds: ["theme"], noise: ["revision", ...TIMESTAMPS], rules: everyChange([{ dep: "theme" }]) },
  navigation_menus: {
    kinds: ["nav"],
    noise: ["revision", "updated_at"],
    note: "`revision` counts draft edits; public reads show the published revision (published_revision, dependency_revision), so a draft edit invalidates nothing.",
    rules: everyChange(own("nav")),
  },
  navigation_menu_publications: {
    kinds: ["nav"],
    noise: [],
    rules: everyChange([{ prefix: "nav:", columns: ["menu_id"] }, { dep: "nav:*" }]),
  },
  navigation_menu_publication_items: {
    kinds: ["nav"],
    noise: [],
    rules: everyChange([{ prefix: "nav:", columns: ["menu_id"] }, { dep: "nav:*" }]),
  },
  navigation_placements: {
    kinds: ["nav"],
    noise: ["revision", "updated_at"],
    rules: everyChange([{ prefix: "nav:", columns: ["menu_id"] }, { dep: "nav:*" }]),
  },
  analytics: { kinds: ["an"], noise: ["revision", "updated_at"], rules: everyChange([{ dep: "an" }]) },
  checkout_languages: { kinds: ["lang"], noise: ["revision", "updated_at"], rules: everyChange([{ dep: "lang" }]) },

  // --- Shipping, locations, tax, promotions ---------------------------------------
  shipping_methods: { kinds: ["ship"], noise: ["updated_at"], rules: everyChange([{ dep: "ship" }]) },
  delivery_zones: { kinds: ["ship"], noise: ["revision", "updated_at"], rules: everyChange([{ dep: "ship" }]) },
  delivery_zone_locations: { kinds: ["ship"], noise: [], rules: everyChange([{ dep: "ship" }]) },
  delivery_zone_regions: {
    kinds: ["ship"],
    noise: ["created_at"],
    note: "The countries, admin areas and postal prefixes a shipping zone serves (MARKETS-DESIGN step 3b): which rates an address gets and which countries discovery claims.",
    rules: everyChange([{ dep: "ship" }]),
  },
  places: {
    kinds: ["loc"],
    noise: ["source", "source_key", "source_version", "source_active", "updated_at"],
    note: "The place directory (docs/PLACES.md): the City/Thana/Area pickers read it. Import bookkeeping (source columns) is never shown.",
    rules: everyChange([{ dep: "loc" }]),
  },
  tax_classes: { kinds: ["tax"], noise: ["version", "updated_at"], rules: everyChange([{ dep: "tax" }]) },
  tax_rates: { kinds: ["tax"], noise: ["version", "updated_at"], rules: everyChange([{ dep: "tax" }]) },
  tax_settings: { kinds: ["tax"], noise: ["version", "updated_at"], rules: everyChange([{ dep: "tax" }]) },
  tax_regions: {
    kinds: ["tax"],
    noise: ["version", "created_at", "updated_at"],
    note: "Where the merchant collects tax and with which provider (MARKETS-DESIGN step 3c). No cached read outputs tax today: the live quote reads it under the checkout fence.",
    rules: everyChange([{ dep: "tax" }]),
  },
  promotions: { kinds: ["promo"], noise: ["revision", "updated_at"], rules: everyChange(own("promo")) },
  promotion_codes: {
    kinds: ["promo"],
    noise: [],
    rules: everyChange([{ prefix: "promo:", columns: ["promotion_id"] }, { dep: "promo:*" }]),
  },
  promotion_conditions: {
    kinds: ["promo"],
    noise: [],
    rules: everyChange([{ prefix: "promo:", columns: ["promotion_id"] }, { dep: "promo:*" }]),
  },
  promotion_effects: {
    kinds: ["promo"],
    noise: [],
    rules: everyChange([{ prefix: "promo:", columns: ["promotion_id"] }, { dep: "promo:*" }]),
  },
  promotion_redemptions: {
    kinds: ["promo"],
    noise: [],
    note: "Redemptions change what a buyer sees only for a promotion with a redemption or spend limit; unlimited promotions never advance a key at checkout.",
    rules: (["insert", "update", "delete"] as const).map((event): CacheDepRule => ({
      name: event.slice(0, 3),
      event,
      image: event === "delete" ? "old" : "new",
      ...(event === "update" ? { changed: "visible" as const } : {}),
      where: {
        exists: "SELECT 1 FROM promotions WHERE promotions.id = R.promotion_id AND (promotions.max_redemptions IS NOT NULL OR promotions.max_discount_spend_minor IS NOT NULL)",
      },
      keys: [{ prefix: "promo:", columns: ["promotion_id"] }],
    })),
  },
  promotion_customer_segments: {
    kinds: ["promo"],
    noise: ["created_at"],
    note: "A promotion limited to customer segments is never shown on public offer reads (it depends on who is signed in), so linking or unlinking a segment changes which promotions public reads list. Segment definitions and membership are private and evaluated live at checkout.",
    rules: everyChange([{ prefix: "promo:", columns: ["promotion_id"] }, { dep: "promo:*" }]),
  },
  // --- Custom fields (COMMERCE-HOOKS H4) ----------------------------------------
  custom_field_definitions: {
    kinds: ["cf"],
    noise: ["description", "validations", "revision", "created_at", "updated_at"],
    note: "Public reads output a storefront-visible definition's identity, name, type and position beside its values, so a change of a visible definition (or one turning visible or hidden, through the old-image companion) advances `cf:<owner_type>`, which every reader of custom fields declares. Deleting one cascades to its values, whose own triggers then find no visible definition: this key covers them.",
    rules: everyChange([{ prefix: "cf:", columns: ["owner_type"] }])
      .map((rule): CacheDepRule => ({ ...rule, where: { equals: { storefront_visible: 1 } } })),
  },
  custom_field_values: {
    kinds: ["p", "c", "col", "b", "pg"],
    noise: ["updated_at"],
    note: "A value reaches buyers only through a storefront-visible definition, on its owner's page: the owner's own keys (a SKU's value its product's). Customer and order values never do.",
    rules: (
      [
        ["product", [p("owner_id")]],
        ["variant", [{ prefix: "p:", lookup: { table: "product_variants", select: "product_id", key: "id", column: "owner_id" } }]],
        ["category", own("c", "owner_id")],
        ["collection", own("col", "owner_id")],
        ["brand", own("b", "owner_id")],
        ["page", own("pg", "owner_id")],
      ] as const
    ).flatMap(([ownerType, keys]) => everyChange(keys).map((rule): CacheDepRule => ({
      ...rule,
      name: `${ownerType}_${rule.name}`,
      where: {
        equals: { owner_type: ownerType },
        exists: "SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = R.definition_id AND cf_definition.storefront_visible = 1",
      },
    }))),
  },

  product_recommendations: {
    kinds: ["rec"], noise: ["computed_at"],
    rules: everyChange([{ prefix: "rec:", columns: ["product_id"] }]),
  },
  product_sales_stats: {
    kinds: ["sold", "popular"], noise: ["computed_at"],
    // Match card-facts.CARD_SOLD_MIN (10) and home-lists.MIN_POPULAR_UNITS (2).
    // A hidden count changing below a threshold does not affect that surface.
    rules: [
      ...everyChange([{ prefix: "sold:", columns: ["product_id"] }]).map((rule) => ({
        ...rule, name: `sold_${rule.name}`, where: { exists: "SELECT 1 WHERE R.sold_30d >= 10" },
      })),
      ...everyChange([{ dep: "popular" }]).map((rule) => ({
        ...rule, name: `popular_${rule.name}`, where: { exists: "SELECT 1 WHERE R.sold_30d >= 2" },
      })),
    ],
  },
  // --- Apps (docs/platform/PLUGINS.md) -------------------------------------------
  plugin_installations: {
    kinds: ["plg"],
    noise: ["revision", "updated_at", "installed_by", "activated_by", "installed_at", "activated_at", "failure_reason"],
    note: "Storefront app output (sections, product blocks, scripts) and the checkout's app payment methods read the installation's status, version, grant, manifest and settings.",
    rules: everyChange(own("plg", "plugin_id")),
  },
  plugin_registrations: {
    kinds: ["plg"],
    noise: [],
    note: "Derived from the manifest in the batch of every installation write; read with the installation (which providers and functions an active app has).",
    rules: everyChange(own("plg", "plugin_id")),
  },
  plugin_records: {
    kinds: ["plgs"],
    noise: ["revision", "created_at", "updated_at", "idx1", "idx2", "idx3", "idx4", "uq1", "uq2"],
    note: "A storefront render reads only the collections its section declares in reads; the index columns are derived from data_json.",
    rules: everyChange([{ prefix: "plgs:", columns: ["plugin_id", "collection"] }]),
  },

  // --- Markets (docs/MARKETS-DESIGN.md D4) -----------------------------------------
  markets: {
    kinds: ["mk", "pl"],
    // `prices_include_tax` (0116) is output only by the live tax quote and the
    // order, which read it under the checkout fence; no cached read shows it.
    // The pricing columns (0120) advance only the market's `pl:` key (rule
    // `pricing`): the presence matrix and the checkout config never show them.
    noise: ["revision", "created_at", "updated_at", "prices_include_tax", ...MARKET_PRICING_COLUMNS],
    note: "Readers of one market (a keyed public read) declare `mk:<id>`; the presence matrix (layout, sitemap index, the gateway's buyer-choice redirect) `mk:*`. Prices read the backup market's increment through `storePriceIncrementSql`, which declares `mk:backup`: only a change of that increment advances it, so editing markets never invalidates the catalogue. A market's price mode and FX policy advance `pl:<id>`, which its keyed catalogue reads declare.",
    rules: [
      ...everyChange(own("mk")),
      { name: "pricing", event: "update", image: "new", changed: MARKET_PRICING_COLUMNS, keys: [{ prefix: "pl:", columns: ["id"] }] },
      {
        name: "backup_price", event: "update", image: "new", changed: ["price_increment_minor"],
        where: { equals: { is_backup: 1 } }, keys: [{ dep: "mk:backup" }],
      },
      // The countries active markets sell to: a status change moves them, a rename or handle edit does not.
      { name: "selling_upd", event: "update", image: "new", changed: ["status"], keys: [{ dep: "mk:selling" }] },
      { name: "selling_del", event: "delete", image: "old", where: { equals: { status: "active" } }, keys: [{ dep: "mk:selling" }] },
    ],
  },
  market_countries: {
    kinds: ["mk"],
    noise: ["created_at"],
    note: "A country moved between markets advances both markets (the old image through the derived companion). A country of an active market also advances `mk:selling`, the set of countries sold to (the checkout config's phone countries).",
    rules: [
      ...everyChange([{ prefix: "mk:", columns: ["market_id"] }, { dep: "mk:*" }]),
      { name: "selling_ins", event: "insert", image: "new", where: { exists: SELLS_ACTIVE_MARKET }, keys: [{ dep: "mk:selling" }] },
      { name: "selling_del", event: "delete", image: "old", where: { exists: SELLS_ACTIVE_MARKET }, keys: [{ dep: "mk:selling" }] },
      { name: "selling_upd", event: "update", image: "new", changed: ["country_code", "market_id"], keys: [{ dep: "mk:selling" }] },
    ],
  },
  market_presences: {
    kinds: ["mk", "tr"],
    noise: ["created_at"],
    note: "A presence's locale and market, and the root presence's locale (the store default language), decide which translations a presence read resolves (`tr:locales`, 0121).",
    rules: [
      ...everyChange([{ prefix: "mk:", columns: ["market_id"] }, { dep: "mk:*" }]),
      ...everyChange([{ dep: "tr:locales" }]).map((rule): CacheDepRule => ({ ...rule, name: `locales_${rule.name}` })),
    ],
  },

  price_lists: {
    kinds: ["pl"],
    noise: ["name", "description", "revision", "created_at", "updated_at"],
    note: "Which public lists price a market (MARKETS-DESIGN D5): an active market or sale list entering, leaving or changing its schedule, priority or kind advances its market's `pl:<id>` (a list moved between markets or deactivated advances the one it left, through the derived companion). Drafts and segment lists are never read by a public route.",
    rules: everyChange([{ prefix: "pl:", columns: ["market_id"] }])
      .map((rule): CacheDepRule => ({ ...rule, where: { exists: PUBLIC_PRICE_LIST } })),
  },
  price_list_prices: {
    kinds: ["pl"],
    noise: ["created_at", "updated_at"],
    note: "A price of an active public list advances `pl:<market>:<product>` of its SKU's product. Deactivating or deleting the list advances the market's `pl:<id>`, which every keyed read declares too.",
    rules: everyChange([{
      prefix: "pl:",
      rows: `SELECT price_list.market_id || ':' || price_sku.product_id AS ref FROM price_lists AS price_list, product_variants AS price_sku WHERE price_list.id = R.price_list_id AND price_sku.id = R.variant_id AND price_list.kind <> 'segment' AND price_list.status = 'active'`,
    }]),
  },

  // --- Translations (docs/MARKETS-DESIGN.md D9) ------------------------------------
  store_languages: {
    kinds: ["mk", "tr"],
    noise: ["created_at", "updated_at"],
    note: "Only a published language's presences are served: publishing changes the presence matrix (`mk:*`) and the languages a presence read resolves (`tr:locales`).",
    rules: everyChange([{ dep: "mk:*" }, { dep: "tr:locales" }]),
  },
  translations: {
    kinds: ["tr"],
    noise: ["updated_at"],
    note: "A translation advances its resource's `tr:<type>:<id>` in every locale and market (presence reads of the resource declare it). A SKU's, an option's and an option value's advance their product's `tr:product:<id>`: the product page and cards declare that one key.",
    rules: [
      ...everyChange([{ prefix: "tr:", columns: ["resource_type", "resource_id"] }])
        .map((rule): CacheDepRule => ({ ...rule, where: { exists: TRANSLATION_OWNS_ITS_KEY } })),
      ...everyChange([{ prefix: "tr:product:", lookup: { table: "product_variants", select: "product_id", key: "id", column: "resource_id" } }])
        .map((rule): CacheDepRule => ({ ...rule, name: `sku_${rule.name}`, where: { equals: { resource_type: "product_variant" } } })),
      ...everyChange([{ prefix: "tr:product:", lookup: { table: "product_option_definitions", select: "product_id", key: "id", column: "resource_id" } }])
        .map((rule): CacheDepRule => ({ ...rule, name: `option_${rule.name}`, where: { equals: { resource_type: "product_option" } } })),
      ...everyChange([{
        prefix: "tr:product:",
        rows: "SELECT value_option.product_id AS ref FROM product_option_values AS translated_value JOIN product_option_definitions AS value_option ON value_option.id = translated_value.option_definition_id WHERE translated_value.id = R.resource_id",
      }]).map((rule): CacheDepRule => ({ ...rule, name: `value_${rule.name}`, where: { equals: { resource_type: "product_option_value" } } })),
    ],
  },
  localized_slugs: {
    kinds: ["tr"],
    noise: ["updated_at"],
    note: "A handle advances its resource's `tr:<type>:<id>` (its presence pages and cards) and `tr:handles:<type>:<id>` (a root page's alternates), the handle space of its type and locale (`tr:slugs:<type>:<locale>`, a sitemap's handles) and of its type (`tr:slugs:<type>`, which a handle lookup declares).",
    rules: everyChange([
      { prefix: "tr:", columns: ["resource_type", "resource_id"] },
      { prefix: "tr:handles:", columns: ["resource_type", "resource_id"] },
      { prefix: "tr:slugs:", columns: ["resource_type", "locale"] },
      { prefix: "tr:slugs:", columns: ["resource_type"] },
    ]),
  },

  // --- Sales channels (docs/MARKETS-DESIGN.md D6) -----------------------------------
  sales_channels: {
    kinds: ["lm"],
    noise: ["handle", "name", "position", "created_at", "updated_at"],
    note: "Catalogue feeds and the UCP catalogue read their channel's status (an inactive channel lists nothing): they declare `lm:seo`. The online store is always active. Names and handles are dashboard-only.",
    rules: everyChange([{ dep: "lm:seo" }]),
  },
  product_channel_publications: {
    kinds: ["p", "lm", "srch"],
    noise: ["published_at"],
    note: "A product is published to a channel while its row has no unpublished_at. Any channel: the product's own keys and the discovery key (feeds and UCP read their channel's rows). The online store's rows also decide public membership for live readers (site search, collection lists, a product page's 404), so they advance `lm:all` and `srch`; listings and sitemaps read the buyer-state projection, refreshed in the same batch.",
    rules: [
      ...everyChange([p("product_id"), { dep: "lm:seo" }]),
      ...everyChange([{ dep: "lm:all" }, { dep: "srch" }]).map((rule): CacheDepRule => ({
        ...rule, name: `store_${rule.name}`, where: { equals: { channel_id: ONLINE_STORE_CHANNEL } },
      })),
    ],
  },
  sales_channel_locations: {
    kinds: ["store"],
    noise: ["created_at"],
    note: "Which locations' on-hand a channel sells: linking or unlinking one can change the availability of every product a channel shows, so it advances `store` (a rare merchant setting).",
    rules: everyChange([{ dep: "store" }]),
  },

  orders: {
    kinds: ["recommendation-signals"], noise: [],
    note: "Only live fallback ranking reads private order signals; no order or buyer identifier enters a dependency key.",
    rules: everyChange([{ dep: "recommendation-signals" }]).map((rule) => ({
      ...rule,
      ...(rule.event === "update" ? { changed: ["id", "status", "customer_phone", "created_at", "deleted_at"] } : {}),
      where: { exists: "SELECT 1 WHERE R.deleted_at IS NULL AND R.status IN ('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed')" },
    })),
  },
  order_items: {
    kinds: ["recommendation-signals"], noise: [],
    rules: everyChange([{ dep: "recommendation-signals" }]).map((rule) => ({
      ...rule,
      ...(rule.event === "update" ? { changed: ["product_id", "order_id"] } : {}),
    })),
  },
} as const satisfies Record<string, CacheDepTableSpec>;

export type CacheDepTable = keyof typeof CACHE_DEP_TABLE_RULES;

/**
 * Every buyer-visible table and its rules, with the derived old-image
 * companion of every update rule whose keys or guard read a column an update
 * can change (`withOldImageCompanions`). The triggers are generated from this.
 */
export const CACHE_DEP_TABLES: Readonly<Record<CacheDepTable, CacheDepTableSpec>> = Object.fromEntries(
  (Object.entries(CACHE_DEP_TABLE_RULES) as Array<[CacheDepTable, CacheDepTableSpec]>)
    .map(([table, spec]) => [table, { ...spec, rules: withOldImageCompanions(spec.rules) }]),
) as unknown as Record<CacheDepTable, CacheDepTableSpec>;

// ---------------------------------------------------------------------------
// Tables that never need a key
// ---------------------------------------------------------------------------

const PRIVATE = "Private or operational: never read by a public cached route.";
const DERIVED_STOCK = "Stock ledger: its buyer-visible effect is the SKU band on product_variants and product_buyer_state, which are registered.";
const DRAFTS = "Dashboard drafts, history or sessions: public reads use the published row, which is registered.";
const MACHINERY = "Cache machinery itself.";
const FTS = "FTS index maintained by triggers from products/categories name and description, which advance srch.";
const PURCHASING = "Purchasing and transfer documents: staff-only; buyers never see incoming or in-transit stock.";

/** No table uses age-based freshness; retained for recording API compatibility. */
export const CACHE_DEP_SOFT_TABLES: readonly string[] = [];
export type CacheDepSoftTable = never;

/** Tables a public read may touch (or that exist) without a key of their own, with the reason. */
export const CACHE_DEP_EXEMPT_TABLES: Readonly<Record<string, string>> = {
  // Derived or machinery.
  products_fts: FTS,
  categories_fts: FTS,
  cache_clock: MACHINERY,
  cache_dep: MACHINERY,
  cache_generation: MACHINERY,
  scalius_schema_migrations: "Schema ledger; a release changes the Worker version, which is in every cache key.",
  inventory_movements: DERIVED_STOCK,
  inventory_operations: DERIVED_STOCK,
  inventory_locations: "Where physical stock is held; buyers see SKU availability bands, never locations.",
  product_low_stock_alerts: DERIVED_STOCK,
  // Purchasing and transfers (0109): staff-only documents. Their stock
  // effect is ledger movements, whose buyer-visible effect is the SKU band.
  inventory_commands: DERIVED_STOCK,
  inventory_transfers: PURCHASING,
  inventory_transfer_lines: PURCHASING,
  inventory_transfer_movements: DERIVED_STOCK,
  suppliers: PURCHASING,
  purchase_orders: PURCHASING,
  purchase_order_lines: PURCHASING,
  purchase_order_receipt_lines: DERIVED_STOCK,
  // Drafts and history.
  theme_settings_drafts: DRAFTS,
  theme_settings_versions: DRAFTS,
  theme_preview_sessions: DRAFTS,
  navigation_menu_items: DRAFTS,
  media_folders: "Dashboard organisation of media; never shown to buyers.",
  media_upload_sessions: PRIVATE,
  media_upload_parts: PRIVATE,
  // Private and operational.
  checkout_authority: "Checkout fence revision; cart and checkout are never cached.",
  delivery_providers: PRIVATE,
  delivery_shipments: PRIVATE,
  order_discount_allocations: PRIVATE,
  admin_fcm_tokens: PRIVATE,
  abandoned_checkouts: PRIVATE,
  checkout_attempts: PRIVATE,
  admin_order_create_attempts: PRIVATE,
  order_amendments: PRIVATE,
  order_receipts: PRIVATE,
  order_payment_recovery_challenges: PRIVATE,
  invoice_sequences: PRIVATE,
  order_invoices: PRIVATE,
  invoice_issue_commands: PRIVATE,
  order_returns: PRIVATE,
  order_return_lines: PRIVATE,
  order_return_commands: PRIVATE,
  order_return_receipt_lines: PRIVATE,
  order_tax_snapshots: PRIVATE,
  order_item_tax_snapshots: PRIVATE,
  order_payments: PRIVATE,
  refund_attempts: PRIVATE,
  order_support_requests: PRIVATE,
  order_events: PRIVATE,
  payment_session_attempts: PRIVATE,
  order_holds: PRIVATE,
  payment_plans: PRIVATE,
  cod_tracking: PRIVATE,
  webhook_events: PRIVATE,
  order_fulfillments: PRIVATE,
  order_fulfillment_lines: PRIVATE,
  customers: PRIVATE,
  // The address book (0113): read by the dashboard, the signed-in account and
  // checkout prefill (all private, no-store); no public cached read uses it.
  customer_addresses: PRIVATE,
  customer_history: PRIVATE,
  customer_auth_otp_challenges: PRIVATE,
  customer_sessions: PRIVATE,
  customer_auth_otp_rate_limits: PRIVATE,
  auth_otp_delivery_receipts: PRIVATE,
  // Customers & marketing (0108): consent, tags, segments and order facts are
  // dashboard/checkout data evaluated live; no public cached read uses them.
  customer_marketing_consents: PRIVATE,
  customer_marketing_consent_events: PRIVATE,
  customer_tag_links: PRIVATE,
  customer_segments: PRIVATE,
  customer_order_stats: PRIVATE,
  conversations: PRIVATE,
  conversation_messages: PRIVATE,
  conversation_attachments: PRIVATE,
  meta_conversions_logs: PRIVATE,
  meta_capi_purchase_outbox: PRIVATE,
  notification_outbox: PRIVATE,
  notification_delivery_receipts: PRIVATE,
  event_outbox: PRIVATE,
  webhook_subscriptions: PRIVATE,
  webhook_event_deliveries: PRIVATE,
  // Plugin runtime (installations, registrations and records are registered above).
  plugin_kv: "App key/value store: never readable while rendering storefront output (the bridge refuses it), so no public entry depends on it.",
  plugin_log_entries: PRIVATE,
  // Plugin event deliveries and cron claims (0107): platform bookkeeping.
  plugin_event_deliveries: PRIVATE,
  plugin_cron_runs: PRIVATE,
  user: PRIVATE,
  session: PRIVATE,
  account: PRIVATE,
  verification: PRIVATE,
  two_factor: PRIVATE,
  rate_limit: PRIVATE,
  admin_setup_claims: PRIVATE,
  admin_setup_rate_limits: PRIVATE,
  admin_invitations: PRIVATE,
  scanner_token_claims: PRIVATE,
  admin_identity_handoff_events: PRIVATE,
  permissions: PRIVATE,
  roles: PRIVATE,
  role_permissions: PRIVATE,
  user_roles: PRIVATE,
  user_permissions: PRIVATE,
  agent_grants: PRIVATE,
  agent_credentials: PRIVATE,
  agent_artifact_handles: PRIVATE,
  agent_browser_handoffs: PRIVATE,
  agent_authorization_requests: PRIVATE,
  agent_device_authorizations: PRIVATE,
  agent_audit_events: PRIVATE,
  agent_storefront_contexts: PRIVATE,
  agent_storefront_order_grants: PRIVATE,
  agent_storefront_continuations: PRIVATE,
  order_review_requests: PRIVATE,
  digital_assets: PRIVATE,
  digital_asset_uploads: PRIVATE,
  digital_entitlements: PRIVATE,
  digital_licence_keys: PRIVATE,
  gift_cards: PRIVATE,
  gift_card_transactions: PRIVATE,
  warranty_policy_revisions: "Frozen onto order lines at checkout; public reads show the live policy row (warranty_policies), which is registered.",
  order_item_warranties: PRIVATE,
  warranty_claims: PRIVATE,
};

export function isCacheDepTable(table: string): table is CacheDepTable {
  return Object.prototype.hasOwnProperty.call(CACHE_DEP_TABLES, table);
}

/**
 * Registered tables whose reads are covered by the rows a statement reads,
 * not by key kind: every public render declares some `set:` key (the
 * Platform section), so a kind check would count any settings read as
 * covered. Each `settings` source of a statement must pin `category` and
 * `key` (`=` or `IN` against literals or bound values), and the key of every
 * document it can match, `set:<category>:<key>`, must be declared; any other
 * settings read falls back to `t:settings`. `columns` are the key's parts in
 * order after the kind.
 */
export const CACHE_DEP_ROW_KEYED_TABLES: Readonly<Record<string, { readonly kind: CacheDepKind; readonly columns: readonly string[] }>> = {
  settings: { kind: "set", columns: ["category", "key"] },
};

/**
 * Whether one source's pinned values (column -> values, null when not
 * pinned) read only rows whose keys are declared.
 */
export function cacheDepPinnedRowsCovered(
  table: string,
  pinned: Readonly<Record<string, readonly string[] | null>>,
  declared: ReadonlySet<string>,
): boolean {
  const spec = CACHE_DEP_ROW_KEYED_TABLES[table];
  if (spec === undefined) return false;
  let keys = [spec.kind as string];
  for (const column of spec.columns) {
    const values = pinned[column];
    if (!values || values.length === 0) return false;
    keys = keys.flatMap((prefix) => values.map((value) => `${prefix}:${value}`));
  }
  return keys.every((key) => declared.has(key));
}

/** Key kinds that cover a read of this table, or null for an unregistered table. */
export function cacheDepKindsForTable(table: string): readonly CacheDepKind[] | null {
  return isCacheDepTable(table) ? CACHE_DEP_TABLES[table].kinds : null;
}

/** The exemption reason of a table, or null. */
export function cacheDepExemptReason(table: string): string | null {
  return Object.prototype.hasOwnProperty.call(CACHE_DEP_EXEMPT_TABLES, table)
    ? CACHE_DEP_EXEMPT_TABLES[table]!
    : null;
}
