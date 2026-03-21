---
phase: 02-storefront-seo
plan: 02
subsystem: ui
tags: [seo, json-ld, open-graph, breadcrumbs, canonical-url, astro, storefront, structured-data]

# Dependency graph
requires:
  - phase: 02-storefront-seo plan 01
    provides: SEO Props interface on Layout.astro (canonicalUrl, ogImage, ogType, ogPrice, ogCurrency)
provides:
  - Product JSON-LD (merchant listing spec) on product pages
  - BreadcrumbList JSON-LD on product pages (Home > Category > Product)
  - CollectionPage JSON-LD with embedded BreadcrumbList on category pages
  - Product-specific OG tags (ogType=product, ogPrice, ogCurrency, ogImage 1200x630)
  - Canonical URLs on all four storefront page types
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "JSON-LD built as JSON.stringify() in Astro frontmatter, rendered via set:html in script tags"
    - "Conditional spread pattern for optional JSON-LD properties (e.g., image only when present)"
    - "HTML stripping via .replace(/<[^>]+>/g, '') before JSON-LD and OG description usage"
    - "Brand extraction from product.attributes array matching facebook-feed.xml.ts pattern"

key-files:
  created: []
  modified:
    - apps/storefront/src/pages/products/[slug].astro
    - apps/storefront/src/pages/categories/[slug].astro
    - apps/storefront/src/pages/index.astro
    - apps/storefront/src/pages/[slug].astro

key-decisions:
  - "Product JSON-LD follows Google merchant listing spec (not product snippet) since pages have Add to Cart"
  - "BreadcrumbList position adjusts dynamically based on category presence (position 2 or 3 for product)"
  - "Category canonical URL always strips pagination and filter query params for SEO deduplication"
  - "Homepage canonical ends with trailing slash; CMS pages do not"

patterns-established:
  - "Per-page JSON-LD pattern: build in frontmatter, inject via Fragment slot=head with set:html"
  - "OG image sizing: 1200x630 via getOptimizedImageUrl with format=auto, fit=cover"
  - "Brand fallback chain: product attributes brand -> store name from layout footer/header"

requirements-completed: [SEO-01, SEO-02, SEO-03, SEO-04, OG-01, OG-02, OG-03]

# Metrics
duration: 4min
completed: 2026-03-22
---

# Phase 02 Plan 02: Per-Page SEO Summary

**Product and Category JSON-LD structured data, BreadcrumbList, product OG tags, and canonical URLs on all four storefront page types**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-21T22:07:47Z
- **Completed:** 2026-03-21T22:11:47Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Product pages emit Product JSON-LD (merchant listing spec with name, description, image, sku, brand, offers/price/availability) and BreadcrumbList JSON-LD (Home > Category > Product with dynamic positioning)
- Category pages emit CollectionPage JSON-LD with embedded BreadcrumbList and category OG image
- All four page types (product, category, homepage, CMS) pass canonical URLs and ogType to Layout
- Product pages pass ogPrice, ogCurrency, and 1200x630 OG image for rich social sharing on Facebook/WhatsApp

## Task Commits

Each task was committed atomically:

1. **Task 1: Add Product JSON-LD, BreadcrumbList, and OG props to product page** - `c8c2756` (feat)
2. **Task 2: Add CollectionPage JSON-LD to category, canonical URLs to homepage and CMS page** - `8931801` (feat)

## Files Created/Modified
- `apps/storefront/src/pages/products/[slug].astro` - Product JSON-LD, BreadcrumbList JSON-LD, OG product tags (ogType, ogPrice, ogCurrency, ogImage), canonical URL
- `apps/storefront/src/pages/categories/[slug].astro` - CollectionPage JSON-LD with embedded BreadcrumbList, OG image, canonical URL
- `apps/storefront/src/pages/index.astro` - Canonical URL with trailing slash
- `apps/storefront/src/pages/[slug].astro` - Canonical URL for CMS pages

## Decisions Made
- Product JSON-LD uses merchant listing spec (not product snippet) since storefront pages have Add to Cart functionality
- BreadcrumbList dynamically adjusts positions: when category is present, product is position 3; without category, position 2
- Category canonical URL always points to `/categories/{slug}` without query parameters (pagination, sort, filters stripped for SEO deduplication)
- Homepage canonical ends with trailing slash (`/`); CMS page canonical does not have trailing slash
- Brand name extracted from product.attributes (matching facebook-feed.xml.ts pattern), with store name as fallback
- priceValidUntil set to end of next year (dynamic ISO 8601 date) to avoid Google warnings about past dates

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Pre-existing typecheck error in `@scalius/core` `invoice.service.ts:141` (TS2352 type conversion) - unrelated to storefront SEO changes, logged to deferred-items.md. Storefront typecheck passes with 0 errors, 0 warnings, 7 hints (informational Astro hints about script tags with attributes being treated as inline, which is expected for JSON-LD).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All storefront pages now have complete SEO data flowing to Layout
- Product pages are eligible for Google Rich Results (Product snippets, breadcrumbs)
- Category pages have CollectionPage schema for search engine understanding
- Social sharing on Facebook/WhatsApp shows rich previews with correct title, description, image, and price
- Phase 02 (Storefront SEO) is fully complete (both plans shipped)

## Self-Check: PASSED

- FOUND: apps/storefront/src/pages/products/[slug].astro
- FOUND: apps/storefront/src/pages/categories/[slug].astro
- FOUND: apps/storefront/src/pages/index.astro
- FOUND: apps/storefront/src/pages/[slug].astro
- FOUND: .planning/phases/02-storefront-seo/02-02-SUMMARY.md
- FOUND: commit c8c2756
- FOUND: commit 8931801

---
*Phase: 02-storefront-seo*
*Completed: 2026-03-22*
