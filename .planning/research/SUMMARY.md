# Project Research Summary

**Project:** Scalius Commerce — BD Market Readiness Features
**Domain:** Bangladesh e-commerce platform enhancements (SMS OTP, Invoice Printing, Storefront SEO, Bengali FTS5 Search)
**Researched:** 2026-03-22
**Confidence:** HIGH (three of four domains verified against official specs; one domain carries one medium-confidence gap)

## Executive Summary

This research covers four independent but related features required for Bangladesh market readiness on the Scalius Commerce platform. The features span two layers: the storefront (SEO, Bengali search) and the admin/operational backend (SMS OTP delivery, invoice printing). All four are additions to an existing, mature Cloudflare Workers monorepo and must fit within the Worker runtime constraints — no Node.js built-ins, no headless browsers, no server-side PDF generation. The research confirms that solutions exist for all four domains within these constraints, and provides implementation-ready details for each.

The recommended approach is to treat these as four parallel workstreams that share no critical code dependencies with each other. Bengali FTS5 search is the highest-risk item because it requires a database migration that drops and recreates virtual tables, and includes one unconfirmed behavior on D1 (unicode61 tokenizer category options). The other three features (SMS providers, invoice printing, SEO) are high-confidence and follow established patterns already present in the codebase. The overall implementation risk is low: all four can be delivered incrementally without breaking existing functionality, and each has a defined fallback if the primary approach fails.

The two most important decisions for the roadmap: (1) Bengali FTS5 must be validated locally before deploying to production — a test query suite is documented and the fallback to trigram tokenizer is confirmed working on D1. (2) Invoice printing avoids all server-side PDF complexity by using `window.print()` as primary and `html2pdf.js` (dynamic import, ~180 KB) as optional download — this is the correct approach for a Cloudflare Workers environment and matches how BD merchants actually work (print-to-rider workflow).

## Key Findings

### SMS Providers (from SMS-PROVIDERS.md)

Four Bangladesh SMS gateway providers were researched with full API documentation read directly: BDBulkSMS (GreenWeb), MIM SMS, SMS.net.bd, and Gennet iSMS. All four support Unicode Bengali in message bodies. All four use different authentication schemes, phone number formats, and response structures — a unified `SmsProvider` interface is required.

**Implementation priority (ranked by onboarding friction):**
- **SMS.net.bd** — Start here. Single API key, no sender ID required, simplest request format (form-data POST), unambiguous success indicator (`error: 0`). Returns `request_id` for delivery tracking.
- **BDBulkSMS (GreenWeb)** — Second. Established BD operator, demo token available for integration testing without a real account, no sender ID required.
- **MIM SMS** — Third. Requires pre-registered sender name (adds onboarding friction). Clean, consistent response structure.
- **Gennet iSMS** — Fourth. Most complex: account-specific domain URL, mandatory unique `csms_id` per SMS per day, SID assigned by GenNet. Duplicate `csms_id` on retry must be treated as success (not error).

**Architecture:** Follow the email provider registry pattern already in `packages/core/src/integrations/email/`. Provider implementations in `packages/core/src/integrations/sms/providers/`. Active provider resolved at queue-dispatch time by reading `settings` table (category `sms`). Credentials stored encrypted with AES-GCM using existing `upsertEncryptedSetting`. The existing OTP queue stub (`else` branch in queue-consumer.ts) is replaced with `getActiveSmsProvider(db, env.ENCRYPTION_KEY)`.

**One critical risk:** BDBulkSMS and Gennet both list IP blacklisting error codes. Cloudflare Workers use dynamic IP ranges. If providers require IP whitelisting, they are incompatible with Workers without a fixed-IP proxy. Flag for validation before implementation.

### Invoice Printing (from INVOICE.md)

Cloudflare Workers cannot run Puppeteer, Playwright, or any Node.js-based PDF renderer. The correct approach — confirmed with high confidence — is a dedicated Astro invoice page with `window.print()` as primary and `html2pdf.js` (dynamic import) as optional PDF download. This matches the actual BD merchant workflow: open order, print slip, hand to delivery rider.

**Stack decisions:**
- `window.print()` for print dialog — zero dependencies, works offline, renders Bengali correctly via system fonts
- `html2pdf.js` (0.10.1, ~180 KB) — dynamic import on "Download PDF" click only; output is rasterized (not selectable), acceptable for invoices; Bengali text renders correctly via html2canvas
- No server-side PDF library of any kind

**Schema changes required:** One migration — add `invoice_number INTEGER` column to orders table with partial unique index (`WHERE invoice_number IS NOT NULL`). Invoice counter stored in `settings` table (category `invoice_counter`, no additional migration needed). Business info stored in `settings` table (category `business_info`, 14 keys including TIN/BIN for BD compliance).

**Key risk:** `orders.totalAmount` has inconsistent usage in the codebase — `OrderViewHeader` uses it as grand total while `OrderItemsCard` recomputes `totalAmount + shippingCharge - discountAmount`. Invoice must display the correct grand total. Read `orders.admin.ts` getOrderDetails before implementing the template and compute grand total explicitly as all three rows.

**Implementation steps (ordered by dependency):** Business settings API + UI → migration + invoice number column → invoice service (counter CAS logic) → invoice API endpoint → invoice Astro page + React actions → "Print Invoice" button on order view header.

### Storefront SEO (from SEO.md)

Research verified against official Google Search Central documentation, ogp.me specification, and X/Twitter developer docs. All implementations fit within the existing Astro SSR + Cloudflare Workers runtime with no new dependencies.

**What to implement:**
- **JSON-LD:** Product (merchant listing spec — requires image + offers), BreadcrumbList, Organization, WebSite (with SearchAction for Sitelinks Search Box), CollectionPage for category pages
- **Open Graph:** Full per-page OG tags with `og:type="product"` + `og:price:amount` / `og:price:currency` on product pages; 1200×630 JPEG images via existing `getOptimizedImageUrl()`; `og:site_name` from layout data
- **Twitter Cards:** `summary_large_image` — same image URL as OG, minimal extra markup
- **Canonical URLs:** `getRuntimeStorefrontUrl() + Astro.url.pathname` (strip query params); same canonical for all paginated pages (Google deprecated rel=prev/next)

**BD market specifics:** Facebook is the dominant social sharing platform in Bangladesh; WhatsApp is the dominant link-sharing channel. WhatsApp requires HTTPS images, does not support WebP in link previews (use `format=auto` which Cloudflare auto-selects based on Accept header — safe for crawlers). `og:locale` and `hreflang` are out of scope (single language deployment).

**Architecture:** Extended `Props` interface on `Layout.astro` with `canonicalUrl`, `ogImage`, `ogType`, `ogPrice`, `ogCurrency`, `noindex`. Organization + WebSite JSON-LD emitted globally from Layout frontmatter. Per-page JSON-LD (Product, BreadcrumbList, CollectionPage) injected via existing `<slot name="head" />`. No new dependencies.

**Key constraints:** Never use `Astro.site` (unreliable in Workers SSR); always use `getRuntimeStorefrontUrl()`. Never emit empty strings in JSON-LD. Strip HTML from description fields before JSON-LD output. Never emit `og:image` when no image is available.

### Bengali FTS5 Search (from BENGALI-SEARCH.md)

The root cause of Bengali search failure is well-understood: FTS5's default `unicode61` tokenizer treats vowel signs (Unicode category Mc — Spacing Mark, Mn — Nonspacing Mark) as word separators instead of token characters. The word "বাংলা" (5 characters) splits into three disconnected fragments under the default config, making any Bengali search completely non-functional.

**The fix:** Add `categories 'L* N* Co Mc Mn'` to the unicode61 tokenizer options. This promotes Mc and Mn to token characters, keeping vowel signs attached to their consonants. English/ASCII search is unaffected (all ASCII Latin chars are Lo, already in L*). prefix matching via `*` continues to work because Bengali uses space-delimited words. No changes to `sanitizeFtsQuery` are needed.

**Tokenizer config:** `tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"`

**Tables to update** (5 Bengali-content tables): `products_fts`, `categories_fts`, `pages_fts`, `customers_fts`, `orders_fts`. Three ASCII-only tables are left unchanged: `product_variants_fts`, `discounts_fts`, `abandoned_checkouts_fts`.

**Migration:** FTS5 virtual tables cannot be altered; must DROP and recreate with triggers. Migration follows same pattern as `0016_fts5_search.sql`. No data loss — source tables are untouched; `INSERT INTO ... VALUES('rebuild')` repopulates from them. Brief window of empty search results during migration is acceptable.

**D1 compatibility gap:** The specific `categories` option on `unicode61` has not been confirmed on Cloudflare D1. Fallback is `trigram` tokenizer (confirmed working on D1) at the cost of ~3x index size and substring-instead-of-prefix matching. Test locally before deploying.

## Implications for Roadmap

Based on combined research, the four features are independent and can be phased in any order. The recommended sequencing below minimizes risk by front-loading the highest-risk item (Bengali FTS5 with D1 validation uncertainty) and the lowest-complexity item (SEO, pure additions with no schema changes) early.

### Phase 1: Bengali FTS5 Search Fix

**Rationale:** Highest risk due to D1 compatibility uncertainty; shortest implementation (one SQL migration file, no TypeScript changes). Ship it first to discover any D1 blocker early. If the unicode61 `categories` option fails, the trigram fallback must be assessed and may affect the migration file size estimate.

**Delivers:** Functional Bengali product search, category search, customer search, and page search in the admin and storefront.

**Implements:** One migration file (`0031_bengali_fts5_tokenizer.sql`). Optional low-priority hardening: add Bengali danda characters to `FTS5_SPECIAL_CHARS` in `packages/core/src/search/fts5.ts`.

**Avoids:** Deploying without pre-migration local validation. The test query suite in BENGALI-SEARCH.md must pass before running `pnpm deploy`.

**Research flag:** Needs local D1 validation before deployment. If unicode61 `categories` option is rejected, switch migration to `tokenize = "trigram"` — confirmed fallback.

### Phase 2: Storefront SEO

**Rationale:** Pure additions with no schema changes, no new required dependencies, no migration. Lowest-risk, high-impact for BD market visibility. Facebook/WhatsApp sharing and Google rich results both require this. Can run concurrently with Phase 1 by a different engineer.

**Delivers:** JSON-LD structured data on product/category/homepage/CMS pages; canonical URLs on all pages; full OG + Twitter Card meta tags; Sitelinks Search Box via WebSite schema.

**Implements:** Extended `Layout.astro` props + frontmatter additions; per-page frontmatter changes in `products/[slug].astro`, `categories/[slug].astro`, `index.astro`, `[slug].astro`. No new packages needed.

**Avoids:** Using `Astro.site` (unreliable in Workers SSR); emitting empty JSON-LD properties; missing WhatsApp JPEG image requirement.

**Research flag:** Well-documented patterns. No additional research needed. Validate with Google Rich Results Test and Facebook Sharing Debugger after deployment.

### Phase 3: SMS OTP Providers

**Rationale:** Completes the `authVerificationMethod: "sms_otp"` feature path that already exists in the codebase (enum value present, transport stub present, queue consumer stub present). Unblocks SMS-based customer authentication for merchants who prefer not to use WhatsApp OTP. Implementation complexity is medium — four providers with different APIs but a unified interface.

**Delivers:** Functional SMS OTP delivery via any of 4 BD gateways selectable in admin settings. Provider settings tab in admin. Encrypted credential storage. Queue consumer SMS dispatch.

**Implements:** `packages/core/src/integrations/sms/` — provider interface, registry, 4 provider implementations, active-provider resolver. Admin settings UI (SMS provider selector + per-provider credential fields). Queue consumer `else` branch replacement.

**Avoids:** Bloating the OTP queue payload with credentials (fetch from `settings` table in queue consumer instead); skipping `csms_id` uniqueness on Gennet (must use nanoid(20)); treating Gennet duplicate `csms_id` (4023) as failure on retry (it means already sent — treat as success).

**Research flag:** IP whitelisting compatibility with Cloudflare Workers dynamic IPs must be confirmed for BDBulkSMS and Gennet before production deployment. SMS.net.bd and MIM SMS do not mention IP restrictions. Start with SMS.net.bd to unblock merchants while Gennet/BDBulkSMS compatibility is verified.

### Phase 4: Invoice Printing

**Rationale:** Requires one schema migration and the most cross-cutting work (settings API, settings UI, invoice service with counter CAS logic, API endpoint, Astro page, React component, order view button). Placed last not because it is low priority but because it has the most sequential internal dependencies and benefits from the business settings infrastructure existing before it.

**Delivers:** Per-order invoice page accessible from order view (`/admin/orders/:id/invoice`); configurable business info with TIN/BIN for BD compliance; sequential invoice numbering with configurable prefix; print via `window.print()`; optional PDF download via dynamic `html2pdf.js` import; "Print Invoice" button on order view header.

**Implements:** Business settings API (`GET/POST /admin/settings/business`); `BusinessSettingsBuilder.tsx` admin tab; migration 0031 (`invoice_number` column on orders + partial unique index); invoice number counter in settings table; invoice service functions; invoice Astro page with print CSS; `InvoiceActions.tsx` React component; `OrderViewHeader.tsx` button.

**Avoids:** Any server-side PDF generation (impossible on Workers); using `AUTOINCREMENT` for invoice numbers (cannot be prefixed/reset); `totalAmount` ambiguity (always compute grand total as `totalAmount + shippingCharge - discountAmount`); base64-encoding logo server-side (unnecessary, bloats response); blocking on bulk invoice download (defer to a separate milestone).

**Research flag:** Resolve `orders.totalAmount` semantics by reading `getOrderDetails()` before building the invoice template. Confirm R2 bucket CORS configuration allows `dashboard.scalius.com` for html2canvas PDF download. Invoice counter race condition is mitigated by D1's serialized writes + CAS UPDATE — handle with one retry on conflict.

### Phase Ordering Rationale

- Phase 1 first: only one file, reveals D1 compatibility gap earliest, no dependencies on other phases
- Phase 2 first or concurrent: zero schema changes, no inter-phase dependencies, purely additive
- Phase 3 after Phase 2: SMS OTP and SEO share no dependencies; ordering is preference — SMS affects backend while SEO affects frontend
- Phase 4 last: has the most internal step dependencies (settings must exist before invoice service, migration before counter, endpoint before page, page before button)

Phases 1 and 2 can be executed concurrently by different engineers with zero file conflicts. Phases 3 and 4 can also run concurrently (different domains: `core/integrations/sms/` vs `core/modules/orders/`, `admin/settings/`, `admin/pages/orders/`).

### Research Flags

Needs validation before shipping to production:
- **Phase 1 (Bengali FTS5):** Validate `unicode61 categories 'L* N* Co Mc Mn'` option on local D1 before running `pnpm deploy`. Test query suite is documented in BENGALI-SEARCH.md. If it fails, switch to `tokenize = "trigram"`.
- **Phase 3 (SMS Providers):** Confirm BDBulkSMS and Gennet iSMS IP whitelisting behavior with Cloudflare Workers dynamic IPs. Test with SMS.net.bd first (no IP restriction documented).
- **Phase 4 (Invoice):** Confirm `orders.totalAmount` semantics in `getOrderDetails()` before building invoice template. Confirm R2 CORS allows admin domain for html2canvas.

Standard patterns (no additional research needed):
- **Phase 2 (SEO):** Google Search Central and OG specs are well-documented. Implementation is additive. Validate post-deploy with Google Rich Results Test.
- **Phase 3 (SMS):** Provider API details fully documented in SMS-PROVIDERS.md. Registry pattern follows existing email provider implementation.
- **Phase 4 (Invoice):** Business settings follow existing pattern (CurrencySettingsBuilder). Print CSS is standard. html2pdf.js is well-documented.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| SMS Providers | HIGH | All 4 provider APIs read from official docs. Phone format, auth, response parsing all verified. One gap: IP whitelisting behavior with Workers. |
| Invoice Printing | HIGH | Cloudflare Worker constraint is confirmed (no headless browser). html2pdf.js and window.print() approach is well-documented. One risk: totalAmount semantics need verification against actual code. |
| Storefront SEO | HIGH | Verified against Google Search Central, ogp.me, and X/Twitter official documentation. All property mappings traced to existing codebase variables. |
| Bengali FTS5 | HIGH/MEDIUM | Unicode category behavior sourced from official SQLite FTS5 docs (HIGH). D1 support for unicode61 categories option is inferred, not confirmed (MEDIUM). Fallback to trigram is confirmed. |

**Overall confidence:** HIGH with one medium-confidence item (D1 unicode61 categories option) that has a documented fallback.

### Gaps to Address

- **D1 unicode61 `categories` option:** Run the test query suite from BENGALI-SEARCH.md against local D1 before committing to the migration. Fallback to `tokenize = "trigram"` is fully designed and ready to substitute.
- **`orders.totalAmount` semantics:** Read `packages/core/src/modules/orders/orders.admin.ts` `getOrderDetails()` to confirm what `totalAmount` stores (subtotal vs grand total) before building the invoice totals section. The existing codebase has two inconsistent usages.
- **R2 CORS configuration:** Confirm `cloud.scalius.com` bucket returns `Access-Control-Allow-Origin` for the admin domain (`dashboard.scalius.com`). Required for html2canvas logo rendering in PDF download. `window.print()` is unaffected.
- **BDBulkSMS / Gennet IP whitelisting:** Confirm whether these providers require IP allowlisting before offering them to merchants. SMS.net.bd has no documented IP restriction and is the recommended first provider to implement.
- **Bulk invoice download:** Deferred to a separate milestone. Single-invoice print/download is the v1.0 scope. The research documents three approaches (multi-page html2pdf, JSZip, server-side service) for future planning.

## Sources

### Primary (HIGH confidence)

- SQLite FTS5 Official Documentation — tokenizer configuration, unicode61 category options, trigram behavior, external content tables
- Google Search Central — Product Structured Data (Merchant Listings) — required and recommended Product JSON-LD properties
- Google Search Central — Breadcrumb Structured Data — BreadcrumbList JSON-LD spec
- Google Search Central — Organization Schema — Organization JSON-LD spec
- The Open Graph Protocol (ogp.me) — OG tag specification, property reference
- X/Twitter Developer Documentation — Summary Card with Large Image requirements
- BDBulkSMS API documentation (temp-doc/sms/) — authentication, phone formats, response structure
- MIM SMS API documentation (temp-doc/sms/) — endpoint, required fields, error codes
- SMS.net.bd API documentation (temp-doc/sms/) — endpoint, form fields, error codes
- Gennet iSMS API v3 documentation (temp-doc/sms/) — endpoint, csms_id requirements, error codes

### Secondary (MEDIUM confidence)

- Cloudflare D1 FTS5 Japanese Search (Zenn/Cybozu Frontend) — confirms D1 FTS5 limitations for non-space-separated scripts; space-separated (Bengali) is fundamentally different
- SQLite FTS5 Tokenizers: unicode61 and ascii (Feldroy, Jan 2025) — confirms unicode61 splits Devanagari (Indic sister script) under default config
- BanglishRev E-Commerce Dataset (arXiv 2024) — confirms real-world BD e-commerce uses mixed Bengali/English/Banglish text
- html2pdf.js official documentation — bundle size, API, html2canvas options, Bengali rendering
- Facebook OG Image Dimensions Guide 2026 — 1200×630 pixel requirements, WhatsApp specifics
- WhatsApp Link Preview Requirements 2026 — HTTPS requirement, WebP limitation

### Tertiary (LOW confidence)

- SMS provider pricing — Not documented in any provider API docs. BD market rate BDT 0.20–0.50/SMS is a general estimate only; merchants must verify directly with providers.

---
*Research completed: 2026-03-22*
*Ready for roadmap: yes*
