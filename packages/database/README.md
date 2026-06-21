# @scalius/database

Drizzle ORM schema, client factory, and migrations for Cloudflare D1 (SQLite). This package defines the checked data model in `src/schema/**` and provides a singleton `getDb()` factory for Drizzle-over-D1.

## Export Map

```json
{
  "./schema": "./src/schema/index.ts",
  "./client": "./src/client.ts",
  "./types":  "./src/types.ts"
}
```

```typescript
// Schema tables and types
import { products, orders, customers } from "@scalius/database/schema";
import type { Product, Order, Customer } from "@scalius/database/schema";

// Database client
import { getDb, db, schema } from "@scalius/database/client";
import type { Database } from "@scalius/database/client";

// Database type alias
import type { Database } from "@scalius/database/types";
```

## Client Factory

`src/client.ts` provides two access patterns:

1. **`getDb(env)`** -- Initializes a Drizzle instance from `env.DB` (D1 binding). Module-level singleton: first call creates the instance, subsequent calls return the cached one. D1 bindings are stable handles -- no per-connection TLS handshake cost.

2. **`db`** (legacy proxy) -- A `Proxy` object that delegates to the module-level singleton. Existing code using `import { db } from "@scalius/database/client"` works without modification, provided `getDb(env)` was called first (by Astro middleware or the Hono per-request initializer).

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
| `WidgetPlacementRule` | `before_collection`, `after_collection`, `fixed_top_homepage`, `fixed_bottom_homepage`, `standalone` | `widgets.placementRule` |

Some tables use inline enum arrays instead of the centralized enums:
- `products.discountType`: `["percentage", "flat"]`
- `productVariants.barcodeType`: `["ean13", "upc", "isbn", "gtin", "custom"]`
- `collections.type`: `["manual", "dynamic"]`
- `heroSliders.type`: `["desktop", "mobile"]`
- `deliveryLocations.type`: `["city", "zone", "area"]`
- `customerHistory.changeType`: `["created", "updated", "deleted"]`
- `siteSettings.authVerificationMethod`: `["email", "both", "whatsapp_otp", "sms_otp"]` legacy summary only; advanced customer auth policy is stored in `settings.customer_auth/policy`, and phone collection remains mandatory.
- `siteSettings.checkoutMode`: `["guest_cod_only", "gateways_only", "all"]`
- `widgets.displayTarget`: `["homepage"]`
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
| `productImages` | Product gallery. `productId` FK (cascade), `isPrimary`, `sortOrder` |
| `productVariants` | SKU-level variants. `size`, `color`, `stock`, `reservedStock`, `preorderStock`, `version`, `stockVersion`, `barcode`, `barcodeType` |
| `categories` | Product categories. `slug`, `imageUrl`, `metaTitle`, `metaDescription` |
| `collections` | Homepage product groupings. `type` ("manual"/"dynamic"), `config` (JSON), `sortOrder` |
| `productAttributes` | Filterable attribute definitions. `name` (unique), `slug` (unique), `options` (JSON array) |
| `productAttributeValues` | Product-attribute assignments. Unique on `(productId, attributeId)` |
| `productRichContent` | Product detail sections (tabs). `title`, `content`, `sortOrder` |
| `mediaFolders` | Media folder hierarchy. Self-referential `parentId` FK |
| `media` | Uploaded media files. `filename`, `url`, `size`, `mimeType`, `folderId` FK, media metadata |

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
| `inventoryMovements` | Stock movement audit log. Movement type, quantity delta, previous/new stock |
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
| `widgets` | AI-generated widgets. HTML/CSS/JS content, AI context, placement defaults |
| `widgetPlacements` | Scoped widget placement records for homepage/page/product/category/collection slots |
| `widgetHistory` | Widget version history. Widget FK, HTML/CSS/JS content, reason |
| `heroSections` | Legacy hero config. Type and JSON config |
| `heroSliders` | Homepage sliders. Desktop/mobile type and image array |
| `pageTemplates` | Page template definitions. Type and JSON config |

### `system.ts` -- System Domain

| Table | Purpose |
|-------|---------|
| `settings` | Key-value settings store. `key` + `category` unique constraint, value, type, expiry |
| `siteSettings` | Singleton site config. Header/footer JSON, checkout settings, SEO, WhatsApp OTP config |
| `analytics` | Analytics script configs. Type, raw script config, location, Partytown flag |
| `adminFcmTokens` | Firebase Cloud Messaging tokens. User FK, unique token, device metadata |
| `shippingMethods` | Shipping method options. Name, fee, sort order |
| `checkoutLanguages` | Checkout i18n. Unique code, language data JSON, field visibility JSON |

## JSON Column Shapes

These `text()` columns store serialized JSON. Shapes documented from core service consumption.

| Table.Column | Expected Shape |
|---|---|
| `collections.config` | `{ categoryIds: string[], productIds: string[], featuredProductId?: string, maxProducts: number (1-24, default 8), title?: string, subtitle?: string }` |
| `productAttributes.options` | `string[]` (declared via Drizzle `mode: "json"`) |
| `siteSettings.headerConfig` | `{ topBar: { text, isEnabled }, logo: { src, alt }, favicon: { src, alt }, contact: { phone, text, isEnabled }, social: SocialLink[] \| Record<string, string>, navigation?: NavItem[] }` |
| `siteSettings.footerConfig` | `{ logo: { src, alt }, favicon: { src, alt }, tagline, description, copyrightText, social: SocialLink[], menus: { id, title, items: { id, label, href }[] }[] }` |
| `siteSettings.socialLinks` | `string` (JSON, legacy -- header/footerConfig now contains social data) |
| `siteSettings.contactInfo` | `string` (JSON, legacy) |
| `heroSliders.images` | `{ url: string, alt?: string }[]` |
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
| `img_` | Product image | `productImages` |
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
| `wid_` | Widget | `widgets` |
| `whist_` | Widget history entry | `widgetHistory` |
| `media_` | Media file | `media` |
| `folder_` | Media folder | `mediaFolders` |
| `analytics_` | Analytics script | `analytics` |
| `chk_` | Checkout token | (ephemeral, in order flow) |

Some tables use plain `nanoid()` without a prefix: `collections`, `deliveryShipments`, `deliveryProviders`.

Order IDs use `generateOrderId()` from `@scalius/shared/order-utils` -- 6-character alphanumeric (e.g., `A39K02`), not nanoid.

Auth tables (`user`, `session`, `account`, `verification`, `twoFactor`) use Better Auth's built-in ID generation.

## Timestamp Pattern

All timestamp columns use `integer("column_name", { mode: "timestamp" })` with `.default(UNIX_NOW)`.

- **Storage**: Unix epoch seconds as an integer in SQLite
- **Drizzle mode**: `"timestamp"` tells Drizzle to automatically convert between JS `Date` objects and epoch seconds
- **`UNIX_NOW`**: `sql\`(cast(strftime('%s','now') as int))\`` -- evaluates at INSERT time via SQLite

Soft-delete columns (`deletedAt`) follow the same pattern but are nullable with no default.

## Migrations

Migration SQL lives in `packages/database/migrations/`. Generated migrations
come from Drizzle Kit (`pnpm db:generate`); intentional manual migrations must
also be reflected in the migration metadata check.

```bash
# Generate a new migration after schema changes
pnpm db:generate

# Apply locally
pnpm db:migrate:local
# Equivalent to: wrangler d1 migrations apply DB --local

# Apply to production
# wrangler d1 migrations apply DB --remote
```

Notable migrations:
- `0016_fts5_search.sql` -- FTS5 virtual tables (raw SQL, not Drizzle-managed)
- `0019-0023` -- FK indexes, order version, variant barcode, stock version
- `0024` -- Singleton constraints on `siteSettings`/`metaConversionsSettings`, collections enum fix
- `0025` -- Query performance indexes
- `0026` -- Phone number E.164 normalization
- `0028` -- Additional schema changes
- `0029` -- Large index additions (with `IF NOT EXISTS` guards)
- `0030` -- Payment idempotency: unique partial indexes on `orderPayments` for `stripePaymentIntentId`, `sslcommerzTranId`, `polarCheckoutId` per order (with dedup cleanup)
- `0031` -- Bengali FTS5 tokenizer: reconfigures 5 FTS tables with `unicode61` tokenizer for Bengali script support
- `0032` -- Additional schema changes
- `0033` -- Media metadata: `altText`, `width`, `height`
- `0034` -- Page featured image JSON
- `0035` -- Scoped `widgetPlacements` table and migration from legacy widget placement fields
- `0036` -- Atomic discount redemption triggers for max uses and one-per-customer
- `0037` -- Scoped widget JavaScript content on widgets and widget history
- `0038` -- Order shipment claim fields for provider/manual fulfillment coordination
- `0039` -- SSLCommerz `val_id` payment idempotency and payment plan status normalization
- `0040` -- Better Auth `twoFactor.verified` column
- `0041` -- Dashboard customer activity index on `(deleted_at, created_at)`
- `0042` -- Admin order search relevance: rebuilds `orders_fts` with `customer_email` and adds the default list index on `(deleted_at, updated_at)`
- `0043` -- Durable `order_notification_outbox` table for idempotent order-notification queue handoff and replay
- `0044` -- Durable `order_notification_delivery_receipts` table for per-channel order notification receipts and retry dedupe
- `0045` -- Durable `auth_otp_delivery_receipts` table for customer OTP provider delivery receipts and retry dedupe
- `0048` -- Durable `payment_session_attempts` table for hosted-payment session idempotency
- `0049` -- Durable `checkout_attempts` table for synchronous storefront checkout idempotency
- `0050` -- Immutable `discount_customer_redemptions` claims for one-per-customer discount enforcement
- `0051` -- D1-backed `customer_auth_otp_challenges` for atomic customer OTP attempt accounting and one-time consumption
- `0054` -- D1-backed `customer_sessions` keyed by HMAC token hash for revocable storefront customer sessions
- `0055` -- SKU-first inventory model: hidden/default simple-product SKUs, `track_inventory`, and untracked historical variantless order items
- `0057` -- Legacy/demo simple-SKU repair for active products with zero active SKUs or one zero-stock no-option SKU

Validate migration metadata after schema or migration edits:

```bash
pnpm --filter @scalius/database check:migrations
```

Drizzle config (`drizzle.config.ts`):
- Schema: `./src/schema/index.ts`
- Output: `./migrations`
- Dialect: `sqlite`

## Dependencies

| Package | Purpose |
|---------|---------|
| `drizzle-orm` ^0.45.2 | ORM, schema definitions, query builder |
| `drizzle-kit` (dev) ^0.31.10 | Migration generation |
| `@cloudflare/workers-types` (dev) | `D1Database` type |

## Known Gaps

- No FTS5 virtual tables in the Drizzle schema -- FTS5 tables are created via raw SQL in migration `0016_fts5_search.sql` and queried via helpers in `@scalius/core/search/fts5.ts`.
- Partial unique indexes are documented beside the table definitions but remain raw-SQL migration concerns; for example `product_variants_one_default_per_product_idx` enforces at most one active hidden default SKU per product.
- Several JSON columns (`headerConfig`, `footerConfig`, etc.) are typed as plain `text()` -- there are no Drizzle JSON mode annotations or Zod validators at the schema level. Validation happens in the service layer.
