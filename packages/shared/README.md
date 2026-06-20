# @scalius/shared

Pure utility functions shared across admin, storefront, and API workers. This package has **zero dependencies on other `@scalius/*` packages** -- it sits at the bottom of the dependency graph.

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
import { parseJSONSafely, validateWidgetJSON } from "@scalius/shared/json-repair";
import { parseTagBasedResponse, StreamingTagParser } from "@scalius/shared/tag-parser";
import { parseHtmlIntoSections } from "@scalius/shared/html-section-parser";
import { generateEAN13, validateEAN13 } from "@scalius/shared/barcode-utils";
import { generateBarcodeSvg } from "@scalius/shared/barcode-svg";
import { buildStorefrontPath } from "@scalius/shared/storefront-url";
import { layoutCache, CACHE_KEYS } from "@scalius/shared/layout-cache";
import { escapeHtml } from "@scalius/shared/html-escape";
import { sanitizeHtml } from "@scalius/shared/html-sanitize";
import { sanitizeCssForStyleElement } from "@scalius/shared/css-sanitize";
import { scopeCss } from "@scalius/shared/css-scope";
import { normalizeWidgetPlacementSlotForScope } from "@scalius/shared/widget-placement";
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
| `customer-utils.ts` | Phone validation (E.164), customer stats | `validateAndFormatPhone()`, `formatPhoneForDisplay()`, `phoneNumberSchema`, `isValidPhoneNumber`, `calculateCustomerStats()` |
| `order-utils.ts` | Random order ID generation (6 chars, A-Z0-9) | `generateOrderId()` |
| `json-repair.ts` | Multi-strategy JSON parsing for LLM responses | `extractAndParseJSON()`, `repairJSON()`, `aggressiveRepairJSON()`, `parseJSONSafely()`, `validateWidgetJSON()` |
| `tag-parser.ts` | XML-like tag extraction for LLM widget responses | `parseTagBasedResponse()`, `validateParsedWidget()`, `StreamingTagParser`, `getTagBasedExampleFormat()` |
| `html-section-parser.ts` | DOM-based HTML section extraction for widget editing | `parseHtmlIntoSections()`, `reconstructWidgetFromSections()` |
| `html-escape.ts` | HTML entity escaping for user values in templates | `escapeHtml()` -- escapes `&`, `<`, `>`, `"`, `'` |
| `html-sanitize.ts` | Defense-in-depth XSS sanitizer for admin-authored widget content | `sanitizeHtml()` -- strips `<script>`, `<iframe>`, `<object>`, `<embed>`, `<applet>`, `<base>`, `<form>` tags, `on*` handlers, `javascript:`/`vbscript:`/dangerous `data:` URLs |
| `css-sanitize.ts` | Defense-in-depth sanitizer for admin-authored widget stylesheets | `sanitizeCssForStyleElement()` -- prevents style-tag breakout, removes external stylesheet/font at-rules, strips HTML tags, and neutralizes script-capable CSS values/URLs |
| `css-scope.ts` | Scopes CSS selectors under a wrapper class | `scopeCss()` -- prevents widget styles from leaking; handles `@media`, `@keyframes`, comma-separated selectors, `body`/`html`/`*` rewriting |
| `widget-placement.ts` | Canonical widget placement scope/slot rules shared by admin and API validation | `isWidgetPlacementSlotAllowedForScope()`, `normalizeWidgetPlacementSlotForScope()`, `isWidgetCollectionSlot()` |
| `shortcodes.ts` | CMS shortcode parsing shared by storefront rendering and API cache invalidation | `parseShortcodes()`, `normalizeShortcodeAttributeQuotes()`, `ShortcodeMatch` |
| `timestamps.ts` | Unix epoch seconds utilities, date formatting for display | `toISOString()`, `fromUnixSeconds()`, `nowUnixSeconds()`, `unixToDate()`, `formatDate()` |
| `barcode-utils.ts` | EAN-13 barcode generation and validation (GS1 200-299 prefix) | `generateEAN13()`, `calculateEAN13CheckDigit()`, `validateEAN13()` |
| `barcode-svg.ts` | Pure SVG barcode rendering using Code 128B encoding | `generateBarcodeSvg()`, `BarcodeSvgOptions` -- uses `escapeHtml()` for label text |
| `storefront-url.ts` | Storefront URL path construction | `buildStorefrontPath()` |
| `layout-cache.ts` | In-memory TTL cache (5 min) for admin layout data | `layoutCache`, `CACHE_KEYS` |

## Dependencies

Runtime dependencies (listed in `package.json`):

| Package | Used By |
|---------|---------|
| `clsx` + `tailwind-merge` | `utils.ts` -- `cn()` class merging |
| `css-tree` | `css-sanitize.ts`, `css-scope.ts`, `css-tree-runtime.ts` -- CSS parsing/sanitization/scoping |
| `currency.js` | `currency.ts`, `price-utils.ts` -- precision arithmetic |
| `htmlparser2` + `domhandler` | `html-sanitize.ts`, `widget-rendering.ts` -- HTML parsing and DOM traversal |
| `libphonenumber-js` | `customer-utils.ts` -- E.164 phone validation |
| `zod` | `customer-utils.ts` -- `phoneNumberSchema` |

## Key Patterns

### Currency Formatting

`currency.ts` reads from `window.__CURRENCY_SYMBOL__` / `window.__CURRENCY_CODE__` globals injected by the storefront's `Layout.astro`. Server-side calls safely fall through to `DEFAULT_CURRENCY` (BDT). The `getDecimalPlaces()` lookup covers all ISO 4217 exceptions (0-decimal currencies like JPY, 3-decimal currencies like BHD) -- everything else defaults to 2.

### Image Optimization

`image-optimizer.ts` public functions are pure when an explicit `ImageContext` is passed. When context is omitted, they fall back to `detectIsDev()` and `detectCdnBase()` which probe `import.meta.env`, `window.location`, and `globalThis.process`. On production Cloudflare, it routes transforms through the image's own origin (`https://cloud.scalius.com/cdn-cgi/image/params/path`). On localhost, it skips `/cdn-cgi/` transforms (they 404 outside Cloudflare).

### Rate Limiter

`rate-limit.ts` uses Cloudflare KV with TTL-based expiry for automatic cleanup. Each rate-limit window is stored as a JSON entry (`{ count, resetAt }`) with `expirationTtl` matching the window duration. Uses `CF-Connecting-IP` (not spoofable) for client identification.

### LLM Response Parsing

`json-repair.ts` and `tag-parser.ts` work together for AI-generated widget content. `tag-parser.ts` is preferred (tag-based extraction is more reliable than JSON from LLMs), with `json-repair.ts` as a fallback. Both support multi-strategy parsing: direct parse, markdown extraction, tag extraction, aggressive repair.

### Widget Content Security

Widget HTML and CSS use complementary utilities:
- `html-escape.ts` (`escapeHtml`) -- for escaping user-supplied values inserted into HTML templates (email templates, barcode labels). Prevents HTML injection.
- `html-sanitize.ts` (`sanitizeHtml`) -- defense-in-depth sanitizer for admin-authored HTML (widgets). Strips `<script>`, `<iframe>`, `<object>`, `<embed>`, `<applet>`, `<base>`, `<form>` tags, `on*` event handlers, `javascript:`/`vbscript:` URLs, and dangerous `data:` URLs while preserving all other HTML structure.
- `css-sanitize.ts` (`sanitizeCssForStyleElement`) -- defense-in-depth sanitizer for full widget stylesheets before they are persisted or injected into `<style>` tags. It prevents `</style>` breakout, removes remote stylesheet/font at-rules (`@import`, `@font-face`, etc.), strips accidental HTML tags, and neutralizes script-capable CSS values such as `expression()`, `behavior`, `binding`, `javascript:`/`vbscript:`/`data:`/`file:` URLs, including CSS-escaped protocols.

### CSS Scoping

`css-scope.ts` (`scopeCss`) prefixes all CSS selectors with a unique wrapper class to prevent widget styles from leaking into the rest of the page. Handles `@media`/`@supports`/`@layer`/`@container` at-rules (prefixes inner selectors), preserves animation keyframes, and rewrites `body`/`html`/`*`/`:root` selectors to the scope class. Widget CSS should be passed through `sanitizeCssForStyleElement()` before `scopeCss()`.

### Widget Placement

`widget-placement.ts` keeps scope/slot rules canonical across admin forms and API validation. Homepage placements support top, bottom, before collection, and after collection slots. Page-like scoped placements support top, bottom, before content, and after content slots. Use `normalizeWidgetPlacementSlotForScope()` when a UI changes scope so hidden stale slot values cannot be submitted.

### Timestamps

`timestamps.ts` provides utilities for working with Unix epoch seconds at the service/application layer. For Drizzle schema defaults, use `UNIX_NOW` from `@scalius/database/schema` instead.

## Known Gaps

- `layout-cache.ts` uses in-memory state that is per-Worker-isolate; clearing in one Worker does not affect others.
- `html-section-parser.ts` requires a browser DOM (`DOMParser`); it falls back to a single-section result on the server.
