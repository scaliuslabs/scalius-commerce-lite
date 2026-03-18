# Master Checklist — Scalius Commerce

Last updated: 2026-03-18 (final update)
Source: 47 README files written by 14 documentation agents, then updated after all fixes.

**Session Completed:**
- Phase 1: COMPLETE (24 bug fixes)
- Phase 2: COMPLETE (international phone numbers — libphonenumber-js + react-phone-number-input)
- Phase 3: COMPLETE (currency management — currency.js + 160+ ISO 4217 currencies)
- Phase 4: 8 quick fixes COMPLETE, ~20 feature items tracked for future

---

## Phase 1: Critical Bug Fixes — ALL COMPLETE

### P0 — Data Integrity / Security

- [x] FCM push notifications connected in queue consumer
- [x] Admin order create now deducts inventory (reserve → deduct with rollback)
- [x] Password validation aligned to 12 chars everywhere
- [x] QR codes generated locally via `qrcode` package (no TOTP secret leak)
- [x] Shipping method update uniqueness check fixed
- [x] `restoreOrder()` now re-reserves inventory (fails if insufficient stock)

### P1 — Broken UI / Missing Endpoints

- [x] Widget trash view works (`?trashed=true` parameter support)
- [x] Discount toggle-status endpoint added
- [x] CollectionSelector search URL fixed (`/v1/admin` prefix)
- [x] Dead `page.widgets` code removed from storefront
- [x] Discount duplicate feature working (`?duplicate=true`)
- [x] All 11 order states in UI (added returned, partially_refunded, incomplete, completed)
- [x] Flat discount display in product list
- [x] Soft-deleted variants filtered from product details
- [x] Product additionalInfo/richContent loading fixed

### P2 — Code Quality

- [x] Raw `db` imports replaced with `c.get("db")` in pages, fraud-checker routes
- [x] Dead marketing module deleted
- [x] Duplicate customer validation schemas consolidated
- [x] `generateDiscountCode()` extracted to shared utility
- [x] Duplicate integrations.ts routes removed (canonical in system.ts)
- [x] Customer soft-delete now writes history record
- [x] `adjustInventory()` uses `stockVersion` with CAS + retry
- [x] Checkout language edit form sync fixed (useEffect on editingLanguage)

### P2 — Not Yet Fixed (Code Quality, Low Priority)

- [ ] Duplicated SocialLinksSection between header/footer builders
- [ ] `new Date()` vs `sql'unixepoch()'` timestamp inconsistency in collections/orders
- [ ] Admin invite fallback logs temp password to console
- [ ] No session revocation on role/permission changes (stale for KV cache TTL)
- [ ] Discount form validation schema divergence (code min length 1 vs 3)

---

## Phase 2: International Phone Numbers — ALL COMPLETE

- [x] `libphonenumber-js` installed in `packages/shared`
- [x] `react-phone-number-input` installed in admin + storefront
- [x] Allowed countries setting with include/exclude mode toggle
- [x] `validateAndFormatPhone()` replaces all Bangladesh-only regex
- [x] Admin CustomerForm uses PhoneInput with country filtering
- [x] Admin OrderForm uses PhoneInput with country filtering
- [x] Storefront checkout PhoneField with `client:visible` hydration
- [x] Storefront AuthModal PhoneInput with country filtering
- [x] All phone storage in E.164 format
- [x] Phone format inconsistency fixed (admin + storefront unified)
- [x] Migration 0026: normalize existing phone data to E.164
- [x] Checkout config includes `allowedCountries` + `allowedCountriesMode`
- [x] Bangladesh-specific placeholders removed from defaults
- [x] `customerPhoneHelp` editable in checkout language admin

---

## Phase 3: Currency Management — ALL COMPLETE

- [x] `currency.js` installed in `packages/shared`
- [x] Searchable currency picker with 160+ ISO 4217 currencies
- [x] `formatPrice()` uses `currency.js` with ISO 4217 decimal places
- [x] `price-utils.ts` uses `currency.js` for all arithmetic
- [x] Admin `useCurrency` hook delegates to shared `formatPrice()`
- [x] Storefront pricing engine uses shared `formatPrice()`
- [x] Checkout `currencyFmt()` fixed (was showing integers only)
- [x] Payment gateways use `getDecimalPlaces()` for smallest-unit conversion
- [x] Checkout config includes `decimalPlaces`
- [x] Hardcoded ৳ removed from discount routes
- [x] Layout.astro injects `__CURRENCY_DECIMAL_PLACES__`

---

## Phase 4: Quick Fixes — COMPLETE

- [x] `getPageById` filters soft-deleted pages
- [x] `permanentlyDeleteCategory()` checks for products before deleting
- [x] Discount percentage capped at 0-100
- [x] Collection preview link removed (no storefront page)
- [x] Pathao import decrypts credentials before API call
- [x] Bulk permanent delete respects FK ordering (items before orders)
- [x] Admin page slug prefix shows `/` not `/pages/`
- [x] COD payment status auto-syncs to "paid" on DELIVERED/COMPLETED

---

## Phase 4: Future Improvements (Tracked for Future Sessions)

### Delivery
- [ ] `ShipmentTracker.notifyStatusChange()` is placeholder
- [ ] `shipmentItems`, `shipmentAmount`, `isFinalShipment`, `trackingUrl`, `courierName` never populated
- [ ] Credential encryption only works if `CREDENTIAL_ENCRYPTION_KEY` is set

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

### Collections
- [ ] Reorder is sequential (not batched)
- [ ] No FTS5 search (uses LIKE)
- [ ] No product count on collection list
- [ ] No SSR data loading

### Pages
- [ ] No version history (unlike widgets which now have it)

### Payments
- [ ] Polar webhook `order.refunded` not processed
- [ ] No capture endpoint exposed
- [ ] Gateway factory pattern not used by routes

### Orders
- [ ] Notification types limited (only shipped/delivered emails)

### Widgets
- [ ] `displayTarget` enum only has "homepage" (no other targets)
- [ ] Search is client-side only
- [ ] No server-side pagination

### Discounts
- [ ] Combination flags (`combineWith*`) are cosmetic only
- [ ] `applicationType` "buy" never written (dead BOGO prep)
- [ ] `customerSegment` field unused

### Other
- [ ] SMS transport stub (not implemented)
- [ ] `clearAllPermissionCache()` only clears current Worker isolate
- [ ] Abandoned checkout save requires no auth but cleanup requires auth

---

## By Design (Not Bugs)

- **Fraud checker not in checkout flow** — Manual merchant tool on order list page
- **2FA not enforced** — Always optional, works flawlessly when enabled
- **Single discount per order** — Intentional, combination flags for future use
