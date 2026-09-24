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
import { fromMinor, toMinor } from "@scalius/shared/money";
import { mediaImageSrcSet, mediaImageUrl } from "@scalius/shared/media-variants";
import { resolveMediaUrl } from "@scalius/shared/media-url";
import { getClientIp } from "@scalius/shared/rate-limit";
import { getCorsOriginContext } from "@scalius/shared/cors-helper";
import { generateOrderId } from "@scalius/shared/order-utils";
import { validateAndFormatPhone, phoneNumberSchema } from "@scalius/shared/customer-utils";
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
| `money.ts` | Integer minor-unit money: the one decimal/minor boundary pair and exact catalog discount rounding | `toMinor()`, `fromMinor()`, `percentToBps()`, `bpsToPercent()`, `discountedPriceMinor()` |
| `price-utils.ts` | Display rounding for decimal prices already converted from minor units | `roundPrice()`, `roundPriceToPrecision()`, `calculateDiscountedPriceAtPrecision()` |
| `media-variants.ts` | Pre-generated WebP rendition ladder and URL helpers | `mediaVariantWidths()`, `mediaImageUrl()`, `mediaImageSrcSet()`, `mediaOriginalUrl()` |
| `media-url.ts` | Resolve bare R2 keys to full CDN URLs | `resolveMediaUrl()` |
| `cors-helper.ts` | Dynamic credentialed CORS origin validation from exact first-party runtime URLs plus the extra origins a merchant lists in Platform settings (composed into `CORS_ALLOWED_ORIGINS` at Worker entry, never a literal env var); merchant CSP/KV domains are intentionally excluded | `getCorsOriginContext()` |
| `request-origin-guard.ts` | Same-origin guard for unsafe cookie-bearing browser requests used by admin/storefront proxy routes before forwarding or mutating session state | `shouldRejectCrossOriginCookieRequest()` |
| `rate-limit.ts` | Client IP extraction for the native API rate limiters | `getClientIp()` |
| `customer-utils.ts` | Phone validation (E.164), include/exclude country policy checks, customer stats | `validateAndFormatPhone()`, `assertPhoneCountryAllowed()`, `normalizePhoneCountryPolicy()`, `phoneNumberSchema`, `isValidPhoneNumber`, `calculateCustomerStats()` |
| `order-utils.ts` | Cryptographically random 16-character Crockford-base32 order identity (80 bits) | `generateOrderId()` |
| `html-escape.ts` | HTML entity escaping for user values in templates | `escapeHtml()` -- escapes `&`, `<`, `>`, `"`, `'` |
| `html-sanitize.ts` | Defense-in-depth XSS sanitizer for merchant-authored rich HTML | `sanitizeHtml()` -- strips executable/embedded tags, `on*` handlers, and dangerous URL schemes while preserving safe content structure |
| `shortcodes.ts` | CMS shortcode parsing shared by storefront rendering and API cache invalidation | `parseShortcodes()`, `normalizeShortcodeAttributeQuotes()`, `ShortcodeMatch` |
| `timestamps.ts` | Unix epoch seconds utilities, date formatting for display | `toISOString()`, `fromUnixSeconds()`, `nowUnixSeconds()`, `unixToDate()`, `formatDate()` |
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

### Image renditions

Uploads get fixed WebP renditions stored beside the original at `<object_key>/<width>.webp` (widths from `mediaVariantWidths()`: 160/320/480/640/960/1600 below the source width plus a master of at most 2400 px). The dashboard encodes them in the browser; agent/CLI/URL-import uploads get them once from the API's Images binding. The API publishes the largest rendition as the media URL, so `mediaImageUrl()` and `mediaImageSrcSet()` derive every smaller one from that URL alone. Any other URL (older uploads, SVG, external hosts) is served unchanged; there are no on-the-fly transforms.

### Rich HTML Security

Use `html-escape.ts` when inserting individual values into templates and `html-sanitize.ts` when accepting a merchant-authored HTML document. CMS pages, rich-content previews, and storefront rendering all share the same sanitizer so executable tags, event handlers, and unsafe URL schemes are rejected consistently.

### Timestamps

`timestamps.ts` provides utilities for working with Unix epoch seconds at the service/application layer. For Drizzle schema defaults, use `UNIX_NOW` from `@scalius/database/schema` instead.
