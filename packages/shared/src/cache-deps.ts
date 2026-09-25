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
 *   transaction as the change;
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
  /** `lm:<scope>`: membership (and newest order) of a public product set; `lm:seo` the sitemap/feed flags. */
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
  /** `hero`: hero sliders. */
  "hero",
  /** `ship`: shipping methods and delivery zones. */
  "ship",
  /** `loc`: delivery locations. */
  "loc",
  /** `tax`: tax classes, rates and settings. */
  "tax",
  /** `lang`: checkout languages. */
  "lang",
  /** `promo:<promotionId>`, `promo:*`. */
  "promo",
  /** `an`: analytics snippets. */
  "an",
  /** `t:<table>`: coarse fallback, any buyer-visible change of the table. */
  "t",
  /** `store`: everything (dashboard "clear cache", catalogue-wide rebuilds). */
  "store",
] as const;

export type CacheDepKind = (typeof CACHE_DEP_KINDS)[number];

/** A listing scope: the whole public catalogue, a category subtree or a brand. */
export type CacheDepScope = "all" | `cat:${string}` | `brand:${string}`;

/** Ordering and filter facts of a listing member, each its own key per scope. */
export const CACHE_DEP_LIST_ORDER_FACETS = ["price", "band", "disc", "name"] as const;
export type CacheDepListOrderFacet = (typeof CACHE_DEP_LIST_ORDER_FACETS)[number];

/** Suffix of the "any row of this kind" key (`c:*`, `b:*`, ...). */
export const CACHE_DEP_ANY = "*";

/** An entry holding more keys than this collapses each kind to its coarse `t:` keys. */
export const CACHE_DEP_ENTRY_KEY_BUDGET = 256;

/** Soft-ordering staleness bound (owner decision 4), seconds. */
export const CACHE_DEP_SOFT_MAX_AGE_SECONDS = 600;

export const cacheDep = {
  product: (productId: string) => `p:${productId}`,
  listMembership: (scope: CacheDepScope) => `lm:${scope}`,
  /** Sitemap / product-feed / noindex flags of any product. */
  discoveryMembership: () => "lm:seo",
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
  hero: () => "hero",
  shipping: () => "ship",
  locations: () => "loc",
  tax: () => "tax",
  checkoutLanguages: () => "lang",
  promotion: (promotionId: string) => `promo:${promotionId}`,
  anyPromotion: () => `promo:${CACHE_DEP_ANY}`,
  analytics: () => "an",
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
  const constant = kind === "srch" || kind === "theme" || kind === "hero" || kind === "ship"
    || kind === "loc" || kind === "tax" || kind === "lang" || kind === "an" || kind === "store";
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
 * (both images when `bothImagesOnUpdate`, else the new one).
 */
function everyChange(keys: readonly CacheDepKeyTemplate[], bothImagesOnUpdate = false): CacheDepRule[] {
  const rules: CacheDepRule[] = [
    { name: "ins", event: "insert", image: "new", keys },
    { name: "del", event: "delete", image: "old", keys },
    { name: "upd", event: "update", image: "new", changed: "visible", keys },
  ];
  if (bothImagesOnUpdate) rules.push({ name: "upd_old", event: "update", image: "old", changed: "visible", keys });
  return rules;
}

const TIMESTAMPS = ["created_at", "updated_at"] as const;

const BUYER_MEMBERSHIP = ["is_public", "category_id", "brand_id", "product_created_at"] as const;
const PUBLIC_ROW = { equals: { is_public: 1 } } as const;

/**
 * Every buyer-visible table. Columns in `noise` are never buyer-visible; any
 * other column is (a new column is visible until someone lists it as noise).
 */
export const CACHE_DEP_TABLES = {
  // --- Catalogue: products and their parts ---------------------------------
  products: {
    kinds: ["p", "lo", "lm", "srch"],
    noise: ["aggregate_revision", "updated_at", "tax_classification_version"],
    note: "Membership, price and band come from product_buyer_state, refreshed in the same batch.",
    rules: [
      ...everyChange([p("id")]),
      { name: "srch", event: "update", image: "new", changed: ["name", "description"], keys: [{ dep: "srch" }] },
      { name: "srch_ins", event: "insert", image: "new", keys: [{ dep: "srch" }] },
      { name: "srch_del", event: "delete", image: "old", keys: [{ dep: "srch" }] },
      {
        name: "name_order", event: "update", image: "new", changed: ["name"],
        keys: [{ scopes: "lo:name", from: { product: "id" } }],
      },
      {
        name: "seo", event: "update", image: "new",
        changed: ["no_index", "exclude_from_sitemap", "exclude_from_product_feed"],
        keys: [{ dep: "lm:seo" }],
      },
    ],
  },
  product_buyer_state: {
    kinds: ["p", "lm", "lo"],
    noise: ["refreshed_at"],
    note: "Only public rows are in listings; a flip of is_public is a membership change of both images.",
    rules: [
      { name: "ins", event: "insert", image: "new", where: PUBLIC_ROW, keys: [p("product_id"), { scopes: "lm", from: { row: true } }] },
      { name: "del", event: "delete", image: "old", where: PUBLIC_ROW, keys: [p("product_id"), { scopes: "lm", from: { row: true } }] },
      {
        name: "member_old", event: "update", image: "old", changed: BUYER_MEMBERSHIP, where: PUBLIC_ROW,
        keys: [p("product_id"), { scopes: "lm", from: { row: true } }],
      },
      {
        name: "member_new", event: "update", image: "new", changed: BUYER_MEMBERSHIP, where: PUBLIC_ROW,
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
    rules: everyChange([{ scopes: "lf", from: { product: "product_id" } }], true),
  },
  product_variants: {
    kinds: ["p"],
    noise: ["stock", "reserved_stock", "stock_version", "version", "updated_at", "tax_classification_version"],
    note: "Raw stock is noise; a change of the SKU's availability band (the SQL twin of resolveBuyerAvailabilityBand with the store default threshold) is not.",
    rules: [
      ...everyChange([p("product_id")]),
      { name: "band", event: "update", image: "new", bandChanged: true, keys: [p("product_id")] },
    ],
  },
  product_media: { kinds: ["p"], noise: [...TIMESTAMPS], rules: everyChange([p("product_id")], true) },
  product_option_definitions: { kinds: ["p"], noise: [...TIMESTAMPS], rules: everyChange([p("product_id")], true) },
  product_option_values: {
    kinds: ["p"],
    noise: [...TIMESTAMPS],
    rules: everyChange([{
      prefix: "p:",
      lookup: { table: "product_option_definitions", select: "product_id", key: "id", column: "option_definition_id" },
    }]),
  },
  product_variant_option_values: {
    kinds: ["p"],
    noise: [],
    rules: everyChange([{
      prefix: "p:",
      lookup: { table: "product_variants", select: "product_id", key: "id", column: "variant_id" },
    }]),
  },
  product_attribute_values: { kinds: ["p"], noise: ["created_at"], rules: everyChange([p("product_id")], true) },
  product_rich_content: { kinds: ["p"], noise: [...TIMESTAMPS], rules: everyChange([p("product_id")], true) },
  product_content_blocks: { kinds: ["p"], noise: [...TIMESTAMPS], rules: everyChange([p("product_id")], true) },
  product_bundles: { kinds: ["p"], noise: [...TIMESTAMPS], rules: everyChange([p("product_id")], true) },

  // --- Catalogue structure ------------------------------------------------------
  categories: {
    kinds: ["c", "srch"],
    noise: ["revision", "updated_at"],
    rules: [
      ...everyChange(own("c")),
      { name: "srch", event: "update", image: "new", changed: ["name", "description"], keys: [{ dep: "srch" }] },
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
    ], true),
  },
  category_attribute_sets: {
    kinds: ["c"],
    noise: [],
    rules: everyChange([{ prefix: "c:", columns: ["category_id"] }], true),
  },
  brands: { kinds: ["b"], noise: ["revision", "updated_at"], rules: everyChange(own("b")) },
  collections: { kinds: ["col"], noise: ["version", "updated_at"], rules: everyChange(own("col")) },
  product_attributes: { kinds: ["attr"], noise: [...TIMESTAMPS], rules: everyChange(own("attr")) },
  attribute_values: {
    kinds: ["attr"],
    noise: [...TIMESTAMPS],
    rules: everyChange([{ prefix: "attr:", columns: ["attribute_id"] }, { dep: "attr:*" }], true),
  },
  attribute_groups: { kinds: ["attr"], noise: [...TIMESTAMPS], rules: everyChange([{ dep: "attr:*" }]) },
  media: {
    kinds: ["m"],
    noise: ["version", "updated_at", "folder_id"],
    rules: everyChange([{ prefix: "m:", columns: ["id"] }]),
  },

  // --- Content, layout and settings ---------------------------------------------
  pages: { kinds: ["pg"], noise: ["revision", "updated_at"], rules: everyChange(own("pg")) },
  hero_sliders: { kinds: ["hero"], noise: ["revision", "updated_at"], rules: everyChange([{ dep: "hero" }]) },
  settings: {
    kinds: ["set"],
    noise: ["revision", "updated_at"],
    rules: everyChange([{ prefix: "set:", columns: ["category", "key"] }], true),
  },
  theme_settings: { kinds: ["theme"], noise: ["revision", ...TIMESTAMPS], rules: everyChange([{ dep: "theme" }]) },
  navigation_menus: { kinds: ["nav"], noise: ["updated_at"], rules: everyChange(own("nav")) },
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
    rules: everyChange([{ prefix: "nav:", columns: ["menu_id"] }, { dep: "nav:*" }], true),
  },
  analytics: { kinds: ["an"], noise: ["revision", "updated_at"], rules: everyChange([{ dep: "an" }]) },
  checkout_languages: { kinds: ["lang"], noise: ["revision", "updated_at"], rules: everyChange([{ dep: "lang" }]) },

  // --- Shipping, locations, tax, promotions ---------------------------------------
  shipping_methods: { kinds: ["ship"], noise: ["updated_at"], rules: everyChange([{ dep: "ship" }]) },
  delivery_zones: { kinds: ["ship"], noise: ["revision", "updated_at"], rules: everyChange([{ dep: "ship" }]) },
  delivery_zone_locations: { kinds: ["ship"], noise: [], rules: everyChange([{ dep: "ship" }]) },
  delivery_locations: { kinds: ["loc"], noise: ["updated_at"], rules: everyChange([{ dep: "loc" }]) },
  tax_classes: { kinds: ["tax"], noise: ["version", "updated_at"], rules: everyChange([{ dep: "tax" }]) },
  tax_rates: { kinds: ["tax"], noise: ["version", "updated_at"], rules: everyChange([{ dep: "tax" }]) },
  tax_settings: { kinds: ["tax"], noise: ["version", "updated_at"], rules: everyChange([{ dep: "tax" }]) },
  promotions: { kinds: ["promo"], noise: ["revision", "updated_at"], rules: everyChange(own("promo")) },
  promotion_codes: {
    kinds: ["promo"],
    noise: [],
    rules: everyChange([{ prefix: "promo:", columns: ["promotion_id"] }, { dep: "promo:*" }], true),
  },
  promotion_conditions: {
    kinds: ["promo"],
    noise: [],
    rules: everyChange([{ prefix: "promo:", columns: ["promotion_id"] }, { dep: "promo:*" }], true),
  },
  promotion_effects: {
    kinds: ["promo"],
    noise: [],
    rules: everyChange([{ prefix: "promo:", columns: ["promotion_id"] }, { dep: "promo:*" }], true),
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
} as const satisfies Record<string, CacheDepTableSpec>;

export type CacheDepTable = keyof typeof CACHE_DEP_TABLES;

// ---------------------------------------------------------------------------
// Tables that never need a key
// ---------------------------------------------------------------------------

const PRIVATE = "Private or operational: never read by a public cached route.";
const SOFT = `Soft ordering only (owner decision 4): recommendation and popularity order may lag up to ${CACHE_DEP_SOFT_MAX_AGE_SECONDS / 60} minutes; every card shown is its own hard p: key. Readers bound it with a soft max age, not a trigger.`;
const DERIVED_STOCK = "Stock ledger: its buyer-visible effect is the SKU band on product_variants and product_buyer_state, which are registered.";
const DRAFTS = "Dashboard drafts, history or sessions: public reads use the published row, which is registered.";
const MACHINERY = "Cache machinery itself.";
const FTS = "FTS index maintained by triggers from products/categories name and description, which advance srch.";

/** Tables a public read may touch (or that exist) without a key of their own, with the reason. */
export const CACHE_DEP_EXEMPT_TABLES: Readonly<Record<string, string>> = {
  // Soft ordering.
  product_recommendations: SOFT,
  product_sales_stats: SOFT,
  orders: `${SOFT} (also-bought fallback reads orders).`,
  order_items: `${SOFT} (also-bought fallback reads order lines).`,
  // Derived or machinery.
  products_fts: FTS,
  categories_fts: FTS,
  cache_clock: MACHINERY,
  cache_dep: MACHINERY,
  cache_generation: MACHINERY,
  scalius_schema_migrations: "Schema ledger; a release changes the Worker version, which is in every cache key.",
  inventory_movements: DERIVED_STOCK,
  inventory_operations: DERIVED_STOCK,
  product_low_stock_alerts: DERIVED_STOCK,
  // Drafts and history.
  theme_settings_drafts: DRAFTS,
  theme_settings_versions: DRAFTS,
  theme_preview_sessions: DRAFTS,
  navigation_menu_items: DRAFTS,
  hero_sections: "Legacy hero configuration; public reads use hero_sliders.",
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
  payment_plans: PRIVATE,
  cod_tracking: PRIVATE,
  webhook_events: PRIVATE,
  order_fulfillments: PRIVATE,
  order_fulfillment_lines: PRIVATE,
  customers: PRIVATE,
  customer_history: PRIVATE,
  customer_auth_otp_challenges: PRIVATE,
  customer_sessions: PRIVATE,
  customer_auth_otp_rate_limits: PRIVATE,
  auth_otp_delivery_receipts: PRIVATE,
  conversations: PRIVATE,
  conversation_messages: PRIVATE,
  conversation_attachments: PRIVATE,
  meta_conversions_logs: PRIVATE,
  meta_capi_purchase_outbox: PRIVATE,
  notification_outbox: PRIVATE,
  notification_delivery_receipts: PRIVATE,
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
};

export function isCacheDepTable(table: string): table is CacheDepTable {
  return Object.prototype.hasOwnProperty.call(CACHE_DEP_TABLES, table);
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
