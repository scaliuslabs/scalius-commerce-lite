# Invoice Printing Research

**Project:** Scalius Commerce — Invoice/Receipt Printing
**Milestone:** v1.0 BD Market Readiness
**Researched:** 2026-03-22
**Overall confidence:** HIGH

---

## Approach Decision

**Verdict: HTML print page via `window.print()` as primary, with optional client-side PDF download via `html2pdf.js` loaded on demand.**

### Why not server-side PDF

Cloudflare Workers have a 128 MB memory limit and no access to Node.js built-ins. Puppeteer, Playwright, wkhtmltopdf, and all headless-browser-based PDF generation are completely unavailable. Third-party PDF services (DocRaptor, PDFShift, WeasyPrint API) add latency, cost, and external HTTP dependencies — unacceptable for what is functionally a print dialog. This is a confirmed constraint, not an estimate.

### Why HTML print is the correct primary approach

BD merchants process COD orders in bulk. The actual workflow is: open order, click "Print Invoice", hand the printed slip to the delivery rider. The browser's native print dialog (`window.print()`) produces this result with zero dependencies. It works offline, it's fast, and it renders Bengali text correctly as long as the user has the Hono/Kalpurush/Noto Bangla system font installed (which all Bengali Windows/Android systems do by default). Modern browsers (Chrome, Firefox, Edge) produce high-quality PDF output when the user selects "Save as PDF" from the print dialog — this covers the majority of "download as PDF" use cases without any library.

### Why html2pdf.js is the correct optional enhancement

For merchants who want a one-click "Download PDF" button that does not require the print dialog, `html2pdf.js` (html2canvas + jsPDF wrapper, ~180 KB minified) is the standard client-side approach. Critical limitation: the output is a rasterized image inside a PDF — text is not selectable or searchable. This is acceptable for invoices. The library must be loaded dynamically (`import()`) so it does not add to the base bundle weight.

**Bundle impact:** html2pdf.js is approximately 180 KB minified. It must be dynamically imported on demand only, triggered when the "Download PDF" button is clicked. It must never be part of the initial page load.

### Alternatives rejected

| Option | Why Rejected |
|--------|-------------|
| react-pdf (PDF.js) | Renders PDF from React components server-side; requires Node.js APIs unavailable on Workers |
| Puppeteer/Playwright | Requires full browser process; impossible on Workers |
| DocRaptor/PDFShift | External HTTP call; adds cost, latency, privacy concern; overkill |
| @react-pdf/renderer | Requires Node stream APIs; not compatible with Workers environment |

---

## Invoice Template Design

### Route

A dedicated Astro page at `apps/admin/src/pages/admin/orders/[id]/invoice.astro`. This page:

1. Runs server-side (SSR) and fetches full order data plus business settings in parallel
2. Renders a complete, self-contained HTML invoice with inline Tailwind print classes
3. Has no admin navigation, sidebar, or header UI — only the invoice content
4. Includes a sticky action bar (visible on screen, hidden on print) with "Print" and "Download PDF" buttons

### Required fields on the invoice

**Business header (from business settings):**
- Company/store name (large, prominent)
- Logo image (from R2 CDN, must use absolute URL for print)
- Legal/trade name (smaller, below store name)
- Business address (multi-line)
- Business phone
- Business email
- Tax/VAT registration number (labeled "TIN" or "BIN" for BD context — Business Identification Number)
- Invoice footer text (configurable freeform text)

**Invoice metadata:**
- Invoice number (formatted, e.g., `INV-00142`)
- Invoice date (order creation date)
- Due date (optional — for net terms, not common in COD)
- Order ID (for cross-reference)
- Payment method and payment status

**Bill to (customer):**
- Customer name
- Phone number
- Email (if present)
- Delivery address (street + area + zone + city, multiline)

**Shipment info (if present):**
- Courier name (providerName)
- Tracking ID

**Line items table:**
```
| # | Product Name   | Variant       | Qty | Unit Price | Total    |
|---|----------------|---------------|-----|------------|----------|
| 1 | Product A      | Red / L       |  2  |   ৳ 500   | ৳ 1,000 |
```

The `variantSize` and `variantColor` fields from `OrderItem` should be combined into a single "Variant" column: `${size} / ${color}` — omit if both are null. The `orderItems.variantLabel` column exists in the DB schema but is not selected in `getOrderDetails()` — it should be added to the query as a fallback display string.

**Totals section:**
```
Subtotal:      ৳ X,XXX
Shipping:      ৳   XXX
Discount:     -৳   XXX   (omit row if zero)
──────────────────────────
Grand Total:   ৳ X,XXX
```

Note: `orders.totalAmount` is the pre-shipping, pre-discount subtotal based on the DB schema. The grand total displayed to merchants must be computed as `totalAmount + shippingCharge - (discountAmount ?? 0)`. This matches how `OrderItemsCard.tsx` computes `grandTotal`. Confirm against actual data before shipping — there is existing ambiguity in the codebase (the `OrderViewHeader` uses `order.totalAmount` directly as grand total while `OrderItemsCard` re-computes it).

**Tax section:**
- Tax is out of scope for v1.0 per `PROJECT.md`. Reserve a row in the template but keep it hidden/commented until the tax milestone. This avoids a template rewrite later.

**Footer:**
- Configurable footer text (e.g., "Thank you for your order!")
- "This is a computer-generated invoice and does not require a signature" (standard BD practice)
- Page number if multi-page (CSS `counter()`)

### Bengali text support

Bengali text renders correctly in all modern browsers when the correct Unicode font is available. The system font stack `'Hind Siliguri', 'Noto Sans Bengali', 'SolaimanLipi', sans-serif` covers Windows, macOS, Android, and Linux. No font embedding is required for screen display. For print, the browser uses the same system fonts and renders them correctly.

For the invoice template, product names and addresses may contain Bengali characters. No special handling is required — Unicode Bengali characters in UTF-8 HTML render correctly in print as long as the CSS does not force a font that lacks Bengali glyphs. Use `font-family: 'Hind Siliguri', 'Noto Sans Bengali', system-ui, sans-serif` as the base font for the invoice body.

If a merchant wants Bengali-only product names, those will render from the existing `productName` field which is stored as UTF-8 text — no schema change needed.

---

## Business Settings Schema

### Storage decision

Use the `settings` table (KV-style, category + key + value) rather than adding columns to `siteSettings`. Rationale: business info is a cohesive, optional, extensible group — exactly what the `settings` table is designed for. The `siteSettings` table already has singleton constraint complexity; adding 8+ new columns for business info would bloat it.

Category: `"business_info"`

| Key | Value type | Description |
|-----|------------|-------------|
| `company_name` | string | Primary display name on invoices |
| `legal_name` | string | Registered legal/trade name |
| `address_line1` | string | Street address |
| `address_line2` | string | Floor, suite, unit (optional) |
| `city` | string | City |
| `state_region` | string | State, district, or division |
| `postal_code` | string | ZIP/postal code |
| `country` | string | Country name (default: Bangladesh) |
| `phone` | string | Business phone |
| `email` | string | Business email |
| `tax_id` | string | TIN or BIN number for BD merchants |
| `invoice_prefix` | string | Invoice number prefix (default: `INV`) |
| `invoice_footer_text` | string | Freeform footer text |
| `invoice_logo_url` | string | R2 CDN absolute URL for logo |

No schema migration needed — the `settings` table already exists and can store all of these immediately.

### API endpoints to add

Under `apps/api/src/routes/admin/settings/business.ts` (new file, follows same pattern as `site.ts`):

```
GET  /admin/settings/business   — return all business_info settings as typed object
POST /admin/settings/business   — upsert all business_info settings
```

### Admin UI placement

New tab "Business" in `GeneralSettingsPage.tsx`, loaded via `React.lazy()` using the same pattern as other tabs. The form renders all 14 fields using the same Card/Input/Label/Button pattern used by `CurrencySettingsBuilder.tsx`. Logo upload uses the existing media/R2 upload flow (the media route already handles R2 uploads and returns CDN URLs).

---

## Invoice Numbering Strategy

### Requirement

Invoice numbers must auto-increment, be sequential, and have a configurable prefix (e.g., `INV-00142`).

### Approach: dedicated counter in the `settings` table

Do not use SQLite `AUTOINCREMENT` on the `orders` table for invoice numbers. Reasons:
1. `AUTOINCREMENT` on D1 has overhead (it maintains `sqlite_sequence`) and cannot be reset or prefixed
2. Orders may be created and then deleted/trashed — a gap in invoice numbers looks like fraud to auditors
3. Invoice numbers must be assigned at invoice generation time, not order creation time (an order may exist before an invoice is ever printed)

**Recommended pattern: CAS-style counter in `settings` table**

```
category: "invoice_counter"
key:      "current_value"
value:    "142"   (integer as string)
```

When generating a new invoice number:
1. Read current counter value
2. Increment by 1
3. Write back with optimistic concurrency (D1 supports `WHERE value = $old_value` in UPDATE)
4. Format: `${prefix}-${String(newValue).padStart(5, '0')}`

This is a lightweight sequence without a dedicated table. The `settings` table already has a `unique("settings_key_category")` constraint that prevents duplicate rows.

**Alternative considered: `invoice_number` column on `orders` table**

This would require a migration adding `invoice_number INTEGER UNIQUE` to the orders table. It makes querying cleaner but couples invoice numbering to order creation. Rejected because: invoices should be opt-in (not every order may need one), the counter-in-settings approach avoids a schema change for this milestone, and unique integer columns on D1 tables have lock contention under concurrent writes.

**Invoice number assignment timing**

Assign the invoice number the first time `GET /admin/orders/:id/invoice` is called for an order. Store the assigned number on the order row as `invoiceNumber INTEGER`. On subsequent calls, return the same number. This requires one migration (add `invoice_number` column to `orders`).

This is a pragmatic middle ground: the `invoiceNumber` column only exists to remember the assigned number — the counter logic stays in `settings`. The column is nullable; NULL means "no invoice generated yet."

### Migration

```sql
-- 0031_invoice_number.sql
ALTER TABLE orders ADD COLUMN invoice_number INTEGER;
CREATE UNIQUE INDEX orders_invoice_number_idx ON orders (invoice_number) WHERE invoice_number IS NOT NULL;
```

The partial unique index (`WHERE invoice_number IS NOT NULL`) allows multiple NULL values (un-invoiced orders) while enforcing uniqueness among assigned numbers. D1 supports partial indexes.

---

## Print Flow UX

### Button placement

In `OrderViewHeader.tsx`, alongside the existing "Edit Order" button, add a "Print Invoice" button (icon: `Printer` from lucide-react). The button is an anchor tag pointing to `/admin/orders/${order.id}/invoice` with `target="_blank"` — it opens the invoice page in a new tab.

```tsx
<Button variant="outline" size="sm" asChild>
  <a href={`/admin/orders/${order.id}/invoice`} target="_blank">
    <Printer className="h-4 w-4" />
    Print Invoice
  </a>
</Button>
```

Opening in a new tab is deliberate: the merchant stays on the order page while the invoice renders in a separate tab, and can print multiple orders in succession without navigating away.

### Invoice page layout (screen vs print)

The invoice page has two visual states:

**Screen state:** The invoice document is centered on a white card, with a sticky action bar at the top containing "Print" and "Download PDF" buttons. The background is a neutral gray so the invoice looks like a document. The action bar uses `@media print { display: none }` to disappear on print.

**Print state:** Only the invoice document renders. No navigation, no UI chrome. Page size is A4 (210mm x 297mm). The invoice fits on one page for typical orders (up to 10–12 line items); longer orders paginate automatically.

### Print trigger

The "Print" button calls `window.print()`. No library needed.

The "Download PDF" button dynamically imports `html2pdf.js` on click, then calls `html2pdf().from(invoiceElement).save('invoice-INV-00142.pdf')`. The button shows a spinner while the library loads and renders.

```tsx
async function handleDownloadPdf() {
  setLoading(true);
  const { default: html2pdf } = await import('html2pdf.js');
  const element = document.getElementById('invoice-document');
  await html2pdf().set({
    margin: 0,
    filename: `invoice-${invoiceNumber}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
  }).from(element).save();
  setLoading(false);
}
```

`useCORS: true` is required to render the business logo from R2 CDN. The R2 bucket must have CORS configured to allow `dashboard.scalius.com` as an origin — verify this is already configured for the existing image display in the admin.

### Auto-print on page load (optional enhancement)

Some invoice pages auto-trigger the print dialog when the page loads (`window.onload = () => window.print()`). This is a common pattern for POS-style workflows. Recommend making this opt-in via a URL query parameter: `/admin/orders/:id/invoice?autoprint=1`. The merchant can bookmark the "Print Invoice" button URL with `?autoprint=1` for rapid workflow.

---

## Bulk Invoice Approach

Feature #23 from `feature-suggestions.md`: "select multiple orders and download all their invoices as a single PDF or ZIP file."

### Verdict: defer to a separate milestone

Bulk invoice download is significantly more complex than single-invoice printing and is listed as "Good to Have" not "Must Have." The approaches available are:

**Option A: Multi-page PDF via html2pdf.js (client-side)**
- Render all invoice HTML in hidden DOM elements, concatenate into a single multi-page PDF
- Works in browser, no server required
- Limitations: 20+ orders will cause memory pressure; rendering is slow (~2s per invoice); no progress indicator is meaningful
- Verdict: viable for up to 20 orders, fragile for bulk (50+)

**Option B: ZIP of individual PDFs (client-side with JSZip)**
- Generate each invoice PDF individually, collect ArrayBuffers, zip with `jszip` library
- Cleaner UX (download one ZIP, open individual files)
- Same performance limitations as Option A
- Verdict: better UX but same technical ceiling

**Option C: Server-side HTML-to-PDF with external service (future)**
- Send order IDs to a Cloudflare Worker that calls a PDF service (DocRaptor, etc.)
- Returns a ZIP or merged PDF
- Requires external service subscription, adds latency
- Verdict: correct long-term approach for true bulk (100+ orders)

**Recommendation for this milestone:** Implement single-invoice print/download. For bulk, add a "Print All Selected" button on the order list that opens all selected invoice pages as separate tabs (`window.open()` in a loop — browsers may block more than 3 popups, so warn the merchant). Bulk PDF download is a separate milestone item. Do not block v1.0 on this.

---

## CSS Print Optimization

All print CSS goes in the invoice page only — not in the admin global stylesheet. The invoice page is a standalone Astro page that includes its own `<style>` block.

### Key rules

```css
@media print {
  /* Hide all UI chrome */
  .invoice-actions { display: none !important; }

  /* Reset page margins */
  @page {
    size: A4;
    margin: 10mm 12mm 10mm 12mm;
  }

  /* Force white background */
  body { background: white !important; }

  /* Prevent table rows from splitting across pages */
  tr { page-break-inside: avoid; }

  /* Keep totals section with the last table row */
  .invoice-totals { page-break-before: avoid; }

  /* Ensure images print */
  img {
    max-width: 100%;
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }

  /* Remove link underlines and href display */
  a { text-decoration: none !important; }
  a[href]::after { content: none !important; }

  /* Show all content (no truncation) */
  .truncate { overflow: visible !important; white-space: normal !important; }
}
```

### Logo embedding for print

The business logo is stored as an R2 CDN absolute URL (`cloud.scalius.com/...`). In the invoice HTML, use the absolute URL directly in an `<img>` tag. During `window.print()`, the browser re-fetches the image for print — this works as long as the browser has network access (always true for admin users). For `html2pdf.js` with `html2canvas`, `useCORS: true` is required and the R2 bucket must return `Access-Control-Allow-Origin: *` or the specific admin domain.

**Do not** attempt to base64-encode the logo server-side and inline it in the HTML. This would increase page size significantly and is unnecessary given that the admin always has network access.

### Tailwind v4 print utilities

Tailwind v4 supports `print:hidden` and `print:block` utilities. Use these for the action bar: `className="print:hidden"` on the button container. The invoice document itself uses `print:block` if it needs to be shown only on print. Verify that Tailwind v4's JIT compiler includes print variants for the invoice page — since the invoice page is a new Astro route, it will be picked up by the content glob automatically.

---

## Client-Side PDF Option

### Library: html2pdf.js

- **npm package:** `html2pdf.js` (latest: 0.10.1)
- **Bundle size:** ~180 KB minified (includes html2canvas and jsPDF)
- **Load strategy:** Dynamic import only, triggered by "Download PDF" button click
- **Text selectability:** None — output is rasterized image; acceptable for invoices
- **Bengali text support:** Yes, html2canvas renders whatever the browser renders, including Bengali Unicode text with correct shaping

### Alternative: react-to-print

`react-to-print` (npm: `react-to-print`, ~15 KB) is a lightweight library that copies the component to a hidden iframe and calls `window.print()`. It is slightly more reliable than `window.print()` directly for React components because it handles ref-based targeting cleanly. It does NOT produce a PDF download — only triggers the print dialog. This is appropriate for the "Print" button but not the "Download PDF" button.

**Recommendation:** Use `react-to-print` for the Print button (cleaner React integration, avoids full-page `window.print()` that includes the action bar), and `html2pdf.js` for the Download PDF button.

Actually: since the invoice page is a standalone Astro page with no other UI, a plain `window.print()` button works just as well as `react-to-print`. `react-to-print` is more useful when printing a component embedded within a larger page. Given the invoice is a full dedicated page, use `window.print()` directly and save the dependency.

**Final recommendation:** `window.print()` for Print, `html2pdf.js` (dynamic import) for Download PDF. Zero required dependencies added to the base bundle.

---

## DB Schema Changes

### Required: one migration

```sql
-- Migration 0031: Add invoice_number to orders table
ALTER TABLE orders ADD COLUMN invoice_number INTEGER;
CREATE UNIQUE INDEX orders_invoice_number_idx ON orders (invoice_number) WHERE invoice_number IS NOT NULL;
```

**Drizzle schema change** (`packages/database/src/schema/orders.ts`):

```typescript
invoiceNumber: integer("invoice_number"),
// Add to table definition's index array:
uniqueIndex("orders_invoice_number_idx").on(table.invoiceNumber),
// Note: Drizzle doesn't directly express partial indexes; raw SQL migration handles it
```

### Not required: settings table changes

Business info settings use the existing `settings` table with category `"business_info"`. No migration needed.

### Not required: siteSettings changes

Business info is explicitly kept out of `siteSettings` to avoid bloating the singleton row and to keep concerns separated. `siteSettings` holds storefront-visible config; `settings` holds admin/operational config.

---

## Implementation Plan

### Phase breakdown (ordered by dependency)

**Step 1: Business Settings API + Admin UI**
- New file: `apps/api/src/routes/admin/settings/business.ts`
  - `GET /admin/settings/business` — returns `{ companyName, legalName, addressLine1, ... }` using `upsertSetting` pattern
  - `POST /admin/settings/business` — saves all business_info keys
- Register in `apps/api/src/app.ts` under the settings route group
- New component: `apps/admin/src/components/admin/settings/BusinessSettingsBuilder.tsx`
  - Form with all 14 business info fields
  - Logo field uses existing media upload pattern (image picker + R2 URL)
- Add "Business" tab to `GeneralSettingsPage.tsx` tabs array

**Step 2: Migration + Invoice Number Column**
- Run `pnpm db:generate` after adding `invoiceNumber` to Drizzle schema
- Verify migration SQL includes the partial unique index (may need manual SQL addition since Drizzle can't express `WHERE invoice_number IS NOT NULL` via API)

**Step 3: Invoice Service Function**
- New function in `packages/core/src/modules/orders/orders.admin.ts` or a dedicated `orders.invoice.ts`:
  - `getOrAssignInvoiceNumber(db, orderId, prefix)`:
    1. Read `orders.invoiceNumber` for the order — if not null, return it
    2. Read `settings` counter (`invoice_counter / current_value`)
    3. Increment counter, write back (single UPDATE with WHERE guard)
    4. Update `orders.invoiceNumber = newValue`
    5. Return formatted string `${prefix}-${String(newValue).padStart(5, '0')}`
- New function `getBusinessSettings(db)`: reads all `business_info` keys from settings table

**Step 4: Invoice API Endpoint**
- Add to `apps/api/src/routes/admin/orders.ts` (or new `orders-invoice.ts`):
  - `GET /admin/orders/:id/invoice` — returns `{ order: OrderDetails, invoiceNumber: string, businessInfo: BusinessInfo }`
  - This is the data endpoint used by the Astro invoice page loader

**Step 5: Invoice Astro Page**
- New file: `apps/admin/src/pages/admin/orders/[id]/invoice.astro`
  - Uses `AdminLayout` with a custom no-chrome variant, or its own minimal layout
  - Fetches order data and business settings in parallel via API
  - Renders the complete invoice HTML with Tailwind print classes
  - Includes React island for the action bar (Print + Download PDF buttons)
- New React component: `apps/admin/src/components/admin/InvoiceActions.tsx`
  - "Print" button: calls `window.print()`
  - "Download PDF" button: dynamic import of `html2pdf.js`, calls `.save()`
  - Both buttons hidden via `print:hidden`

**Step 6: "Print Invoice" button on order view**
- Edit `apps/admin/src/components/admin/orderview/OrderViewHeader.tsx`
- Add `<Printer />` icon button as anchor to `/admin/orders/${order.id}/invoice` with `target="_blank"`

**Dependencies between steps:**
- Step 1 can be done independently
- Step 2 must come before Step 3
- Step 3 must come before Step 4
- Step 4 must come before Step 5
- Step 5 must come before Step 6

**Steps 1 and 2 can be done in parallel by different engineers.**

### Estimated complexity

| Step | Complexity | Notes |
|------|-----------|-------|
| Business Settings API | Low | Follows existing pattern exactly |
| Business Settings UI | Low | Copy CurrencySettingsBuilder pattern |
| Migration | Low | One column, one index |
| Invoice service | Medium | Counter CAS logic needs care |
| Invoice API endpoint | Low | Composes existing functions |
| Invoice Astro page | Medium | Print CSS, layout, data assembly |
| Invoice React actions | Low | window.print() + html2pdf dynamic import |
| Order view button | Trivial | One line change |

---

## Key Risks and Mitigations

### Risk 1: `totalAmount` ambiguity

The codebase has inconsistent use of `orders.totalAmount`: `OrderViewHeader` uses it as the grand total, while `OrderItemsCard` recomputes `totalAmount + shippingCharge - discountAmount`. The invoice must show the correct grand total. Before implementing the invoice template, read `orders.admin.ts` line 291 (`getOrderDetails`) and verify what `totalAmount` stores in the DB vs what is displayed. If ambiguous, display all three values (subtotal, shipping, discount, grand total) as separate rows and compute grand total explicitly.

**Confidence:** HIGH that this is a real risk — the existing code has this discrepancy and it will surface on invoices.

### Risk 2: html2canvas cross-origin images

The business logo is served from `cloud.scalius.com` (R2). html2canvas with `useCORS: true` requires the image server to return `Access-Control-Allow-Origin` headers. Verify R2 bucket CORS config allows the admin domain. If CORS is not configured, the logo will render as a blank box in the PDF download (but will print correctly via `window.print()`).

### Risk 3: Invoice counter race condition under concurrent prints

Two admin users printing invoices for different orders simultaneously could both read the same counter value and produce duplicate invoice numbers. This is unlikely in a single-tenant admin but must be handled. The CAS-style UPDATE (`WHERE value = $old_value`) mitigates this for D1's serialized writes — D1 processes writes sequentially per database, so true concurrent write conflicts are rare. If a conflict occurs, retry once.

### Risk 4: Bengali product names in html2canvas PDF

html2canvas renders the browser's visual output. Bengali text renders correctly in html2canvas IF the system font is loaded. In a browser context (not headless), system fonts are always available. No risk for `window.print()`. Low risk for html2canvas in interactive browser context.

---

*Sources consulted:*
- [jsPDF HTML to PDF: Client-Side PDF Generation Guide](https://pdfbolt.com/blog/generate-html-to-pdf-with-jspdf)
- [HTML to PDF in JavaScript: 5 libraries compared](https://www.nutrient.io/blog/html-to-pdf-in-javascript/)
- [html2pdf.js official documentation](https://ekoopmans.github.io/html2pdf.js/)
- [CSS Print Media Queries: Complete Guide](https://codelucky.com/css-print-media-queries/)
- [Printing - CSS | MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Media_queries/Printing)
- [react-to-print npm](https://www.npmjs.com/package/react-to-print)
- [SQLite AUTOINCREMENT documentation](https://sqlite.org/autoinc.html)
- [Bangla Web Fonts CDN](https://fonts.maateen.me/)
