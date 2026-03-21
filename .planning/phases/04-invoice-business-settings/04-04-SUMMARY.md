---
phase: 04-invoice-business-settings
plan: 04
subsystem: api, ui
tags: [invoice, print, pdf, html2pdf, astro, react-island, openapi, hono]

# Dependency graph
requires:
  - phase: 04-invoice-business-settings/01
    provides: getBusinessSettings service and BusinessInfo interface
  - phase: 04-invoice-business-settings/02
    provides: getOrAssignInvoiceNumber service and invoiceNumber column
provides:
  - GET /api/v1/admin/orders/:id/invoice endpoint returning order + business info + invoice number
  - Standalone invoice Astro page at /admin/orders/[id]/invoice with print CSS
  - InvoiceActions React island with Print and Download PDF buttons
  - Print Invoice button on order detail page header
affects: []

# Tech tracking
tech-stack:
  added: [html2pdf.js]
  patterns:
    - "Standalone Astro page (no AdminLayout) for print-optimized documents"
    - "React island (client:load) for interactive actions on static pages"
    - "Dynamic import of heavy libraries (html2pdf.js) for on-demand loading"

key-files:
  created:
    - apps/api/src/routes/admin/orders-invoice.ts
    - apps/admin/src/pages/admin/orders/[id]/invoice.astro
    - apps/admin/src/components/admin/InvoiceActions.tsx
    - apps/admin/src/types/html2pdf.d.ts
  modified:
    - apps/api/src/routes/admin/orders.ts
    - apps/admin/src/components/admin/orderview/OrderViewHeader.tsx
    - apps/admin/package.json

key-decisions:
  - "Standalone HTML page without AdminLayout for clean print output"
  - "Inline CSS (not Tailwind) in invoice page for consistent print rendering"
  - "html2pdf.js dynamically imported to avoid bundle size impact"

patterns-established:
  - "Invoice sub-router mounted via app.route in orders.ts following existing pattern"
  - "Autoprint query param (?autoprint=1) triggers window.print on page load"

requirements-completed: [INV-01, INV-02, INV-03, INV-04, INV-05, INV-06, INV-07]

# Metrics
duration: 4min
completed: 2026-03-22
---

# Phase 04 Plan 04: Invoice Page & API Summary

**Full invoice flow: API endpoint returning order+business data, standalone print-optimized Astro page with inline CSS, React Print/PDF buttons, and Print Invoice link on order header**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-21T22:15:43Z
- **Completed:** 2026-03-21T22:20:39Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments
- Invoice API endpoint at GET /admin/orders/:id/invoice returning order details, formatted invoice number, and business info
- Standalone invoice Astro page with inline CSS for print consistency, A4 page sizing, and hidden action bar on print
- InvoiceActions React island with Print (window.print) and Download PDF (html2pdf.js dynamic import) buttons
- Print Invoice button on OrderViewHeader opening invoice in new tab

## Task Commits

Each task was committed atomically:

1. **Task 1: Create invoice API endpoint** - `7784962` (feat)
2. **Task 2: Create invoice Astro page and InvoiceActions React component** - `fc48e8c` (feat)
3. **Task 3: Add Print Invoice button to OrderViewHeader** - `c3f955b` (feat)

## Files Created/Modified
- `apps/api/src/routes/admin/orders-invoice.ts` - OpenAPI route GET /:id/invoice with order, business info, and invoice number
- `apps/api/src/routes/admin/orders.ts` - Added adminOrdersInvoiceRoutes sub-router mount
- `apps/admin/src/pages/admin/orders/[id]/invoice.astro` - Standalone invoice page with inline CSS, print styles, and React island
- `apps/admin/src/components/admin/InvoiceActions.tsx` - React island with Print and Download PDF buttons
- `apps/admin/src/types/html2pdf.d.ts` - TypeScript type declaration for html2pdf.js
- `apps/admin/src/components/admin/orderview/OrderViewHeader.tsx` - Added Print Invoice button with Printer icon
- `apps/admin/package.json` - Added html2pdf.js dependency

## Decisions Made
- Used standalone HTML page (no AdminLayout) for invoice to ensure clean print output without sidebar/navigation chrome
- Inline CSS in style tag rather than Tailwind to guarantee print rendering consistency across browsers
- html2pdf.js loaded via dynamic import to avoid adding ~300KB to initial bundle
- Date handling accounts for both Date objects and Unix timestamps from API response

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Complete invoice flow is operational: order detail -> Print Invoice button -> invoice page -> print or download PDF
- All INV-* requirements satisfied (INV-01 through INV-07)
- Phase 04 is now fully complete (all 4 plans executed)

## Self-Check: PASSED

- [x] apps/api/src/routes/admin/orders-invoice.ts exists
- [x] apps/admin/src/pages/admin/orders/[id]/invoice.astro exists
- [x] apps/admin/src/components/admin/InvoiceActions.tsx exists
- [x] apps/admin/src/types/html2pdf.d.ts exists
- [x] Commit 7784962 found
- [x] Commit fc48e8c found
- [x] Commit c3f955b found

---
*Phase: 04-invoice-business-settings*
*Completed: 2026-03-22*
