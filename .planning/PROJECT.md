# Scalius Commerce

## What This Is

A full-stack e-commerce platform (Astro SSR admin + storefront + Hono API on Cloudflare Workers) targeting Bangladeshi medium-to-large merchants as the primary market, with global expansion as a secondary goal. 235K lines of hand-written code across a Turborepo monorepo with 52 database tables, 245 API endpoints, and production-grade inventory/payment/delivery systems.

## Core Value

Bangladeshi merchants can manage their entire e-commerce operation — products, orders, payments, delivery, customers — from a single platform optimized for the BD market (COD, SSLCommerz, Pathao/Steadfast, phone-first customers, BDT currency).

## Current Milestone: v1.0 BD Market Readiness

**Goal:** Close the critical feature gaps identified in the 7-agent codebase audit that block BD merchant adoption.

**Target features:**
- Invoice/receipt printing for COD order processing
- Storefront SEO (JSON-LD structured data, Open Graph/Twitter Card meta tags)
- SMS provider integration for OTP delivery
- Bengali text search via FTS5 tokenizer configuration

## Requirements

### Validated

<!-- Shipped and confirmed valuable. Inferred from existing codebase. -->

- Product management with variants, images, attributes, barcode support
- Order lifecycle with state machine, COD tracking, partial payments
- Inventory management with CAS locking, three pools (regular/preorder/backorder)
- Payment gateways: Stripe, SSLCommerz, Polar, COD
- Delivery providers: Pathao, Steadfast with webhook tracking
- Customer auth: email/password, WhatsApp OTP, phone normalization (E.164)
- Admin dashboard with RBAC (84 permissions), analytics, dark mode
- Storefront with L1+L2 caching, checkout, cart, product browsing
- Content management: pages, widgets (with AI generation), navigation, hero sliders
- SDK: 245 paths, 27K+ types, dual-transport (service binding + HTTP)
- OpenAPI-first API with Zod validation on all routes

### Active

<!-- Current scope. Building toward these. -->

- [ ] Invoice/receipt printing for merchants
- [ ] JSON-LD structured data on product and category pages
- [ ] Open Graph and Twitter Card meta tags
- [ ] SMS OTP provider integration
- [ ] Bengali text search (FTS5 unicode61/trigram tokenizer)

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- bKash/Nagad direct integration — Requires payment gateway partnership agreements; SSLCommerz covers these as sub-options for now
- Multi-language admin interface — Large i18n effort, not blocking BD merchants who use English admin
- Multi-currency product pricing — Single-currency (BDT) sufficient for BD market
- Tax/VAT system — BD e-commerce tax enforcement is minimal; defer to global expansion milestone
- Product reviews/ratings — Important but separate feature milestone
- Multi-tenant/multi-store — Single-tenant sufficient for current deployment model
- GDPR compliance — Not required for BD market; defer to global milestone

## Context

- **Codebase state:** 235,644 lines hand-written code, 1,035 files, 31 migrations
- **Audit scores:** Code Quality 7.6, Maintainability 8.0, Performance 7.5, BD Features 7.8, Global 5.0
- **Branch:** `mono-repo` (2 commits ahead of `cloudflare-only`)
- **Tech stack:** Astro 6, React 19, Hono, Cloudflare D1/KV/R2/Queues, Drizzle ORM, Tailwind v4, shadcn/ui
- **BD market context:** COD is ~80% of transactions, phone-first customers, Facebook-driven traffic, Pathao/Steadfast are dominant couriers
- **Critical audit finding:** SMS OTP is stubbed (queue consumer logs only), Bengali FTS5 search is broken with default tokenizer, no JSON-LD or OG tags on storefront, no invoice printing

## Constraints

- **Platform:** Cloudflare Workers — no Node.js APIs, 128MB memory limit, 30s CPU time
- **Database:** D1 (SQLite) — no stored procedures, limited concurrent writes, FTS5 available
- **Rendering:** SSR via Astro — server-rendered HTML, React islands for interactivity
- **PDF generation:** No native PDF support on Workers — must use HTML-based or external service approach
- **SMS providers:** BD market uses Twilio alternatives (BulkSMSBD, sms.net.bd, Infobip) — need provider abstraction

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| HTML-based invoices over PDF | CF Workers lack PDF libraries; HTML print via `window.print()` is simpler and sufficient | -- Pending |
| FTS5 unicode61 tokenizer | Better Bengali text segmentation than default ASCII tokenizer | -- Pending |
| SMS provider registry pattern | Match existing email/payment provider pattern for extensibility | -- Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-03-22 after initial milestone definition*
