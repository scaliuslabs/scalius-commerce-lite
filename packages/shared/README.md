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
import { safeErrorResponse, honoSafeError } from "@scalius/shared/error-utils";
import { parseJSONSafely, validateWidgetJSON } from "@scalius/shared/json-repair";
import { parseTagBasedResponse, StreamingTagParser } from "@scalius/shared/tag-parser";
import { parseHtmlIntoSections } from "@scalius/shared/html-section-parser";
import { generateEAN13, validateEAN13 } from "@scalius/shared/barcode-utils";
import { generateBarcodeSvg } from "@scalius/shared/barcode-svg";
import { buildStorefrontPath } from "@scalius/shared/storefront-url";
import { layoutCache, CACHE_KEYS } from "@scalius/shared/layout-cache";
```

## Files

| File | Lines | Purpose | Key Exports |
|------|-------|---------|-------------|
| `utils.ts` | 109 | Tailwind class merging, date/time formatting, status badge styling | `cn()`, `unixToDate()`, `formatDate()`, `getStatusBadgeClass()` |
| `currency.ts` | 101 | ISO 4217 currency formatting with `currency.js` precision | `CurrencyConfig`, `DEFAULT_CURRENCY`, `getDecimalPlaces()`, `getCurrencySymbol()`, `getCurrencyCode()`, `formatPrice()`, `formatPriceShort()` |
| `price-utils.ts` | 46 | Float-safe price arithmetic via `currency.js` | `roundPrice()`, `addPrices()`, `subtractPrice()`, `pricesEqual()`, `calculatePercentageDiscount()` |
| `image-optimizer.ts` | 319 | Cloudflare Image Resizing URL generation | `getOptimizedImageUrl()`, `getOriginalImageUrl()`, `isR2Image()`, `getOptimizedImageProps()`, `getResponsiveSrcSet()`, `ImagePresets` |
| `media-url.ts` | 36 | Resolve bare R2 keys to full CDN URLs | `resolveMediaUrl()` |
| `cors-helper.ts` | 84 | Dynamic CORS origin validation from env + KV | `getCorsOriginContext()` |
| `rate-limit.ts` | 74 | In-memory IP-based rate limiter | `rateLimit()` |
| `customer-utils.ts` | 78 | Phone validation (E.164), customer stats | `validateAndFormatPhone()`, `formatPhoneForDisplay()`, `phoneNumberSchema`, `isValidPhoneNumber`, `calculateCustomerStats()` |
| `order-utils.ts` | 9 | Random order ID generation (6 chars, A-Z0-9) | `generateOrderId()` |
| `error-utils.ts` | 83 | Safe error responses that prevent stack trace leakage | `safeErrorResponse()`, `zodErrorResponse()`, `honoSafeError()` |
| `json-repair.ts` | 171 | Multi-strategy JSON parsing for LLM responses | `extractAndParseJSON()`, `repairJSON()`, `aggressiveRepairJSON()`, `parseJSONSafely()`, `validateWidgetJSON()` |
| `tag-parser.ts` | 272 | XML-like tag extraction for LLM widget responses | `parseTagBasedResponse()`, `validateParsedWidget()`, `StreamingTagParser`, `getTagBasedExampleFormat()` |
| `html-section-parser.ts` | 331 | DOM-based HTML section extraction for widget editing | `parseHtmlIntoSections()`, `reconstructWidgetFromSections()` |
| `barcode-utils.ts` | 30 | EAN-13 barcode generation and validation (GS1 200-299 prefix) | `generateEAN13()`, `calculateEAN13CheckDigit()`, `validateEAN13()` |
| `barcode-svg.ts` | 206 | Pure SVG barcode rendering using Code 128B encoding | `generateBarcodeSvg()`, `BarcodeSvgOptions` |
| `storefront-url.ts` | 29 | Storefront URL path construction | `buildStorefrontPath()` |
| `layout-cache.ts` | 40 | In-memory TTL cache (5 min) for admin layout data | `layoutCache`, `CACHE_KEYS` |

## Dependencies

Runtime dependencies (listed in `package.json`):

| Package | Used By |
|---------|---------|
| `clsx` + `tailwind-merge` | `utils.ts` -- `cn()` class merging |
| `currency.js` | `currency.ts`, `price-utils.ts` -- precision arithmetic |
| `libphonenumber-js` | `customer-utils.ts` -- E.164 phone validation |
| `zod` | `customer-utils.ts` -- `phoneNumberSchema` |

## Key Patterns

### Currency Formatting

`currency.ts` reads from `window.__CURRENCY_SYMBOL__` / `window.__CURRENCY_CODE__` globals injected by the storefront's `Layout.astro`. Server-side calls safely fall through to `DEFAULT_CURRENCY` (BDT). The `getDecimalPlaces()` lookup covers all ISO 4217 exceptions (0-decimal currencies like JPY, 3-decimal currencies like BHD) -- everything else defaults to 2.

### Image Optimization

`image-optimizer.ts` is a pure module -- it does not read env vars directly. Callers pass `cdnBase` and `isDev` via the `ImageContext` parameter. On production Cloudflare, it routes transforms through the image's own origin (`https://cloud.scalius.com/cdn-cgi/image/params/path`). On localhost, it skips `/cdn-cgi/` transforms (they 404 outside Cloudflare).

### Rate Limiter

`rate-limit.ts` uses an in-memory `Map` -- state resets when the Worker isolate restarts. Acceptable for single-tenant but needs KV migration for multi-instance scale.

### LLM Response Parsing

`json-repair.ts` and `tag-parser.ts` work together for AI-generated widget content. `tag-parser.ts` is preferred (tag-based extraction is more reliable than JSON from LLMs), with `json-repair.ts` as a fallback. Both support multi-strategy parsing: direct parse, markdown extraction, tag extraction, aggressive repair.

## Known Gaps

- `drizzle-orm` is listed as a dependency in `package.json` but is not imported by any source file in this package. It may be a vestigial dependency.
- `rate-limit.ts` uses in-memory state that resets on Worker isolate restart.
- `layout-cache.ts` also uses in-memory state with the same limitation.
- `html-section-parser.ts` requires a browser DOM (`DOMParser`); it falls back to a single-section result on the server.
