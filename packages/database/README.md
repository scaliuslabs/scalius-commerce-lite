# @scalius/database

Drizzle ORM schema, client factory, and migrations for Cloudflare D1 (SQLite). This package defines the entire data model -- 40 tables across 11 schema files -- and provides a singleton `getDb()` factory for Drizzle-over-D1.

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
- `siteSettings.authVerificationMethod`: `["email", "phone", "both", "whatsapp_otp", "sms_otp"]`
- `siteSettings.checkoutMode`: `["guest_cod_only", "gateways_only", "all"]`
- `widgets.displayTarget`: `["homepage"]`
- `metaConversionsLogs.status`: `["success", "failed"]`

## Table Inventory

### `auth.ts` -- Better Auth (5 tables)

| Table | Columns | Purpose |
|-------|---------|---------|
| `user` | 13 | Admin users. `role`, `isSuperAdmin`, `banned`, `twoFactorEnabled`, `twoFactorMethod` |
| `session` | 9 | Auth sessions. `token` (unique), `expiresAt`, `twoFactorVerified`, `impersonatedBy` |
| `account` | 12 | OAuth/credential accounts. `providerId`, `accessToken`, `refreshToken`, `password` |
| `verification` | 5 | Email/phone verification tokens. `identifier`, `value`, `expiresAt` |
| `twoFactor` | 5 | TOTP secrets and backup codes. `secret`, `backupCodes` (JSON string) |

### `rbac.ts` -- Role-Based Access Control (5 tables)

| Table | Columns | Purpose |
|-------|---------|---------|
| `permissions` | 9 | Permission definitions. `name` (unique), `resource`, `action`, `category`, `isSensitive` |
| `roles` | 6 | Role definitions. `name` (unique), `isSystem` flag |
| `rolePermissions` | 4 | Many-to-many: role <-> permission. Unique on `(roleId, permissionId)` |
| `userRoles` | 5 | Many-to-many: user <-> role. `assignedBy` FK. Unique on `(userId, roleId)` |
| `userPermissions` | 6 | Direct user-level permission overrides. `granted` boolean. Unique on `(userId, permissionId)` |

### `products.ts` -- Product Domain (9 tables)

| Table | Columns | Purpose |
|-------|---------|---------|
| `products` | 14 | Core product. `slug`, `categoryId` FK, `isActive`, `discountPercentage/Type/Amount`, `freeDelivery` |
| `productImages` | 7 | Product gallery. `productId` FK (cascade), `isPrimary`, `sortOrder` |
| `productVariants` | 22 | SKU-level variants. `size`, `color`, `stock`, `reservedStock`, `preorderStock`, `version`, `stockVersion`, `barcode`, `barcodeType` |
| `categories` | 9 | Product categories. `slug`, `imageUrl`, `metaTitle`, `metaDescription` |
| `collections` | 8 | Homepage product groupings. `type` ("manual"/"dynamic"), `config` (JSON), `sortOrder` |
| `productAttributes` | 7 | Filterable attribute definitions. `name` (unique), `slug` (unique), `options` (JSON array) |
| `productAttributeValues` | 5 | Product-attribute assignments. Unique on `(productId, attributeId)` |
| `productRichContent` | 7 | Product detail sections (tabs). `title`, `content`, `sortOrder` |
| `media` | 8 | Uploaded media files. `filename`, `url`, `size`, `mimeType`, `folderId` FK |
| `mediaFolders` | 5 | Media folder hierarchy. Self-referential `parentId` FK |

### `customers.ts` -- Customer Domain (2 tables)

| Table | Columns | Purpose |
|-------|---------|---------|
| `customers` | 14 | Customer records. `phone` (unique), `totalOrders`, `totalSpent`, `lastOrderAt`. Address: `city/zone/area` + `cityName/zoneName/areaName` |
| `customerHistory` | 12 | Change audit log. `changeType` ("created"/"updated"/"deleted") |

### `orders.ts` -- Order Domain (7 tables)

| Table | Columns | Purpose |
|-------|---------|---------|
| `orders` | 25 | Core order. `status`, `paymentMethod`, `paymentStatus`, `paidAmount`, `balanceDue`, `fulfillmentStatus`, `inventoryPool`, `inventoryAction`, `version` (optimistic locking), `customerId` FK |
| `orderItems` | 9 | Line items. `productId` FK, `variantId` FK, `quantity`, `price`, `fulfillmentStatus` |
| `orderPayments` | 16 | Payment records. Gateway-specific columns: `stripePaymentIntentId/ChargeId`, `sslcommerzTranId/ValId/BankTranId`, `polarCheckoutId`, `codCollectedBy/At/ReceiptUrl`. `metadata` (JSON) |
| `paymentPlans` | 10 | Partial payment tracking. `orderId` (unique), `depositAmount`, `balanceDue`, `status` |
| `codTracking` | 11 | COD lifecycle tracking. `orderId` (unique), `deliveryAttempts`, `codStatus`, `failureReason` |
| `webhookEvents` | 7 | Webhook audit log. `provider`, `eventType`, `status` |
| `abandonedCheckouts` | 5 | Saved checkout state. `checkoutId` (unique), `checkoutData` (JSON) |

### `inventory.ts` -- Inventory Domain (2 tables)

| Table | Columns | Purpose |
|-------|---------|---------|
| `inventoryMovements` | 9 | Stock movement audit log. `type` (reserved/deducted/released/adjusted/preorder_reserved/preorder_deducted), `quantity` (+/-), `previousStock`, `newStock` |
| `productLowStockAlerts` | 10 | Low stock alert tracking. `variantId` (unique), `alertStatus` (active/acknowledged/resolved) |

### `delivery.ts` -- Delivery Domain (3 tables)

| Table | Columns | Purpose |
|-------|---------|---------|
| `deliveryLocations` | 10 | City/zone/area hierarchy. `type` ("city"/"zone"/"area"), self-referential `parentId` FK, `externalIds` (JSON), `metadata` (JSON) |
| `deliveryProviders` | 8 | Provider config (Pathao/Steadfast). `credentials` (JSON, AES-GCM encrypted), `config` (JSON) |
| `deliveryShipments` | 15 | Shipment records. `externalId`, `trackingId`, `trackingUrl`, `status`, `rawStatus`, `metadata` (JSON), `shipmentItems` (JSON), `isFinalShipment` |

### `marketing.ts` -- Marketing Domain (6 tables)

| Table | Columns | Purpose |
|-------|---------|---------|
| `discounts` | 18 | Discount codes. `code`, `type`, `valueType`, `discountValue`, `minPurchaseAmount`, date range, `limitOnePerCustomer`, `combineWith*` flags |
| `discountProducts` | 5 | Discount-product junction. `applicationType` ("get") |
| `discountCollections` | 5 | Discount-collection junction. `applicationType` ("get") |
| `discountUsage` | 6 | Discount usage tracking. `orderId` FK, `customerId` FK, `amountDiscounted` |
| `metaConversionsSettings` | 8 | Meta Pixel CAPI settings. `singletonKey` constraint, `pixelId`, `accessToken`, `isEnabled` |
| `metaConversionsLogs` | 8 | CAPI event log. `eventId` (unique), `eventName`, `status`, `requestPayload` (JSON), `responsePayload` (JSON) |

### `content.ts` -- Content Domain (6 tables)

| Table | Columns | Purpose |
|-------|---------|---------|
| `pages` | 13 | CMS pages. `slug`, `content`, `isPublished`, `hideHeader/Footer/Title`, `sortOrder` |
| `widgets` | 12 | AI-generated widgets. `htmlContent`, `cssContent`, `aiContext`, `placementRule`, `referenceCollectionId` FK, `sortOrder` |
| `widgetHistory` | 5 | Widget version history. `widgetId` FK (cascade), `htmlContent`, `cssContent`, `reason` |
| `heroSections` | 7 | Legacy hero config. `type`, `config` (JSON) |
| `heroSliders` | 7 | Homepage sliders. `type` ("desktop"/"mobile"), `images` (JSON array) |
| `pageTemplates` | 7 | Page template definitions. `type`, `config` (JSON) |

### `system.ts` -- System Domain (6 tables)

| Table | Columns | Purpose |
|-------|---------|---------|
| `settings` | 7 | Key-value settings store. `key` + `category` unique constraint, `value`, `type`, `expiresAt` |
| `siteSettings` | 21 | Singleton site config. `singletonKey`, `headerConfig` (JSON), `footerConfig` (JSON), `socialLinks` (JSON), `contactInfo` (JSON), checkout settings, WhatsApp OTP config |
| `analytics` | 8 | Analytics script configs. `type`, `config` (JSON script content), `location`, `usePartytown` |
| `adminFcmTokens` | 8 | Firebase Cloud Messaging tokens. `userId` FK, `token` (unique), `deviceInfo` (JSON) |
| `shippingMethods` | 8 | Shipping method options. `name` (unique), `fee`, `sortOrder` |
| `checkoutLanguages` | 9 | Checkout i18n. `code` (unique), `languageData` (JSON), `fieldVisibility` (JSON) |

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

28 migrations in `packages/database/migrations/` (0000-0027). Generated by Drizzle Kit (`pnpm db:generate`), applied via Wrangler:

```bash
# Generate a new migration after schema changes
pnpm db:generate

# Apply locally
pnpm db:migrate:local
# Equivalent to: wrangler d1 migrations apply DB --local

# Apply to production
# wrangler d1 migrations apply DB --remote
```

Drizzle config (`drizzle.config.ts`):
- Schema: `./src/schema/index.ts`
- Output: `./migrations`
- Dialect: `sqlite`

## Dependencies

| Package | Purpose |
|---------|---------|
| `drizzle-orm` | ORM, schema definitions, query builder |
| `drizzle-kit` (dev) | Migration generation |
| `@cloudflare/workers-types` (dev) | `D1Database` type |

## Known Gaps

- No FTS5 virtual tables in the Drizzle schema -- FTS5 tables are created via raw SQL in migration `0016_fts5_search.sql` and queried via helpers in `@scalius/core/search/fts5.ts`.
- `siteSettings` and `metaConversionsSettings` have `singletonKey` columns with unique constraints (enforced in migration 0024) but no Drizzle-level unique constraint on `singletonKey` in the schema definition.
- Several JSON columns (`headerConfig`, `footerConfig`, etc.) are typed as plain `text()` -- there are no Drizzle JSON mode annotations or Zod validators at the schema level. Validation happens in the service layer.
