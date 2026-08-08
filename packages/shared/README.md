# @scalius/shared

Pure utility functions shared across admin, storefront, and API workers. This package has **zero dependencies on other `@scalius/*` packages** -- it sits at the bottom of the dependency graph.

This is an AGPL-3.0-only private workspace package, not a separately published
npm library. Its modules remain browser/Worker-safe and avoid Node-only runtime
imports because the admin, storefront, and Workers consume the same sources.

## Export Map

The package uses a wildcard export map in `package.json`:

```json
{ "exports": { "./*": "./src/*.ts" } }
```

This means every file in `src/` is importable by name:

```typescript
import { cn } from "@scalius/shared/utils";
import { formatPrice, getDecimalPlaces } from "@scalius/shared/currency";
import { roundPrice, pricesEqual } from "@scalius/shared/price-utils";
import { getOptimizedImageUrl, ImagePresets } from "@scalius/shared/image-optimizer";
import { resolveMediaUrl } from "@scalius/shared/media-url";
import { rateLimit } from "@scalius/shared/rate-limit";
import { getCorsOriginContext } from "@scalius/shared/cors-helper";
import { generateOrderId } from "@scalius/shared/order-utils";
import { validateAndFormatPhone, phoneNumberSchema } from "@scalius/shared/customer-utils";
import { generateEAN13, validateEAN13 } from "@scalius/shared/barcode-utils";
import { generateBarcodeSvg } from "@scalius/shared/barcode-svg";
import { buildStorefrontPath } from "@scalius/shared/storefront-url";
import { escapeHtml } from "@scalius/shared/html-escape";
import { sanitizeHtml } from "@scalius/shared/html-sanitize";
import { parseShortcodes } from "@scalius/shared/shortcodes";
import { toISOString, fromUnixSeconds, nowUnixSeconds, unixToDate, formatDate } from "@scalius/shared/timestamps";
import { getStatusBadgeClass } from "@scalius/shared/status-badges";
```

## Files

| File | Purpose | Key Exports |
|------|---------|-------------|
| `utils.ts` | Tailwind class merging (re-exports date/badge utils for backward compat) | `cn()`, re-exports `unixToDate`, `formatDate`, `getStatusBadgeClass` |
| `status-badges.ts` | Tailwind CSS badge styling for all 11 order statuses (pending, processing, confirmed, shipped, delivered, completed, cancelled, returned, refunded, partially_refunded, incomplete) | `getStatusBadgeClass()` |
| `currency.ts` | ISO 4217 currency formatting with `currency.js` precision | `CurrencyConfig`, `DEFAULT_CURRENCY`, `getDecimalPlaces()`, `getCurrencySymbol()`, `getCurrencyCode()`, `formatPrice()`, `formatPriceShort()` |
| `price-utils.ts` | Float-safe price arithmetic via `currency.js` | `roundPrice()`, `addPrices()`, `subtractPrice()`, `pricesEqual()`, `calculatePercentageDiscount()` |
| `image-optimizer.ts` | Cloudflare Image Resizing URL generation | `getOptimizedImageUrl()`, `getOriginalImageUrl()`, `isR2Image()`, `getOptimizedImageProps()`, `getResponsiveSrcSet()`, `ImagePresets` |
| `media-url.ts` | Resolve bare R2 keys to full CDN URLs | `resolveMediaUrl()` |
| `cors-helper.ts` | Dynamic credentialed CORS origin validation from exact first-party runtime URLs plus optional explicit credentialed-CORS env origins; merchant CSP/KV domains are intentionally excluded | `getCorsOriginContext()` |
| `request-origin-guard.ts` | Same-origin guard for unsafe cookie-bearing browser requests used by admin/storefront proxy routes before forwarding or mutating session state | `shouldRejectCrossOriginCookieRequest()` |
| `rate-limit.ts` | KV-based IP rate limiter with automatic TTL expiry | `rateLimit()`, `getClientIp()` |
| `customer-utils.ts` | Phone validation (E.164), include/exclude country policy checks, customer stats | `validateAndFormatPhone()`, `assertPhoneCountryAllowed()`, `normalizePhoneCountryPolicy()`, `formatPhoneForDisplay()`, `phoneNumberSchema`, `isValidPhoneNumber`, `calculateCustomerStats()` |
| `order-utils.ts` | Cryptographically random 16-character Crockford-base32 order identity (80 bits) | `generateOrderId()` |
| `html-escape.ts` | HTML entity escaping for user values in templates | `escapeHtml()` -- escapes `&`, `<`, `>`, `"`, `'` |
| `html-sanitize.ts` | Defense-in-depth XSS sanitizer for merchant-authored rich HTML | `sanitizeHtml()` -- strips executable/embedded tags, `on*` handlers, and dangerous URL schemes while preserving safe content structure |
| `shortcodes.ts` | CMS shortcode parsing shared by storefront rendering and API cache invalidation | `parseShortcodes()`, `normalizeShortcodeAttributeQuotes()`, `ShortcodeMatch` |
| `timestamps.ts` | Unix epoch seconds utilities, date formatting for display | `toISOString()`, `fromUnixSeconds()`, `nowUnixSeconds()`, `unixToDate()`, `formatDate()` |
| `barcode-utils.ts` | EAN-13 barcode generation and validation (GS1 200-299 prefix) | `generateEAN13()`, `calculateEAN13CheckDigit()`, `validateEAN13()` |
| `barcode-svg.ts` | Pure SVG barcode rendering using Code 128B encoding | `generateBarcodeSvg()`, `BarcodeSvgOptions` -- uses `escapeHtml()` for label text |
| `storefront-url.ts` | Storefront URL path construction | `buildStorefrontPath()` |

## Dependencies

Runtime dependencies (listed in `package.json`):

| Package | Used By |
|---------|---------|
| `clsx` + `tailwind-merge` | `utils.ts` -- `cn()` class merging |
| `currency.js` | `currency.ts`, `price-utils.ts` -- precision arithmetic |
| `htmlparser2` + `domhandler` | `html-sanitize.ts` -- HTML parsing and DOM traversal |
| `libphonenumber-js` | `customer-utils.ts` -- E.164 phone validation |
| `zod` | `customer-utils.ts` -- `phoneNumberSchema` |

## Key Patterns

### Currency Formatting

`currency.ts` reads from `window.__CURRENCY_SYMBOL__` / `window.__CURRENCY_CODE__` globals injected by the storefront's `Layout.astro`. Server-side calls safely fall through to `DEFAULT_CURRENCY` (BDT). The `getDecimalPlaces()` lookup covers all ISO 4217 exceptions (0-decimal currencies like JPY, 3-decimal currencies like BHD) -- everything else defaults to 2.

### Image Optimization

`image-optimizer.ts` public functions are pure when an explicit `ImageContext` is passed. When context is omitted, they fall back to `detectIsDev()` and `detectCdnBase()` which probe `import.meta.env`, `window.location`, and `globalThis.process`. On production Cloudflare, it routes transforms through the image's own origin (`https://cloud.scalius.com/cdn-cgi/image/params/path`). On localhost, it skips `/cdn-cgi/` transforms (they 404 outside Cloudflare).

### Rate Limiter

`rate-limit.ts` uses Cloudflare KV with TTL-based expiry for automatic cleanup. Each rate-limit window is stored as a JSON entry (`{ count, resetAt }`) with `expirationTtl` matching the window duration. Uses `CF-Connecting-IP` (not spoofable) for client identification.

### Rich HTML Security

Use `html-escape.ts` when inserting individual values into templates and `html-sanitize.ts` when accepting a merchant-authored HTML document. CMS pages, rich-content previews, and storefront rendering all share the same sanitizer so executable tags, event handlers, and unsafe URL schemes are rejected consistently.

### Timestamps

`timestamps.ts` provides utilities for working with Unix epoch seconds at the service/application layer. For Drizzle schema defaults, use `UNIX_NOW` from `@scalius/database/schema` instead.
