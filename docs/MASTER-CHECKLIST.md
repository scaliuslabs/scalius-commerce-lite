# Master Checklist — Scalius Commerce

Last updated: 2026-03-18
Source: 47 README files written by 14 documentation agents reading every line of code.

---

## Phase 1: Critical Bug Fixes (Broken Functionality)

These are things that are implemented but broken, or create data integrity issues.

### P0 — Data Integrity / Security

- [ ] **FCM push notifications never called** — `sendOrderNotification()` is fully built but the queue consumer only calls `sendOrderNotificationEmail()`. Need to add FCM push call in queue consumer alongside email. (`packages/core/src/modules/notifications/`)
- [ ] **Admin order create doesn't deduct inventory** — Sets `inventoryAction: "deducted"` but never actually deducts stock. Orders created from admin dashboard don't reduce inventory. (`packages/core/src/modules/orders/orders.admin.ts`)
- [ ] **Password length mismatch** — Better Auth enforces 12 chars minimum, but API validation schema accepts 8. Customers could set passwords via API that Better Auth then rejects. (`packages/core/src/auth/auth.ts` vs API route schemas)
- [ ] **QR code TOTP secret leak** — 2FA QR codes generated via external `api.qrserver.com`, sending TOTP secrets over the wire to a third party. Must generate QR codes locally. (`apps/admin/src/components/admin/account-settings/`)
- [ ] **Shipping method update inverted uniqueness check** — Update handler checks if same ID exists (always true) instead of checking if a DIFFERENT record has the same name. (`apps/api/src/routes/admin/settings/shipping.ts`)
- [ ] **`restoreOrder()` doesn't re-reserve inventory** — Restoring a cancelled order marks it active but doesn't re-reserve the stock, leading to overselling. (`packages/core/src/modules/orders/orders.admin.ts`)

### P1 — Broken UI / Missing Endpoints

- [ ] **Widget trash view always empty** — `listWidgets()` service always filters `deletedAt IS NULL`. The admin widget list API has no `trashed` parameter support. Trash page shows nothing. (`packages/core/src/modules/widgets/widgets.service.ts`)
- [ ] **2 missing discount API endpoints** — UI calls `POST /admin/discounts/{id}/toggle-status` and `POST /discounts/usage` but neither exists. Status toggle silently fails; usage recording happens via queue instead. (`apps/api/src/routes/admin/discounts.ts`)
- [ ] **CollectionSelector search URL bug** — After initial load (correct `/api/v1/admin/collections`), search queries go to `/api/collections?search=...` (missing `/v1/admin` prefix). (`apps/admin/src/components/admin/discount/CollectionSelector.tsx`)
- [ ] **`page.widgets` dead code** — Storefront `Page` type has `widgets?: ApiWidget[]` and `[slug].astro` renders it, but API never returns widgets for pages. Dead rendering path. (`apps/storefront/src/pages/[slug].astro`)
- [ ] **Discount duplicate feature broken** — List row navigates to `?duplicate=true` but edit page never reads that parameter. (`apps/admin/src/components/admin/discount/`)
- [ ] **`ORDER_STATUSES` UI missing 3 states** — Admin order status dropdown is missing `returned`, `partially_refunded`, and `incomplete` from the 11 possible states. (`apps/admin/src/components/admin/order-list/`)
- [ ] **Product list flat discount display missing** — Only shows percentage discounts; flat amount discounts are invisible across admin list + storefront `hasDiscount` filter. (`packages/core/src/modules/products/`)
- [ ] **`getProductDetails` returns soft-deleted variants** — No filter on `deletedAt` when querying variants. Edit form shows deleted variants. (`packages/core/src/modules/products/products.admin.ts`)

### P2 — Inconsistencies / Code Quality

- [ ] **Multiple routes use raw `db` import instead of `c.get("db")`** — Public pages, widgets, hero, meta-conversions, fraud-checker routes import `db` directly from `@scalius/database/client` instead of middleware-injected instance. (`apps/api/src/routes/pages.ts`, `widgets.ts`, `hero.ts`, etc.)
- [ ] **Dead marketing module** — `packages/core/src/modules/marketing/discounts.service.ts` duplicates discount list query but is never imported. `marketing/index.ts` re-exports from `../discounts`. Should be deleted.
- [ ] **Duplicate validation schemas** — Customer validation exists in both `customers.service.ts` and `customers.validation.ts`. (`packages/core/src/modules/customers/`)
- [ ] **`generateDiscountCode()` duplicated 3 times** — Identical function in AmountOffOrderForm, FreeShippingForm, and DiscountDetailsSection. Should be one shared utility.
- [ ] **Duplicated SocialLinksSection** — Same component exists in both header-builder and footer-builder. Should be shared.
- [ ] **`integrations.ts` duplicates email/Firebase routes from `system.ts`** — Two API route files serve the same settings. (`apps/api/src/routes/admin/settings/`)
- [ ] **`new Date()` vs `sql'unixepoch()'` inconsistency** — Some mutations use JS Date objects, others use SQL unixepoch(). Causes timestamp format inconsistency in D1. (`packages/core/src/modules/collections/`, `orders/`)
- [ ] **Admin invite fallback logs temp password to console** — Security concern in production. (`packages/core/src/auth/`)
- [ ] **No session revocation on role/permission changes** — Stale permissions for up to 5 min (KV cache TTL). (`packages/core/src/auth/rbac/`)
- [ ] **Soft delete doesn't write history record** — Customer soft-delete doesn't create a `"deleted"` history entry despite enum supporting it. (`packages/core/src/modules/customers/`)
- [ ] **`adjustInventory()` doesn't use CAS** — Uses `version` column instead of `stockVersion`, no WHERE condition for concurrent safety. (`packages/core/src/modules/inventory/`)
- [ ] **Form validation schema divergence** — Discount code min length is 1 in AmountOffProducts vs 3 in AmountOffOrder/FreeShipping. (`apps/admin/src/components/admin/discount/`)

---

## Phase 2: International Phone Numbers

Replace Bangladesh-only phone handling with full international support.

- [ ] **Install `libphonenumber-js`** in `packages/shared` (lightweight, tree-shakeable)
- [ ] **Install `react-phone-number-input`** in `apps/admin` and `apps/storefront`
- [ ] **Add "Allowed Countries" setting** — Merchant configures which countries are allowed in admin settings. Default: all countries.
- [ ] **Update `packages/shared/src/customer-utils.ts`** — Replace hardcoded Bangladesh regex with `libphonenumber-js` validation. Always store E.164 format.
- [ ] **Update admin CustomerForm** — Replace text input with `react-phone-number-input` component. Respect allowed countries setting.
- [ ] **Update admin OrderForm** — Same phone input upgrade for order creation.
- [ ] **Update storefront checkout** — Phone input with country selector, validates against allowed countries.
- [ ] **Update storefront customer-auth** — OTP phone input uses international format.
- [ ] **Update core customer service** — Normalize all phone numbers to E.164 on save.
- [ ] **Fix phone format inconsistency** — Admin uses `01XXXXXXXXX`, storefront auth uses `+8801XXXXXXXXX`. Unify to E.164 everywhere.
- [ ] **Migration consideration** — Existing phone numbers in DB may need normalization. Create a utility to bulk-normalize existing data.
- [ ] **Update FTS5 search** — Phone search should work with or without country code prefix.

---

## Phase 3: Currency Management

Allow merchant to choose any currency; all displays and calculations use it.

- [ ] **Install `currency.js`** in `packages/shared` (handles precision, formatting)
- [ ] **Add currency picker to admin settings** — Dropdown with all ISO 4217 currencies. Store selected currency code + symbol + decimal places in siteSettings.
- [ ] **Update `packages/shared/src/currency.ts`** — Replace hardcoded `৳` default with dynamic currency from settings. Use `currency.js` for all formatting.
- [ ] **Update `packages/shared/src/price-utils.ts`** — Use `currency.js` for `roundPrice`, `addPrices`, `subtractPrice`, `calculatePercentageDiscount` to avoid floating-point issues.
- [ ] **Update admin price displays** — All `formatPrice()` calls use the merchant's selected currency.
- [ ] **Update storefront price displays** — All product cards, detail pages, cart, checkout use correct currency.
- [ ] **Update API price responses** — Include currency info in checkout config endpoint so storefront knows which currency to display.
- [ ] **Validate currency code in settings** — Reject invalid ISO 4217 codes.
- [ ] **Payment gateway currency alignment** — Ensure Stripe/SSLCommerz/Polar receive the correct currency code from settings (not hardcoded).

---

## Phase 4: Future Improvements (Not Bugs)

Nice-to-haves documented by the audit. NOT blocking — track for future sessions.

### Delivery
- [ ] `ShipmentTracker.notifyStatusChange()` is placeholder (no webhook to admin)
- [ ] `shipmentItems`, `shipmentAmount`, `isFinalShipment`, `trackingUrl`, `courierName` never populated
- [ ] Credential encryption only works if `CREDENTIAL_ENCRYPTION_KEY` is set
- [ ] Pathao import doesn't decrypt credentials before use

### Media
- [ ] No `alt` field on media table
- [ ] No image dimensions stored
- [ ] Hard delete only (no soft-delete/trash)
- [ ] No file rename UI
- [ ] Upload progress is fake (always 100%)
- [ ] No server-side sort/filter

### Attributes
- [ ] No core service layer (all logic inline in API route handlers)
- [ ] Single value per product per attribute (no multi-value)
- [ ] No attribute groups/categories
- [ ] Value rename is not atomic

### Categories
- [ ] No category hierarchy (flat only)
- [ ] No drag-and-drop reorder
- [ ] `permanentlyDeleteCategory()` has no product guard

### Collections
- [ ] Reorder is sequential (not batched)
- [ ] No FTS5 search (uses LIKE)
- [ ] No product count on collection list

### Pages
- [ ] No version history (unlike widgets which now have it)
- [ ] `getPageById` includes soft-deleted pages

### Payments
- [ ] Polar webhook `order.refunded` not processed
- [ ] No capture endpoint exposed
- [ ] Gateway factory pattern not used by routes
- [ ] Amount unit inconsistency between gateways (cents vs whole)

### Orders
- [ ] Notification types limited (only shipped/delivered emails)
- [ ] No payment status sync on order status change
- [ ] Bulk permanent delete ordering issue

### Widgets
- [ ] `displayTarget` enum only has "homepage" (no other targets)
- [ ] Search is client-side only
- [ ] No server-side pagination

### Discounts
- [ ] Combination flags (`combineWith*`) are cosmetic only (one discount per order)
- [ ] `applicationType` "buy" never written (dead BOGO prep)
- [ ] `customerSegment` field unused
- [ ] No percentage cap validation

### Other
- [ ] SMS transport stub (not implemented)
- [ ] `clearAllPermissionCache()` only clears current Worker isolate
- [ ] Abandoned checkout save requires no auth but cleanup requires auth
- [ ] Admin form slug prefix shows `/pages/` but storefront serves `/{slug}`
- [ ] Collections-list has no SSR data loading
- [ ] Preview link in collections points to homepage

---

## By Design (Not Bugs)

Confirmed by product owner — these are intentional:

- **Fraud checker not in checkout flow** — Manual merchant tool on order list page for ship/no-ship decisions
- **2FA not enforced** — Always optional, but must work flawlessly when merchant enables it
- **Single discount per order** — Intentional. Combination flags stored for future use but not enforced yet
