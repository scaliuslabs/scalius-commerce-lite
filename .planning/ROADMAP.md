# Roadmap: Scalius Commerce v1.0 — BD Market Readiness

## Overview

Close four critical feature gaps identified in the 7-agent codebase audit that block BD merchant adoption: Bengali text search (broken FTS5 tokenizer), storefront SEO (no structured data or social cards), SMS OTP delivery (stubbed, not functional), and invoice printing (nonexistent). The four features are independent workstreams with minimal cross-cutting dependencies, sequenced to surface the highest-risk item (D1 FTS5 compatibility) first and save the most internally complex item (invoice with business settings) for last.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Bengali FTS5 Search** - Fix FTS5 tokenizer to support Bengali script across all search surfaces
- [ ] **Phase 2: Storefront SEO** - Add JSON-LD structured data, Open Graph/Twitter Card meta tags, and canonical URLs to all storefront pages
- [ ] **Phase 3: SMS OTP Providers** - Integrate BD SMS gateways for customer OTP delivery with encrypted credential storage
- [ ] **Phase 4: Invoice & Business Settings** - Enable invoice printing from order pages with configurable business information

## Phase Details

### Phase 1: Bengali FTS5 Search
**Goal**: Customers and admins can search in Bengali and get accurate results
**Depends on**: Nothing (first phase)
**Requirements**: BEN-01, BEN-02, BEN-03, BEN-04
**Success Criteria** (what must be TRUE):
  1. Customer can search for a product by its Bengali name on the storefront and see correct results
  2. Admin can search products, categories, customers, and pages using Bengali text in the admin dashboard
  3. Searching in English continues to return correct results with no degradation
  4. Bengali vowel signs remain attached to their consonants in search results (no syllable splitting)
**Plans**: 2 plans

Plans:
- [x] 01-01-PLAN.md — Create Bengali FTS5 tokenizer migration and harden query sanitizer
- [ ] 01-02-PLAN.md — Validate migration on local D1 and verify Bengali + English search

### Phase 2: Storefront SEO
**Goal**: Storefront pages are discoverable by search engines and shareable on social platforms with rich previews
**Depends on**: Nothing (runs concurrently with Phase 1)
**Requirements**: SEO-01, SEO-02, SEO-03, SEO-04, SEO-05, SEO-06, OG-01, OG-02, OG-03, OG-04, OG-05, CAN-01, CAN-02
**Success Criteria** (what must be TRUE):
  1. Google Rich Results Test validates JSON-LD Product structured data on any product page
  2. Facebook Sharing Debugger shows correct title, description, image, and price when a product URL is pasted
  3. WhatsApp link preview displays a 1200x630 JPEG image when a product URL is shared
  4. Every storefront page has a canonical URL tag using the runtime storefront URL from settings
  5. Homepage includes WebSite JSON-LD with SearchAction for Google Sitelinks Search Box
**Plans**: 2 plans

Plans:
- [ ] 02-01-PLAN.md — Layout.astro SEO infrastructure: extended Props, canonical URL, OG tags, Twitter Cards, Organization + WebSite JSON-LD
- [ ] 02-02-PLAN.md — Per-page SEO: Product + BreadcrumbList JSON-LD, CollectionPage JSON-LD, OG props for all four page types

### Phase 3: SMS OTP Providers
**Goal**: Merchants can enable SMS-based customer verification using BD SMS gateways
**Depends on**: Nothing (can run concurrently with Phase 2)
**Requirements**: SMS-01, SMS-02, SMS-03, SMS-04, SMS-05, SMS-06, SMS-07
**Success Criteria** (what must be TRUE):
  1. Merchant can select "SMS OTP" as the verification method and choose a provider in Auth & Access settings
  2. Each provider shows its own credential fields (API key, token, sender ID) when selected
  3. Customer receives an actual SMS with OTP code when signing up or logging in with SMS OTP enabled
  4. SMS delivery failures are logged and visible to the merchant (not silently swallowed)
  5. Provider credentials are stored encrypted and displayed masked in the settings UI
**Plans**: 2 plans

Plans:
- [ ] 03-01-PLAN.md — Core SMS provider interface, registry, 4 BD provider implementations, encrypted settings service
- [ ] 03-02-PLAN.md — API endpoints, queue consumer dispatch, notification service SMS, admin UI provider configuration

### Phase 4: Invoice & Business Settings
**Goal**: Merchants can print invoices for orders with their business branding and sequential numbering
**Depends on**: Nothing (can run concurrently with Phase 3; business settings also feed Phase 2's Organization JSON-LD if Phase 2 completes first)
**Requirements**: INV-01, INV-02, INV-03, INV-04, INV-05, INV-06, INV-07, BIZ-01, BIZ-02, BIZ-03, BIZ-04, BIZ-05
**Success Criteria** (what must be TRUE):
  1. Merchant can open any order's detail page and click "Print Invoice" to see a clean, printable invoice
  2. Invoice displays the merchant's configured business name, logo, address, and tax ID (TIN/BIN)
  3. Invoice shows all order items with SKU, quantity, unit price, line total, and a correct grand total
  4. Invoice numbers auto-increment with the merchant's configured prefix (e.g., INV-00001)
  5. Merchant can download the invoice as a PDF file via a one-click button
**Plans**: TBD

Plans:
- [ ] 04-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4
(Phases 1+2 can run concurrently. Phases 3+4 can also run concurrently.)

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Bengali FTS5 Search | 0/2 | Planning complete | - |
| 2. Storefront SEO | 0/2 | Planning complete | - |
| 3. SMS OTP Providers | 0/2 | Planning complete | - |
| 4. Invoice & Business Settings | 0/0 | Not started | - |
