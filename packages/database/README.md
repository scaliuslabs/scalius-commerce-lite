# @scalius/database

Drizzle ORM schema, request-safe client composition, and deterministic migration tools for Cloudflare D1, TursoDB, and
PostgreSQL/Neon. D1 is the zero-configuration default. External providers are
selected by complete credentials or an explicit `DATABASE_PROVIDER`; ambiguous
or incomplete configurations fail closed.

## Export Map

```json
{
  "./schema": "./src/schema/index.ts",
  "./client": "./src/client.ts",
  "./postgres-adapter": "./src/postgres-adapter.ts",
  "./migration-artifacts": "./src/migration-artifacts.ts",
  "./schema-contract": "./src/schema-contract.ts",
  "./portability": "./src/portability.ts",
  "./types":  "./src/types.ts"
}
```

```typescript
// Schema tables and types
import { products, orders, customers } from "@scalius/database/schema";
import type { Product, Order, Customer } from "@scalius/database/schema";

// Database client
import { getDb, schema } from "@scalius/database/client";
import type { Database } from "@scalius/database/client";

// Operator-facing migration building blocks
import { compileSqliteMigrationForProvider } from "@scalius/database/migration-artifacts";
import { readDatabaseSchemaState } from "@scalius/database/schema-contract";
import { createSqlitePortabilityManifest } from "@scalius/database/portability";

// Database type alias
import type { Database } from "@scalius/database/types";
```

## Client Factory

`getDb(env)` composes a fresh lightweight client for the current request or
Worker event. It never stores the active binding or merchant in mutable
isolate-global state. D1 uses `drizzle-orm/d1`; Turso uses the fetch-only
`@tursodatabase/serverless` transport. A Neon `*.neon.tech` URL uses Neon's
one-shot HTTP transport; other PostgreSQL URLs and Cloudflare Hyperdrive use
the native `pg` transport through the same compatibility adapter. A `turso://`
endpoint selects concurrent atomic batches, while legacy `libsql://`/HTTPS
endpoints keep immediate transactions. Native operations own and close their
client; Hyperdrive provides the regional production pool.

Provider selection is fail-closed:

- no external provider secrets: require `env.DB` and use D1;
- both Turso secrets: use Turso;
- only one Turso secret: reject the deployment configuration;
- `POSTGRES_DATABASE_URL`: use Neon or generic PostgreSQL when Turso
  credentials are absent;
- `HYPERDRIVE`: use its connection string and native PostgreSQL transport;
  when present it takes precedence over `POSTGRES_DATABASE_URL`;
- Turso and PostgreSQL credentials together: require an explicit provider;
- `DATABASE_PROVIDER=d1`: require/use D1 even while Turso secrets are retained
  for a controlled rollback;
- `DATABASE_PROVIDER=turso`: require/use both Turso secrets;
- `DATABASE_PROVIDER=postgres`: require/use either `HYPERDRIVE` or
  `POSTGRES_DATABASE_URL`.

Migration/copy/cutover orchestration does not run in this package or on request
paths. It belongs to deployment operations and repo-owned migration tools.
The deployed API Worker exposes the separate `DATABASE_MIGRATION_FREEZE`
operations-only secret so a live copy can stop HTTP writes, queue consumption, and
scheduled mutations while still exposing API health/readiness. Follow
`audit/OPERATIONAL_RUNBOOK.md`; never copy a live D1 database without binding one
canonical export to the frozen source's unchanged D1 Time Travel bookmark and
verifying the native target fingerprint before switching provider secrets.

The capability matrix is deliberately small. D1 supports FTS5, recursive CTEs,
and `WITHOUT ROWID`, but serializes writes inside one database. TursoDB supports
concurrent writers and omits those three SQLite features. PostgreSQL supports
concurrent writers and recursive CTEs but not SQLite physical artifacts.
Provider-aware core helpers supply bounded alternatives and the adapters keep
dialect translation at the boundary. Do not spread provider checks through
domain services.

## Schema Files

### `shared.ts` -- SQL Helpers

Exports `UNIX_NOW`, a Drizzle SQL template that evaluates to `(cast(strftime('%s','now') as int))`. Used as the `.default()` for all `createdAt` / `updatedAt` integer timestamp columns. Stores Unix epoch seconds (not ISO-8601 strings, not milliseconds).

### `enums.ts` -- Centralized Enums

All enums follow the pattern: `const` object with `as const`, plus a derived union type.

| Enum | Values | Used By |
|------|--------|---------|
| `OrderStatus` | `pending`, `processing`, `confirmed`, `shipped`, `delivered`, `completed`, `cancelled`, `refunded`, `returned`, `partially_refunded`, `incomplete` | `orders.status` |
| `PaymentMethod` | `stripe`, `sslcommerz`, `cod` | `orders.paymentMethod`, `orderPayments.paymentMethod` |
| `PaymentStatus` | `unpaid`, `partial`, `paid`, `refunded`, `failed` | `orders.paymentStatus` |
| `FulfillmentStatus` | `pending`, `partial`, `complete` | `orders.fulfillmentStatus` |
| `InventoryPool` | `regular`, `preorder`, `backorder` | `orders.inventoryPool` |
| `DeliveryProvider` | `pathao`, `steadfast` | Referenced by delivery logic |
| `DiscountType` | `amount_off_products`, `amount_off_order`, `free_shipping` | `discounts.type` |
| `DiscountValueType` | `percentage`, `fixed_amount`, `free` | `discounts.valueType` |

Some tables use inline enum arrays instead of the centralized enums:
- `products.discountType`: `["percentage", "flat"]`
- `productVariants.barcodeType`: `["ean13", "upc", "isbn", "gtin", "custom"]`
- `collections.presentation`: `["grid", "carousel"]`; membership is canonical `config.source` (`manual` or `dynamic`)
- `heroSliders.type`: `["desktop", "mobile"]`
- `deliveryLocations.type`: `["city", "zone", "area"]`
- `customerHistory.changeType`: `["created", "updated", "deleted"]`
- `metaConversionsLogs.status`: `["success", "failed"]`

## Table Inventory

This inventory is grouped by schema file and intentionally omits column counts;
the schema declarations are the source of truth.

### `auth.ts` -- Better Auth

| Table | Purpose |
|-------|---------|
| `user` | Admin users. `role`, `isSuperAdmin`, `banned`, `twoFactorEnabled`, `twoFactorMethod` |
| `session` | Auth sessions. `token` (unique), `expiresAt`, `twoFactorVerified`, `impersonatedBy` |
| `account` | OAuth/credential accounts. `providerId`, `accessToken`, `refreshToken`, `password` |
| `verification` | Email/phone verification tokens. `identifier`, `value`, `expiresAt` |
| `twoFactor` | TOTP secrets, backup codes, and verification state. `secret`, `backupCodes` (JSON string), `verified` |
| `adminSetupClaims` | Singleton D1 first-admin setup authority. Holds active/completed setup claim state so only one bootstrap can win |
| `adminSetupRateLimits` | D1 setup throttle rows keyed by hashed client identifier. Enforces setup attempts without KV read-modify-write races |
| `scannerTokenClaims` | Single-use scanner QR token claims keyed by token hash. Exchange atomically sets `consumedAt`/`consumedSessionHash` before any scanner KV session is issued |

### `rbac.ts` -- Role-Based Access Control

| Table | Purpose |
|-------|---------|
| `permissions` | Permission definitions. `name` (unique), `resource`, `action`, `category`, `isSensitive` |
| `roles` | Role definitions. `name` (unique), `isSystem` flag |
| `rolePermissions` | Many-to-many: role <-> permission. Unique on `(roleId, permissionId)` |
| `userRoles` | Many-to-many: user <-> role. `assignedBy` FK. Unique on `(userId, roleId)` |
| `userPermissions` | Direct user-level permission overrides. `granted` boolean. Unique on `(userId, permissionId)` |

### `products.ts` -- Product Domain

| Table | Purpose |
|-------|---------|
| `products` | Core product. `slug`, `categoryId` FK, `brandId` FK, `isActive`, `discountPercentage/Type/Amount`, `freeDelivery`, `pageTemplate` (theme product configuration, NULL = default), `emiEligible` |
| `productMedia` | Ordered product association to global `media`; immutable asset identity, unique dense order, and exactly one featured row for non-empty galleries |
| `productVariants` | SKU-level sellable identities with normalized merchant option assignments, optional exact `productMedia` image association, stock pools, CAS versions, discounts, and barcode identity |
| `categories` | Product categories. `slug`, `imageUrl`, `metaTitle`, `metaDescription`, `listingTemplate`. Tree (0088): write only `parentId`; triggers keep `depth` (0-3, four levels), the id `path` (`/root/child/`) and `category_closure` exact and refuse cycles, trashed parents and a fifth level |
| `collections` | Homepage product groupings. `type` ("manual"/"dynamic"), `config` (JSON), `sortOrder`, `listingTemplate` |
| `brands` | Brand entity (0088): unique `slug`, optional `logoMediaId` (restrict), SEO fields, `status` draft/published, `listingTemplate`, `revision` |
| `productAttributes` | Attribute definitions. `name` (unique), `slug` (unique), `options` (legacy JSON array), typed spec fields (0088): `groupId`, `valueType` (text/number/boolean/enum), `unit`, `sortOrder`, `keySpec`, `highlight`, `facetDisplay` (range only for numbers, swatch only for enums) |
| `attributeGroups` | Spec-table groups, unique live name |
| `attributeValues` | Normalised values of an attribute (`normalizedValue` = lower(trim(value)), unique per live attribute), optional `swatchHex` |
| `productAttributeValues` | Product-attribute assignments. Unique on `(productId, attributeId)`. `value` is the display text; enums also set `valueId`, numbers and booleans `valueNumber` (triggers refuse a value that does not match the type) |
| `productRichContent` | Legacy product tabs. `title`, `content`, `sortOrder`. 0088 mirrors every write into `productContentBlocks`; dropped once its readers move |
| `mediaFolders` | Flat, versioned media folders with case-insensitive active-name uniqueness |
| `media` | Versioned image/video metadata keyed by immutable R2 `objectKey`; poster, readiness, and trash/delete lifecycle |
| `mediaUploadSessions` | Durable multipart intent and completion/expiry recovery state |
| `mediaUploadParts` | Exact-size uploaded-part evidence and first-part signature verification |

Public storefront listing indexes are intentionally measured and narrow:
`products_public_newest_idx` supports the default `/products` newest path,
`products_public_category_newest_idx` supports default category newest reads and
related-product category scans, and `product_attribute_values_attr_value_product_idx`
is a covering lookup for resolved attribute filters. The common single-attribute
storefront filter path intentionally avoids the grouped intersection query so the
covering attribute index can satisfy the lookup directly. Do not remove or reshape
these indexes without local and remote D1 `EXPLAIN QUERY PLAN` evidence.

### `customers.ts` -- Customer Domain

| Table | Purpose |
|-------|---------|
| `customers` | Customer records. `phone` (unique), order totals, last order timestamp, address IDs/names |
| `customerHistory` | Change audit log. `changeType` ("created"/"updated"/"deleted") |
| `customerSessions` | Storefront customer sessions keyed by HMAC token hash. Active reads join `customers` and reject revoked/expired/deleted-customer sessions |
| `authOtpDeliveryReceipts` | Customer OTP delivery receipt fence. One row per OTP attempt/channel, with recipient hash/mask, provider refs, claim lease, retry status, and OTP expiry |

### `orders.ts` -- Order Domain

| Table | Purpose |
|-------|---------|
| `orders` | Core order. Status, payment, fulfillment, inventory, optimistic locking, customer linkage |
| `orderItems` | Line items. Product/variant IDs, quantity, price, fulfillment status |
| `orderPayments` | Payment records. Gateway IDs, COD collection fields, metadata JSON, partial unique indexes for gateway idempotency |
| `paymentPlans` | Partial payment tracking. `orderId` (unique), deposit/balance fields, status |
| `codTracking` | COD lifecycle tracking. `orderId` (unique), attempts, COD status, failure reason |
| `webhookEvents` | Webhook audit log. Provider, event type, status |
| `abandonedCheckouts` | Saved checkout state. `checkoutId` (unique), `checkoutData` JSON |

### `inventory.ts` -- Inventory Domain

| Table | Purpose |
|-------|---------|
| `inventoryMovements` | Stock movement audit log. Ledger-v2 rows carry pool/generation, CAS version edges, and before/after/delta values for physical, reserved, and preorder counters; legacy rows remain version-1 history |
| `productLowStockAlerts` | Low stock alert tracking. `variantId` (unique), alert status |

### `delivery.ts` -- Delivery Domain

| Table | Purpose |
|-------|---------|
| `deliveryLocations` | City/zone/area hierarchy with provider external IDs and metadata |
| `deliveryProviders` | Pathao/Steadfast provider config. Credentials may be AES-GCM encrypted |
| `deliveryShipments` | Shipment records. Provider IDs, tracking, status, metadata, shipment items, final-shipment flag |

### `marketing.ts` -- Marketing Domain

| Table | Purpose |
|-------|---------|
| `metaConversionsLogs` | CAPI event log. Event identity, status, request/response JSON |

### `catalog.ts` -- Catalogue projections and content (0088)

| Table | Purpose |
|-------|---------|
| `categoryClosure` | Every (ancestor, descendant, depth) pair of the category tree, self rows included. Trigger-maintained |
| `categoryAttributeSets` | The specs a category uses, in order (a category inherits its ancestors' sets) |
| `productFacetValues` | Facet projection: product-level attribute rows and SKU-level option-axis rows, keyed `(ownerId, facetKey)`. Rewritten with the product aggregate's writes; counts join it to `productBuyerState` |
| `productBuyerState` | One row per product: public flag, category, brand, card SKU, integer price range, availability band. Written in the same batch as every write that changes it; a rebuild recomputes it |
| `productRecommendations` | Precomputed recommendations, positions 0-23 per product, with a reason |
| `productSalesStats` | Units sold in the last 30 days, refreshed on a schedule |
| `productContentBlocks` | Typed, versioned content blocks per product and placement; settings follow `@scalius/shared/product-content-blocks` |
| `productBundles` | Quantity tiers (percentage or fixed set price); every change bumps the checkout authority |

### Wave B: `reviews.ts`, `digital.ts`, `gift-cards.ts`, `warranty.ts` (0095-0098)

| Table | Purpose |
|-------|---------|
| `productReviews` | One verified-purchase review per order line; one live review per product and buyer. A BEFORE INSERT trigger refuses any line not handed over on a delivered/completed order |
| `productReviewStats` | Per-product count, sum, histogram, `floor(avg*100)` and Bayesian rank `floor((sum+15)*1000/(count+5))`: a trigger projection of published reviews; never written by code |
| `orderReviewRequests` | One row per order that reached `delivered`, written by a trigger on `orders.status`; the 15-minute sweep queues the request |
| `digitalAssets` / `digitalAssetUploads` | Downloadable files (private R2 under `private/digital/`) and licence-key pools per product/variant; multipart upload sessions |
| `digitalEntitlements` | What a line received; the download count never passes the snapshot limit (CHECK) |
| `digitalLicenceKeys` | Encrypted keys with an HMAC `key_hash` (dedupe per pool); only `available -> assigned|revoked`, never deleted |
| `giftCards` / `giftCardTransactions` | HMAC `code_hash` lookup plus ciphertext (keys from `CREDENTIAL_ENCRYPTION_KEY`); the balance starts at 0 and is a trigger projection of the append-only ledger, which refuses overdrafts and redemption of disabled or expired cards |
| `warrantyPolicies` / `warrantyPolicyRevisions` | Reusable policies with immutable revisions; `products.warranty_policy_id` points at the policy and `order_items.warranty_revision_id` freezes the revision at commit |
| `orderItemWarranties` | One per fulfilment line of a line with a revision (trigger); starts at the handover, expires by SQLite calendar arithmetic (mirrored by the PostgreSQL `unixepoch(epoch, 'unixepoch', '+N unit')` compat function), voided with its fulfilment |
| `warrantyClaims` | A claim record plus its `warranty_claim` thread; at most one open claim per warranty |

`order_items_auto_pending_idx` (partial, digital and gift-card lines still owed) drives the auto-fulfil sweep.

### `content.ts` -- Content Domain

| Table | Purpose |
|-------|---------|
| `pages` | CMS pages. Slug, content, published flags/timestamps, featured image, SEO fields |
| `heroSections` | Legacy hero config. Type and JSON config |
| `heroSliders` | Revision-guarded desktop/mobile homepage hero documents with one current row per viewport |

### `system.ts` -- System Domain

| Table | Purpose |
|-------|---------|
| `settings` | Typed settings documents (one row per document: `category` = document key, `key = 'document'`, JSON value, CAS `revision`) plus fraud-checker provider rows and notification provider-health markers. `key` + `category` unique. Shapes live in `@scalius/core/modules/settings/documents` |
| `analytics` | Analytics script configs. Type, raw script config, location, Partytown flag |
| `adminFcmTokens` | Firebase Cloud Messaging tokens. User FK, unique token, device metadata |
| `shippingMethods` | Delivery rates (in `delivery.ts`). Zone (null = Everywhere else), kind (delivery/pickup), name, fee, free-over threshold, soft delete |
| `deliveryZones` / `deliveryZoneLocations` | Delivery zones and their places; a place belongs to at most one zone |
| `checkoutLanguages` | Checkout i18n. Unique code, language data JSON, field visibility JSON |
| `cacheClock` / `cacheDep` | Dependency-validated cache (0093): the commit-ordered clock and each dependency key's last change. Written only by triggers generated from `@scalius/shared/cache-deps` (see "Cache dependency triggers") |

### Cache dependency triggers (0093)

`packages/shared/src/cache-deps.ts` is the one registry of buyer-visible
tables: the key kinds each one advances, its noise columns (revisions,
timestamps, raw stock) and one rule per trigger. `scripts/cache-dep-triggers.ts`
generates the SQLite triggers (guard in `WHEN`, one `INSERT ... ON CONFLICT`
body, no `CASE`) and their PostgreSQL form (deferred constraint triggers that
lock the clock row at commit, so seq order is commit order without a new
deadlock); `scripts/postgres-schema.ts` uses the same PostgreSQL form for fresh
schemas. After changing the registry:

```bash
pnpm --filter @scalius/database exec tsx scripts/cache-dep-triggers.ts --write
```

A released migration is immutable, so a registry change after 0093 ships goes
into a new migration (drop and recreate the affected triggers); the freshness
test (`__tests__/cache-dep-triggers.test.ts`) keeps the generator and the
checked-in files equal. Every table in the schema must be registered or listed
in `CACHE_DEP_EXEMPT_TABLES` with a reason. A catalogue-wide rebuild batch sets
`cache_clock.coarse = 1` so every trigger in it advances `store` once instead
of each product's keys (on PostgreSQL the deferred triggers fire after the
flag is reset, so they advance the exact keys).

## JSON Column Shapes

These `text()` columns store serialized JSON. Shapes documented from core service consumption.

| Table.Column | Expected Shape |
|---|---|
| `collections.config` | `{ source: "manual" | "dynamic", categoryIds: string[], productIds: string[], featuredProductId?: string, showOnHomepage: boolean (default false), maxProducts: number (1-24, default 8), title?: string, subtitle?: string }` |
| `productAttributes.options` | `string[]` (declared via Drizzle `mode: "json"`) |
| `heroSliders.images` | `{ id: string, url: credential-free HTTPS URL, title: string, link: safe internal/HTTPS destination or "" }[]` (maximum 12, unique IDs) |
| `heroSections.config` | `string` (JSON, provider-specific hero configuration) |
| `productContentBlocks.settings` | Strict per-type object (`@scalius/shared/product-content-blocks`), at most 256 KB |
| `analytics.config` | `string` (raw HTML `<script>` content, may include Partytown attributes) |
| `deliveryLocations.externalIds` | `{ pathao?: string\|number, steadfast?: string\|number }` (provider name -> external numeric ID) |
| `deliveryLocations.metadata` | `Record<string, unknown>` (provider-specific location metadata) |
| `deliveryProviders.credentials` | Pathao: `{ baseUrl, clientId, clientSecret, username, password }`. Steadfast: `{ baseUrl, apiKey, secretKey }`. May be AES-GCM encrypted. |
| `deliveryProviders.config` | Pathao: `{ storeId, defaultDeliveryType, defaultItemType, defaultItemWeight }`. Steadfast: `{ defaultCodAmount }` |
| `deliveryShipments.metadata` | `Record<string, unknown>` (provider-specific response data) |
| `orderPayments.metadata` | `Record<string, unknown>` (currency, card type, etc.) |
| `abandonedCheckouts.checkoutData` | `string` (JSON, full checkout form state) |
| `checkoutLanguages.languageData` | `{ pageTitle, cartSectionTitle, placeOrderText, continueShoppingText, subtotalText, shippingText, ... }` (i18n strings) |
| `checkoutLanguages.fieldVisibility` | `{ name: boolean, email: boolean, phone: boolean, address: boolean, ... }` (field toggle map) |
| `twoFactor.backupCodes` | `string` (JSON-serialized backup code array) |
| `metaConversionsLogs.requestPayload` | `string` (JSON, Meta CAPI request body) |
| `metaConversionsLogs.responsePayload` | `string` (JSON, Meta CAPI response body, nullable) |
| `adminFcmTokens.deviceInfo` | `string` (JSON, device metadata, nullable) |
| `authOtpDeliveryReceipts.rawResponse` | `string` (bounded provider response summary, nullable; must not contain OTP code or provider secrets) |

## Entity ID Prefixes

All entity IDs are `text` primary keys generated as `"prefix_" + nanoid()`.

| Prefix | Entity | Table |
|--------|--------|-------|
| `prod_` | Product | `products` |
| `pmed_` | Product media association | `productMedia` |
| `var_` | Product variant | `productVariants` |
| `cat_` | Category | `categories` |
| `prc_` | Rich content section | `productRichContent` |
| `brd_` | Brand | `brands` |
| `atg_` | Attribute group | `attributeGroups` |
| `atv_` | Normalised attribute value | `attributeValues` |
| `pcb_` | Product content block | `productContentBlocks` |
| `pbd_` | Product quantity bundle | `productBundles` |
| `val_` | Attribute value | `productAttributeValues` |
| `attr_` | Attribute definition | `productAttributes` |
| `cust_` | Customer | `customers` |
| `hist_` | Customer history entry | `customerHistory` |
| `aor_` | Auth OTP delivery receipt | `authOtpDeliveryReceipts` |
| `item_` | Order item | `orderItems` |
| `page_` | CMS page | `pages` |
| `media_` | Media file | `media` |
| `folder_` | Media folder | `mediaFolders` |
| `analytics_` | Analytics script | `analytics` |
| `chk_` | Checkout token | (ephemeral, in order flow) |
| `rev_` | Product review | `productReviews` |
| `dga_` | Digital asset | `digitalAssets` |
| `gc_` | Gift card | `giftCards` |
| `gct_` | Gift-card transaction | `giftCardTransactions` |
| `wrp_` / `wrr_` | Warranty policy / revision | `warrantyPolicies` / `warrantyPolicyRevisions` |
| `wty_` | Line warranty (`wty_` + fulfilment line id) | `orderItemWarranties` |
| `wcl_` | Warranty claim | `warrantyClaims` |

Some tables use plain `nanoid()` without a prefix: `collections`, `deliveryShipments`, `deliveryProviders`.

New order and order-item IDs use `generateOrderId()` from
`@scalius/shared/order-utils`: 16-character Crockford-base32 identities with 80
bits of randomness. Existing six-character order IDs remain valid.

Auth tables (`user`, `session`, `account`, `verification`, `twoFactor`) use Better Auth's built-in ID generation.

## Timestamp Pattern

All timestamp columns use `integer("column_name", { mode: "timestamp" })` with `.default(UNIX_NOW)`.

- **Storage**: Unix epoch seconds as an integer in SQLite
- **Drizzle mode**: `"timestamp"` tells Drizzle to automatically convert between JS `Date` objects and epoch seconds
- **`UNIX_NOW`**: `sql\`(cast(strftime('%s','now') as int))\`` -- evaluates at INSERT time via SQLite

Soft-delete columns (`deletedAt`) follow the same pattern but are nullable with no default.

## Migrations

Migration SQL lives in `packages/database/migrations/`. The current chain starts
from one clean baseline. New schema changes come from Drizzle Kit
(`pnpm db:generate`); intentional manual SQL must also pass the migration
metadata check.

```bash
# Generate a new migration after schema changes
pnpm db:generate

# Apply locally
pnpm db:migrate:local
# Equivalent to: wrangler d1 migrations apply DB --local

# Apply to production
# wrangler d1 migrations apply DB --remote
```

The baseline includes raw SQL that Drizzle cannot express: FTS5 virtual tables
and synchronization triggers, Bengali-aware tokenizers, partial unique indexes
for payment/refund/SKU invariants, and atomic discount-usage guard triggers. Keep
that final baseline section intact when regenerating or reviewing migrations.

Validate migration metadata after schema or migration edits:

```bash
pnpm --filter @scalius/database check:migrations
```

Migration `0050_schema_release_contract` starts the provider-neutral release
ledger. Every migration from 0050 onward must:

- keep its canonical SQLite/D1/Turso SQL in `migrations/`;
- have a transaction-safe PostgreSQL sidecar with the same filename in
  `migrations/postgres/`;
- end both files with the same exact version, name, and non-self-referential
  source SHA-256 ledger row; and
- be listed in the runtime release manifest used by `/readyz`.

The current release is the one `CURRENT_DATABASE_SCHEMA` names in
`src/schema-contract.ts` (`0100_cache_dependencies` at this writing). The release chain also
demonstrates that the runner and its tests must handle contiguous releases
rather than assuming the ledger contains only its bootstrap row. Release 0055
is a forward-only PostgreSQL convergence migration: schema-54
upgrades created 32-bit cache-generation counters while fresh PostgreSQL imports
correctly used 64-bit counters, so the sidecar widens existing targets and the
SQLite migration records the same release without changing SQLite's
integer-affinity schema. Release 0056 adds the shared Agent Access authority,
release 0057 adds encrypted, short-lived, single-use browser handoffs for MCP
continuations, release 0058 adds immutable selected-delivery-method facts to
orders, release 0059 separates checkout delivery phone from account identity,
release 0060 performs the credential-only Better Auth 1.7 issuer backfill
while rejecting unknown or malformed legacy account identities, release 0061
adds idempotent order amendment records, and release 0062 adds the
`admin_identity_handoff_events` audit and single-use ledger for operator
identity handoff.

Do not delete or squash historical migrations after a release. Existing D1
installations depend on Wrangler's migration history, while existing Turso and
PostgreSQL installations depend on the provider-neutral ledger.

D1 remains upgraded by Wrangler. Existing external databases use the explicit
schema runner; an ordinary Worker deploy performs only a read-only current-
schema preflight and never mutates the external authority:

```bash
# Read-only preflight used before a Turso/PostgreSQL deploy
POSTGRES_DATABASE_URL='<target-url>' \
pnpm --filter @scalius/database upgrade:schema \
  --provider postgres \
  --acknowledge-target-host '<expected-target-host>' \
  --dry-run --require-current

# Explicit mutation after the deployment operator has activated and verified its
# write freeze. Turso uses TURSO_DATABASE_URL and TURSO_AUTH_TOKEN instead.
POSTGRES_DATABASE_URL='<target-url>' \
pnpm --filter @scalius/database upgrade:schema \
  --provider postgres \
  --acknowledge-target-host '<expected-target-host>' \
  --freeze-proof-sha256 '<verified-freeze-proof>'
```

The Turso runner proves the semantic 0049 baseline, fences a schema race under
`BEGIN IMMEDIATE`, and applies each release atomically. The PostgreSQL runner
reuses the initial import's control receipt and advisory-lock identity, applies
each sidecar in one serializable transaction, and treats a lost successful
response as an idempotent replay. API readiness reads the entire ledger and
fails closed for missing, extra, renamed, future, or digest-mismatched rows.

Compile an immutable provider-specific migration bundle into an empty directory:

```bash
pnpm --filter @scalius/database compile:migrations \
  --provider turso --out /path/to/empty-output
```

The manifest records the canonical and compiled SHA-256 for every file plus one
bundle digest. D1 output is byte-identical to the canonical migration chain.

Frozen D1 and TursoDB sources converge on one canonical SQLite artifact. D1
exports are fenced by an unchanged Time Travel bookmark. Legacy SQLite-backed
Turso databases can still be fenced and checkpointed through Turso Sync. The
current TursoDB engine uses the platform snapshot exported under the control
plane's write freeze:

```bash
turso db export '<database>' --output-file /path/to/frozen.db
TURSO_DATABASE_URL='turso://<expected-host>' \
pnpm --filter @scalius/database export:turso-portable \
  --snapshot /path/to/frozen.db \
  --snapshot-revision '<persisted-freeze-proof-or-provider-revision>' \
  --out /path/to/portable-bundle \
  --ack-source-host '<expected-host>'
```

The command copies the snapshot and its `-wal`/`-log` sidecar, checkpoints it
through the embedded Turso engine, converts it to ordinary SQLite, rebuilds the
canonical schema, and records whether evidence came from Sync or a platform
export. An empty PostgreSQL/Neon target is then populated with the resumable
migrator:

```bash
POSTGRES_DATABASE_URL='<target-url>' \
pnpm --filter @scalius/database migrate:sqlite-to-postgres \
  --sqlite /path/to/canonical.sqlite \
  --checkpoint /path/to/create-only-checkpoint.json \
  --ack-target-host '<expected-target-host>'
```

The migrator holds an advisory lock, streams per-table `COPY`, persists target
receipts in a private control schema, reconciles interrupted local state from
the target, and requires exact source/target row and content fingerprints before
completion. Provisioning, freeze/cutover, secret installation, deployed smokes,
rollback retention, and resource deletion remain deployment-operations work.

Normalize a trusted full D1 SQL export onto the current portable schema, then
compile the normalized data-only artifact for Turso:

```bash
pnpm --filter @scalius/database normalize:d1-export \
  --input /path/to/d1-full-export.sql --out /path/to/normalized-data.sql
pnpm --filter @scalius/database compile:data-export \
  --provider turso --input /path/to/normalized-data.sql --out /path/to/turso-import.sql
```

The normalizer streams the full export into a private temporary SQLite file,
projects every current table onto the canonical Turso columns, rejects missing
tables/columns or row-count drift, and requires clean foreign-key and integrity
checks before writing a mode-0600 data artifact. This safely removes retired source
columns without parsing or holding a multi-gigabyte SQL dump in JavaScript memory;
its JSON evidence lists every discarded source column and ignored retired source
table with its row count. It requires the `sqlite3` binary (override with
`SQLITE3_BIN`). The compiler also streams the normalized artifact into a mode-0600
output while calculating both SHA-256 digests, so a near-limit D1 export is never
held in JavaScript memory. Turso data imports
then run in one foreign-key-disabled transaction because Wrangler's data export is
not dependency ordered. The compiler derives the final Turso trigger set from the
canonical migrations, drops those triggers inside the import transaction, and
clears migration-seeded rows from all current application tables before loading the
snapshot. It restores the triggers before commit so dependency-sensitive guards
cannot reject a valid snapshot merely because its parent rows appear later in the
dump.
The migration operator must run `PRAGMA foreign_key_check` and the deterministic
portability verifier before cutover; disabling checks without that verification is
invalid. Export only the current canonical application-table set: retired source
tables remain in the retained source database and are not part of the portable
runtime fingerprint.

The portability manifest walks every application table in primary-key keyset
chunks (250 rows by default) and records logical schema, row, chunk, and
whole-database digests. It
ignores vendor internals and derived FTS objects, and refuses an application table
without a primary key. The durable orchestration state machine is resumable and
requires evidence references at every non-skippable transition. The verifier
reconstructs the normalized source in a private disk-backed SQLite file through
the same streaming loader, so fingerprint verification also avoids retaining a
multi-gigabyte export in JavaScript memory.

Drizzle config (`drizzle.config.ts`):
- Schema: `./src/schema/index.ts`
- Output: `./migrations`
- Dialect: `sqlite`

## Applying migrations without Wrangler (automation contract)

Automated deployments may apply the canonical D1 chain through the Cloudflare
D1 HTTP API instead of `wrangler d1 migrations apply`. The contract is the
machine-readable plan emitted by `src/migration-plan.ts` (exported as
`@scalius/database/migration-plan`, pure and dependency-free):

```bash
pnpm --filter @scalius/database migration-plan              # JSON on stdout
pnpm --filter @scalius/database migration-plan --out plan.json
```

The command reads only `migrations/*.sql` (never `migrations/postgres/` or
`migrations/meta/`), requires the numeric prefixes to be contiguous from
`0000`, and fails when the last file is not `CURRENT_DATABASE_SCHEMA`.

```jsonc
{
  "contract": "scalius-d1-migration-plan/v1",
  "ledgerTable": "d1_migrations",
  "ledgerDdl": "CREATE TABLE IF NOT EXISTS \"d1_migrations\"( ... );",
  "ledgerListSql": "SELECT * FROM \"d1_migrations\" ORDER BY id",
  "releaseLedgerTable": "scalius_schema_migrations",
  "expectedSchema": { "version": 62, "name": "0062_identity_handoff_audit" },
  "migrations": [
    {
      "version": 62,
      "name": "0062_identity_handoff_audit",
      "file": "0062_identity_handoff_audit.sql",
      "fileSha256": "<sha256 of the raw file>",
      "statements": ["CREATE TABLE ...", "..."],
      "ledgerInsert": "INSERT INTO \"d1_migrations\" (name)\nvalues ('0062_identity_handoff_audit.sql');",
      "releaseLedger": {
        "version": 62,
        "name": "0062_identity_handoff_audit",
        "sourceSha256": "<sha256 of the statements without the final insert>"
      }
    }
  ]
}
```

Two ledgers exist and they have different owners:

- `d1_migrations` is Wrangler's ledger. `ledgerDdl`, `ledgerListSql`, and every
  `ledgerInsert` are byte-identical to what Wrangler 4.x runs, so an external
  applier writes exactly the rows Wrangler would have written. The `name`
  column holds the file name including `.sql`.
- `scalius_schema_migrations` is the provider-neutral release ledger. It is not
  written by the applier: every migration from 0050 onward ends with its own
  `INSERT INTO scalius_schema_migrations ...` statement, and the plan reports
  that row as `releaseLedger` (`null` before 0050). `/readyz` reads this table
  and expects exactly `CURRENT_DATABASE_SCHEMA_MIGRATIONS`.

Execution rules for an external applier:

1. Execute `ledgerDdl` (idempotent) before anything else.
2. Read applied names with `ledgerListSql` and pass them, in `id` order, to
   `listPendingD1Migrations(plan, appliedNames)`. The applied names must be an
   exact ordered prefix of `plan.migrations[].file`; an unknown name or a gap
   means a foreign or diverged database and the deployment must stop.
3. For each pending migration in plan order: execute `statements` in order,
   then execute `ledgerInsert`. Prefer one D1 batch per file so the file's
   statements and its ledger row commit together. Each entry of `statements`
   is one complete statement that may contain inner semicolons (trigger
   bodies); never re-split on `;`. Legacy files (0007 through 0045) include
   `PRAGMA foreign_keys=OFF` / `ON` around Drizzle table rebuilds; execute
   them as ordinary statements in place, exactly as Wrangler does.
4. Never reorder, skip, or partially apply a file, and never edit statement
   text. The plan is derived from the same bytes Wrangler would execute.
5. After the run, `SELECT name FROM d1_migrations ORDER BY id` equals
   `plan.migrations[].file`, and `SELECT version, name, source_sha256 FROM
   scalius_schema_migrations ORDER BY version` equals
   `CURRENT_DATABASE_SCHEMA_MIGRATIONS`.

Because the ledger rows match Wrangler's own, a later
`pnpm db:migrate:remote` (`wrangler d1 migrations apply`) lists every file as
applied and reports nothing to apply. `__tests__/migration-plan.test.ts` pins
the DDL and insert shape against the installed Wrangler bundle and replays the
whole plan into SQLite, so a Wrangler ledger change or a broken chain fails CI.

## Dependencies

| Package | Purpose |
|---------|---------|
| `@neondatabase/serverless` 1.1.0 | Fetch-only PostgreSQL/Neon transport |
| `pg` 8.22.0 | Native generic PostgreSQL and Cloudflare Hyperdrive transport |
| `@tursodatabase/database` ^0.7.2 | Local TursoDB migration artifact handling |
| `@tursodatabase/serverless` ^1.4.0 | Fetch-only Turso transport and concurrent atomic batches |
| `@tursodatabase/sync` 0.7.2 | Revision-fenced TursoDB source snapshots |
| `drizzle-orm` ^0.45.2 | ORM, schema definitions, query builder |
| `drizzle-kit` (dev) ^0.31.10 | Migration generation |
| `@cloudflare/workers-types` (dev) | `D1Database` type |

## Known Gaps

- No FTS5 virtual tables in the Drizzle schema -- FTS5 tables and sync triggers are raw SQL in the baseline and queried via helpers in `@scalius/core/search/fts5.ts`.
- Partial unique indexes are documented beside the table definitions but remain raw-SQL migration concerns; for example `product_variants_one_default_per_product_idx` enforces at most one active hidden default SKU per product.
- Several JSON columns (`headerConfig`, `footerConfig`, etc.) are typed as plain `text()` -- there are no Drizzle JSON mode annotations or Zod validators at the schema level. Validation happens in the service layer.
# Product variant image associations

`product_variants.image_id` is the sole variant-image authority: one optional,
same-product `product_media.id` image association per exact SKU. `NULL` means
the SKU uses the product's shared image representation, so only combinations
that genuinely need distinct media require a reference. Association deletion
uses `ON DELETE SET NULL` and safely returns affected SKUs to that fallback.

Migration `0007_bored_vulcan.sql` removed the former product-level image-axis
switches and `product_variant_image_mappings` table during the normalized option
cutover. Migration `0018_magenta_scream.sql` repointed exact SKU images to
`product_media`; `0020_chemical_captain_britain.sql` removes the final copied-URL
table. Do not restore label/axis inheritance, SEO-marker serialization,
positional matching, or a parallel product image table. Bulk assignment is an
editor convenience that writes the same exact association ID to selected SKUs.
