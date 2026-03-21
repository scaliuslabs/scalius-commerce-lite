---
phase: 02-storefront-seo
plan: 01
subsystem: ui
tags: [seo, json-ld, open-graph, twitter-cards, canonical-url, astro, storefront]

# Dependency graph
requires: []
provides:
  - SEO Props interface on Layout.astro (canonicalUrl, ogImage, ogType, ogPrice, ogCurrency, noindex)
  - Canonical URL link tag on every storefront page (when passed)
  - Open Graph meta tags (site_name, type, title, description, url, image, price)
  - Twitter Card meta tags (summary_large_image)
  - Organization JSON-LD (conditional on logo existence)
  - WebSite JSON-LD with SearchAction for Google Sitelinks Search Box
  - Robots noindex meta tag (conditional on noindex prop)
affects: [02-storefront-seo]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Conditional JSON-LD emission — only render Organization when logo exists, WebSite when storefrontUrl is non-empty"
    - "SEO props passed through Layout.astro Props interface for per-page customization"

key-files:
  created: []
  modified:
    - apps/storefront/src/layouts/Layout.astro

key-decisions:
  - "Used footerData.copyrightText as primary store name source, headerData.logo.alt as fallback"
  - "Organization JSON-LD omitted when no logo URL exists (never emit empty schema)"
  - "Conditional spread for sameAs in Organization JSON-LD to avoid empty arrays"

patterns-established:
  - "SEO props pattern: per-page SEO data flows through Layout.astro Props interface"
  - "JSON-LD pattern: build JSON string in frontmatter, render via set:html in script tag"

requirements-completed: [SEO-05, SEO-06, OG-04, OG-05, CAN-01, CAN-02]

# Metrics
duration: 2min
completed: 2026-03-22
---

# Phase 02 Plan 01: SEO Infrastructure Summary

**Canonical URLs, Open Graph/Twitter Card meta tags, and Organization+WebSite JSON-LD added to storefront Layout.astro**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-21T22:02:28Z
- **Completed:** 2026-03-21T22:04:30Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Extended Layout.astro Props interface with 6 new SEO fields (canonicalUrl, ogImage, ogType, ogPrice, ogCurrency, noindex)
- Added canonical URL, Open Graph, and Twitter Card meta tags to every storefront page
- Added Organization JSON-LD (conditional on logo) and WebSite JSON-LD with SearchAction (conditional on storefrontUrl)
- All SEO tags properly conditional -- price tags only render on product pages, JSON-LD only when data exists

## Task Commits

Each task was committed atomically:

1. **Task 1: Add SEO props, canonical URL, OG tags, Twitter Cards, and global JSON-LD to Layout.astro** - `a12be88` (feat)

## Files Created/Modified
- `apps/storefront/src/layouts/Layout.astro` - Extended with SEO Props interface, canonical link, OG/Twitter meta tags, Organization+WebSite JSON-LD

## Decisions Made
- Used `footerData.copyrightText` as primary store name source with `headerData.logo.alt` as fallback, since copyright text is merchant-configured
- Organization JSON-LD is completely omitted when no logo URL exists (per SEO-05 requirement to never emit empty schema)
- Used conditional spread `...(socialUrls.length > 0 ? { "sameAs": socialUrls } : {})` to avoid empty arrays in JSON-LD

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Layout.astro SEO infrastructure is ready for Plan 02 (per-page SEO data)
- All pages using Layout.astro automatically get OG tags, Twitter Cards, and JSON-LD
- Per-page SEO data (canonical URLs, product-specific OG images/prices) can now be passed via props

## Self-Check: PASSED

- FOUND: apps/storefront/src/layouts/Layout.astro
- FOUND: .planning/phases/02-storefront-seo/02-01-SUMMARY.md
- FOUND: commit a12be88

---
*Phase: 02-storefront-seo*
*Completed: 2026-03-22*
