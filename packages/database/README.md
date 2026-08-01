# @scalius/database

Drizzle ORM schema, request-safe client composition, and SQLite migrations for
Cloudflare D1 and Turso. D1 is the zero-configuration default. Installing both
`TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` selects the stable fetch-only Turso
adapter; `DATABASE_PROVIDER=d1` is an explicit rollback override.

## Export Map

```json
{
  "./schema": "./src/schema/index.ts",
  "./client": "./src/client.ts",
  "./migration-control": "./src/migration-control.ts",
  "./migration-artifacts": "./src/migration-artifacts.ts",
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

// Control-plane migration building blocks
import { advanceDatabaseMigrationCheckpoint } from "@scalius/database/migration-control";
import { compileSqliteMigrationForProvider } from "@scalius/database/migration-artifacts";
import { createSqlitePortabilityManifest } from "@scalius/database/portability";

// Database type alias
import type { Database } from "@scalius/database/types";
```

## Client Factory

`getDb(env)` composes a fresh lightweight Drizzle client for the current request
or Worker event. It never stores the active binding or merchant in mutable
isolate-global state. D1 uses `drizzle-orm/d1`. Turso uses the official stable
`@tursodatabase/serverless` transport through Drizzle's stable remote SQLite
driver; dynamic batches execute as one atomic `BEGIN CONCURRENT` request and
retry only explicit MVCC busy/conflict failures.

Provider selection is fail-closed:

- no Turso secrets: require `env.DB` and use D1;
- both Turso secrets: use Turso;
- only one Turso secret: reject the deployment configuration;
- `DATABASE_PROVIDER=d1`: require/use D1 even while Turso secrets are retained
  for a controlled rollback;
- `DATABASE_PROVIDER=turso`: require/use both Turso secrets.

Migration/copy/cutover orchestration does not run in this package or on request
paths. It belongs to the external control plane and repo-owned migration tools.

The capability matrix is deliberately small. D1 supports FTS5, recursive CTEs,
and `WITHOUT ROWID`, but serializes writes inside one database. Turso supports
concurrent writers and does not currently support those three SQLite features.
Provider-aware core helpers supply bounded search/navigation alternatives, and
the migration compiler removes only the unsupported physical artifacts. Do not
spread provider checks through domain services.

## Schema Files

### `shared.ts` -- SQL Helpers

Exports `UNIX_NOW`, a Drizzle SQL template that evaluates to `(cast(strftime('%s','now') as int))`. Used as the `.default()` for all `createdAt` / `updatedAt` integer timestamp columns. Stores Unix epoch seconds (not ISO-8601 strings, not milliseconds).

### `enums.ts` -- Centralized Enums

All enums follow the pattern: `const` object with `as const`, plus a derived union type.

| Enum | Values | Used By |
|------|--------|---------|
| `OrderStatus` | `pending`, `processing`, `confirmed`, `shipped`, `delivered`, `completed`, `cancelled`, `refunded`, `returned`, `partially_refunded`, `incomplete` | `orders.status` |
| `PaymentMethod` | `stripe`, `sslcommerz`, `polar`, `cod` | `orders.paymentMethod`, `orderPayments.paymentMethod` |
| `PaymentStatus` | `unpaid`, `partial`, `paid`, `refunded`, `failed` | `orders.paymentStatus` |
| `FulfillmentStatus` | `pending`, `partial`, `complete` | `orders.fulfillmentStatus` |
| `InventoryPool` | `regular`, `preorder`, `backorder` | `orders.inventoryPool` |
| `ItemFulfillmentStatus` | `pending`, `picked`, `packed`, `shipped`, `delivered` | `orderItems.fulfillmentStatus` |
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
- `siteSettings.authVerificationMethod`: `["email", "both", "whatsapp_otp", "sms_otp"]` legacy summary only; advanced customer auth policy is stored in `settings.customer_auth/policy`, and phone collection remains mandatory.
- `siteSettings.checkoutMode`: `["guest_cod_only", "gateways_only", "all"]`; the checkout-flow fields share the positive monotonic `checkoutFlowRevision` CAS authority so concurrent admin saves cannot silently overwrite one another.
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
| `products` | Core product. `slug`, `categoryId` FK, `isActive`, `discountPercentage/Type/Amount`, `freeDelivery` |
| `productMedia` | Ordered product association to global `media`; immutable asset identity, unique dense order, and exactly one featured row for non-empty galleries |
| `productVariants` | SKU-level sellable identities with normalized merchant option assignments, optional exact `productMedia` image association, stock pools, CAS versions, discounts, and barcode identity |
| `categories` | Product categories. `slug`, `imageUrl`, `metaTitle`, `metaDescription` |
| `collections` | Homepage product groupings. `type` ("manual"/"dynamic"), `config` (JSON), `sortOrder` |
| `productAttributes` | Filterable attribute definitions. `name` (unique), `slug` (unique), `options` (JSON array) |
| `productAttributeValues` | Product-attribute assignments. Unique on `(productId, attributeId)` |
| `productRichContent` | Product detail sections (tabs). `title`, `content`, `sortOrder` |
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
| `discounts` | Discount codes, types, values, date range, usage limits, combination flags |
| `discountProducts` | Discount-product junction. `applicationType` ("get") |
| `discountCollections` | Discount-collection junction. `applicationType` ("get") |
| `discountUsage` | Discount usage tracking. `orderId` FK, `customerId` FK, amount discounted |
| `metaConversionsSettings` | Meta Pixel CAPI settings. `singletonKey` constraint, pixel/access token, enabled flag |
| `metaConversionsLogs` | CAPI event log. Event identity, status, request/response JSON |

### `content.ts` -- Content Domain

| Table | Purpose |
|-------|---------|
| `pages` | CMS pages. Slug, content, published flags/timestamps, featured image, SEO fields |
| `heroSections` | Legacy hero config. Type and JSON config |
| `heroSliders` | Revision-guarded desktop/mobile homepage hero documents with one current row per viewport |
| `pageTemplates` | Page template definitions. Type and JSON config |

### `system.ts` -- System Domain

| Table | Purpose |
|-------|---------|
| `settings` | Key-value settings store. `key` + `category` unique constraint, value, type, expiry |
| `siteSettings` | Singleton site config. Header/footer JSON, revision-guarded checkout-flow settings, SEO, WhatsApp OTP config |
| `analytics` | Analytics script configs. Type, raw script config, location, Partytown flag |
| `adminFcmTokens` | Firebase Cloud Messaging tokens. User FK, unique token, device metadata |
| `shippingMethods` | Shipping method options. Name, fee, sort order |
| `checkoutLanguages` | Checkout i18n. Unique code, language data JSON, field visibility JSON |

## JSON Column Shapes

These `text()` columns store serialized JSON. Shapes documented from core service consumption.

| Table.Column | Expected Shape |
|---|---|
| `collections.config` | `{ source: "manual" | "dynamic", categoryIds: string[], productIds: string[], featuredProductId?: string, showOnHomepage: boolean (default false), maxProducts: number (1-24, default 8), title?: string, subtitle?: string }` |
| `productAttributes.options` | `string[]` (declared via Drizzle `mode: "json"`) |
| `siteSettings.headerConfig` | `{ topBar: { text, isEnabled }, logo: { src, alt }, favicon: { src, alt }, contact: { phone, text, isEnabled }, social: SocialLink[] \| Record<string, string>, navigation?: NavItem[] }` |
| `siteSettings.footerConfig` | `{ logo: { src, alt }, favicon: { src, alt }, tagline, description, copyrightText, social: SocialLink[], menus: { id, title, items: { id, label, href }[] }[] }` |
| `siteSettings.socialLinks` | `string` (JSON, legacy -- header/footerConfig now contains social data) |
| `siteSettings.contactInfo` | `string` (JSON, legacy) |
| `heroSliders.images` | `{ id: string, url: credential-free HTTPS URL, title: string, link: safe internal/HTTPS destination or "" }[]` (maximum 12, unique IDs) |
| `heroSections.config` | `string` (JSON, provider-specific hero configuration) |
| `pageTemplates.config` | `string` (JSON, template-specific configuration) |
| `analytics.config` | `string` (raw HTML `<script>` content, may include Partytown attributes) |
| `deliveryLocations.externalIds` | `{ pathao?: string\|number, steadfast?: string\|number }` (provider name -> external numeric ID) |
| `deliveryLocations.metadata` | `Record<string, unknown>` (provider-specific location metadata) |
| `deliveryProviders.credentials` | Pathao: `{ baseUrl, clientId, clientSecret, username, password }`. Steadfast: `{ baseUrl, apiKey, secretKey }`. May be AES-GCM encrypted. |
| `deliveryProviders.config` | Pathao: `{ storeId, defaultDeliveryType, defaultItemType, defaultItemWeight }`. Steadfast: `{ defaultCodAmount }` |
| `deliveryShipments.metadata` | `Record<string, unknown>` (provider-specific response data) |
| `deliveryShipments.shipmentItems` | `string` (JSON array of item references) |
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
| `val_` | Attribute value | `productAttributeValues` |
| `attr_` | Attribute definition | `productAttributes` |
| `cust_` | Customer | `customers` |
| `hist_` | Customer history entry | `customerHistory` |
| `aor_` | Auth OTP delivery receipt | `authOtpDeliveryReceipts` |
| `disc_` | Discount | `discounts` |
| `dp_` | Discount-product link | `discountProducts` |
| `dc_` | Discount-collection link | `discountCollections` |
| `du_` | Discount usage | `discountUsage` |
| `item_` | Order item | `orderItems` |
| `page_` | CMS page | `pages` |
| `media_` | Media file | `media` |
| `folder_` | Media folder | `mediaFolders` |
| `analytics_` | Analytics script | `analytics` |
| `chk_` | Checkout token | (ephemeral, in order flow) |

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

Compile an immutable provider-specific migration bundle into an empty directory:

```bash
pnpm --filter @scalius/database compile:migrations \
  --provider turso --out /path/to/empty-output
```

The manifest records the canonical and compiled SHA-256 for every file plus one
bundle digest. D1 output is byte-identical to the canonical migration chain.

Compile a trusted D1 data-only SQL export for Turso:

```bash
pnpm --filter @scalius/database compile:data-export \
  --provider turso --input /path/to/d1-export.sql --out /path/to/turso-import.sql
```

Turso data imports run in one foreign-key-disabled transaction because Wrangler's
data-only export is table-name ordered rather than dependency ordered. The control
plane must run `PRAGMA foreign_key_check` and the deterministic portability verifier
before cutover; disabling checks without that verification is invalid.

The portability manifest walks every application table in primary-key keyset
chunks and records logical schema, row, chunk, and whole-database digests. It
ignores vendor internals and derived FTS objects, and refuses an application table
without a primary key. The durable orchestration state machine is resumable and
requires evidence references at every non-skippable transition.

Drizzle config (`drizzle.config.ts`):
- Schema: `./src/schema/index.ts`
- Output: `./migrations`
- Dialect: `sqlite`

## Dependencies

| Package | Purpose |
|---------|---------|
| `@tursodatabase/serverless` ^1.4.0 | Fetch-only Turso transport and concurrent atomic batches |
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
