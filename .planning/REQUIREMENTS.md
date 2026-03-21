# Requirements: Scalius Commerce v1.0 — BD Market Readiness

**Defined:** 2026-03-22
**Core Value:** BD merchants can manage their entire e-commerce operation from a single platform optimized for the BD market

## v1 Requirements

Requirements for milestone v1.0. Each maps to roadmap phases.

### Invoice Printing

- [ ] **INV-01**: Merchant can view a clean, printable invoice from any order's detail page
- [ ] **INV-02**: Invoice displays business name, logo, address, tax ID (TIN/BIN), and configurable footer text
- [ ] **INV-03**: Invoice displays order items with name, SKU, quantity, unit price, line total, and discount breakdown
- [ ] **INV-04**: Invoice displays totals section: subtotal, shipping charge, discount, and grand total
- [x] **INV-05**: Invoice numbers auto-increment with a configurable prefix (e.g., INV-00001)
- [ ] **INV-06**: Merchant can print the invoice via browser print dialog (window.print)
- [ ] **INV-07**: Merchant can download the invoice as a PDF file via one-click button

### Business Information Settings

- [x] **BIZ-01**: Merchant can configure business details (company name, legal name, address, phone, email) from admin settings
- [x] **BIZ-02**: Merchant can upload a business logo that appears on invoices and structured data
- [x] **BIZ-03**: Merchant can set tax registration details (TIN/BIN number, tax label)
- [x] **BIZ-04**: Merchant can configure invoice-specific settings (number prefix, footer text)
- [x] **BIZ-05**: Business information feeds into invoice header, email footers, and Organization JSON-LD

### Storefront SEO — Structured Data

- [x] **SEO-01**: Product pages output JSON-LD Product schema with name, description, image, price, currency, availability, and SKU
- [x] **SEO-02**: Product pages output JSON-LD BreadcrumbList schema matching the visible breadcrumb navigation
- [x] **SEO-03**: Category pages output JSON-LD CollectionPage schema with name, description, and item count
- [x] **SEO-04**: Category pages output JSON-LD BreadcrumbList schema
- [x] **SEO-05**: All pages output JSON-LD Organization schema using business settings (name, logo, contact info)
- [x] **SEO-06**: Homepage outputs JSON-LD WebSite schema with SearchAction for Google Sitelinks Search Box

### Storefront SEO — Social Cards

- [x] **OG-01**: Product pages output Open Graph meta tags (og:title, og:description, og:image, og:url, og:type=product, og:price:amount, og:price:currency)
- [x] **OG-02**: Category pages output Open Graph meta tags with category name, description, and representative image
- [x] **OG-03**: CMS pages output Open Graph meta tags with page title, description, and featured image
- [x] **OG-04**: All pages output Twitter Card meta tags (summary_large_image card type)
- [x] **OG-05**: OG images are served as 1200x630 JPEG via Cloudflare Image Resizing (WhatsApp/Facebook compatible)

### Storefront SEO — Canonical URLs

- [x] **CAN-01**: Every page outputs a canonical URL tag pointing to its clean URL (no query parameters)
- [x] **CAN-02**: Canonical URLs use the runtime storefront URL from settings (not hardcoded)

### SMS OTP Providers

- [x] **SMS-01**: Merchant can select SMS OTP as the customer verification method in Auth & Access settings
- [x] **SMS-02**: When SMS OTP is selected, merchant can choose from available SMS providers (SMS.net.bd, BDBulkSMS, MIM SMS, Gennet iSMS)
- [x] **SMS-03**: Each SMS provider has its own credential fields shown conditionally when selected (API keys, tokens, sender IDs)
- [x] **SMS-04**: SMS provider credentials are stored encrypted (AES-GCM) in the database, consistent with existing credential handling
- [x] **SMS-05**: Customer receives OTP via SMS when signing up or logging in with SMS OTP enabled
- [x] **SMS-06**: SMS provider settings UI follows the same pattern as WhatsApp settings in Auth & Access (conditional card, masked credentials, status indicator)
- [x] **SMS-07**: SMS delivery errors are logged and surfaced to the merchant (not silently swallowed)

### Bengali Text Search

- [ ] **BEN-01**: Customers can search for products using Bengali text and get accurate results
- [ ] **BEN-02**: Admin can search products, categories, customers, and pages using Bengali text
- [ ] **BEN-03**: Bengali search works alongside English search without degradation
- [x] **BEN-04**: FTS5 tokenizer is configured to preserve Bengali syllable integrity (vowel signs not split from consonants)

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Invoice Enhancements

- **INV-V2-01**: Merchant can bulk-download invoices for multiple selected orders
- **INV-V2-02**: Invoice template is customizable (colors, layout, additional fields)
- **INV-V2-03**: Invoice supports tax breakdown display (when tax system is implemented)

### SEO Enhancements

- **SEO-V2-01**: Google Shopping product feed (Google Merchant Center format)
- **SEO-V2-02**: Product pages include variant-level JSON-LD Offer arrays
- **SEO-V2-03**: FAQ structured data for CMS pages

### SMS Enhancements

- **SMS-V2-01**: SMS delivery receipts tracked and displayed in admin
- **SMS-V2-02**: SMS used for order status notifications (not just OTP)
- **SMS-V2-03**: SMS template customization per notification type

## Out of Scope

| Feature | Reason |
|---------|--------|
| Server-side PDF generation | Impossible on Cloudflare Workers (no Puppeteer/Node.js APIs) |
| Multi-language admin interface | Large i18n effort, not blocking BD merchants |
| bKash/Nagad direct integration | Requires payment gateway partnership; SSLCommerz covers these |
| Tax/VAT calculation system | Separate milestone; invoice template will have placeholder for future tax |
| Product reviews/ratings | Separate feature milestone |
| Trigram tokenizer as primary | Only used as fallback if unicode61 categories option fails on D1 |
| Bulk invoice as ZIP/PDF merge | Deferred to v2; single-invoice print/download is v1 scope |
| og:locale / hreflang tags | Single-language deployment; defer to i18n milestone |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| BEN-01 | Phase 1: Bengali FTS5 Search | Pending |
| BEN-02 | Phase 1: Bengali FTS5 Search | Pending |
| BEN-03 | Phase 1: Bengali FTS5 Search | Pending |
| BEN-04 | Phase 1: Bengali FTS5 Search | Complete |
| SEO-01 | Phase 2: Storefront SEO | Complete |
| SEO-02 | Phase 2: Storefront SEO | Complete |
| SEO-03 | Phase 2: Storefront SEO | Complete |
| SEO-04 | Phase 2: Storefront SEO | Complete |
| SEO-05 | Phase 2: Storefront SEO | Complete |
| SEO-06 | Phase 2: Storefront SEO | Complete |
| OG-01 | Phase 2: Storefront SEO | Complete |
| OG-02 | Phase 2: Storefront SEO | Complete |
| OG-03 | Phase 2: Storefront SEO | Complete |
| OG-04 | Phase 2: Storefront SEO | Complete |
| OG-05 | Phase 2: Storefront SEO | Complete |
| CAN-01 | Phase 2: Storefront SEO | Complete |
| CAN-02 | Phase 2: Storefront SEO | Complete |
| SMS-01 | Phase 3: SMS OTP Providers | Complete |
| SMS-02 | Phase 3: SMS OTP Providers | Complete |
| SMS-03 | Phase 3: SMS OTP Providers | Complete |
| SMS-04 | Phase 3: SMS OTP Providers | Complete |
| SMS-05 | Phase 3: SMS OTP Providers | Complete |
| SMS-06 | Phase 3: SMS OTP Providers | Complete |
| SMS-07 | Phase 3: SMS OTP Providers | Complete |
| INV-01 | Phase 4: Invoice & Business Settings | Pending |
| INV-02 | Phase 4: Invoice & Business Settings | Pending |
| INV-03 | Phase 4: Invoice & Business Settings | Pending |
| INV-04 | Phase 4: Invoice & Business Settings | Pending |
| INV-05 | Phase 4: Invoice & Business Settings | Complete |
| INV-06 | Phase 4: Invoice & Business Settings | Pending |
| INV-07 | Phase 4: Invoice & Business Settings | Pending |
| BIZ-01 | Phase 4: Invoice & Business Settings | Complete |
| BIZ-02 | Phase 4: Invoice & Business Settings | Complete |
| BIZ-03 | Phase 4: Invoice & Business Settings | Complete |
| BIZ-04 | Phase 4: Invoice & Business Settings | Complete |
| BIZ-05 | Phase 4: Invoice & Business Settings | Complete |

**Coverage:**
- v1 requirements: 28 total
- Mapped to phases: 28
- Unmapped: 0

---
*Requirements defined: 2026-03-22*
*Last updated: 2026-03-22 after roadmap creation*
