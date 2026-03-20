# Deep-Read Codebase Audit — Full Report

**Date:** 2026-03-20
**Method:** 15 Sonnet 4.6 agents read every line of every source file (919 files)
**Each agent rated:** Maintainability, Scalability, Reliability, Robustness, Performance, LLM-friendliness (1-10)

---

## Final Confidence Assessment

| Dimension | Score | Summary |
|---|---|---|
| **Architecture** | **8/10** | Monorepo, layer separation, service bindings, queue processing, SDK pipeline — genuinely well-designed |
| **Maintainability** | **6/10** | Consistent patterns, good naming. 22+ `as any`, `Record<string,unknown>` proliferation, duplicated boilerplate |
| **Scalability** | **5/10** | Edge caching excellent. N+1 in 5+ places, full-table-scan pagination, rate-limit broken |
| **Reliability** | **4/10** | 50+ verified bugs including 3 production-crashing, 6 security, 8 data-corruption |
| **Robustness** | **5/10** | Good HTTP-boundary error handling. Inner layers silently swallow errors |
| **Performance** | **6/10** | L1+L2 cache strong. N+1 loaders, sequential inserts, O(n*m) AI context |
| **Security** | **5/10** | XSS, JWT default secret, broken rate-limit, CSP weakened |
| **LLM-friendliness** | **7/10** | Clear naming, consistent patterns, good CLAUDE.md. `z.any()` schemas reduce it |
| **Overall** | **6/10** | Solid foundation, scattered execution gaps |

---

## Critical Bugs (Production-Crashing) — Fix Immediately

| # | File | Line | Issue |
|---|---|---|---|
| 1 | `admin/orders-status.ts` | ~117 | `require()` in ESM Worker — will throw `require is not defined` |
| 2 | `storefront/pages/health.ts` | — | `process.memoryUsage()` — Node API, crashes in Workers |
| 3 | `database/schema/inventory.ts` | 18 | `notNull()` + `onDelete: "set null"` contradiction — D1 constraint error on variant deletion |

## Security Bugs — Fix Before Next Deploy

| # | File | Line | Issue |
|---|---|---|---|
| 4 | `middleware/auth.ts` + `admin-auth.ts` | 50,56 / 47,50 | `verifyToken`/`refreshTokenIfNeeded` called without `env` — falls back to default JWT secret |
| 5 | `storefront/account.astro` | 199-212 | XSS — unescaped user data in `innerHTML` (order address, product image) |
| 6 | `storefront/buy/[slug].ts` | 153-154 | XSS — unescaped product name/image in HTML template |
| 7 | `core/auth/auth.ts` + email templates | 58-76 | HTML injection via unsanitized `user.name` in all email templates |
| 8 | `shared/rate-limit.ts` | entire | Fundamentally broken: in-memory Map, setInterval doesn't fire, IP from spoofable `x-forwarded-for` |
| 9 | `middleware-helper/csp-handler.ts` | 48 | `process.env.CSP_ALLOWED` bakes dev values into production bundle |
| 10 | `middleware-helper/csp-handler.ts` | 151-152 | `localhost:*` hardcoded in production CSP with no env guard |

## Data Corruption Bugs — Fix This Week

| # | File | Issue |
|---|---|---|
| 11 | `orders.admin.ts:748-776` | `updateOrder` deducted-path produces phantom stock (item matching uses quantity equality) |
| 12 | `orders.queue.ts:251-303` | Phase 1b discount rejection doesn't remove write statements — rejected orders still inserted |
| 13 | `refund-service.ts:304-314` | `processReturn` inventory + status in separate writes (crash = ghost state) |
| 14 | `site-settings.service.ts:178` | `saveSeoSettings` passes `undefined` to Drizzle `.set()` — NULLs existing SEO data |
| 15 | `customer-auth.service.ts:349` | Customer ID format split: `nanoid()` vs `cust_` prefix |
| 16 | `storefront/runtime-env.ts:17-22` | Module-level state NOT request-isolated — race condition |
| 17 | `storefront/AuthModal.tsx:434` | Reuses `phoneInput` for email — data loss on phone-method signup |
| 18 | `useProductSubmit.ts:106` | New product redirect to `/undefined/edit` (raw envelope, no unwrapEnvelope) |
| 19 | `CheckoutFlowSettings.tsx:40,61` | Checkout settings posted to auth endpoint — wrong API, silent data loss |

## Silent Failures — Fix Soon

| # | File | Issue |
|---|---|---|
| 20 | `dashboard.service.ts:40-51` | Cancelled-count always zero (WHERE excludes cancelled but SELECT counts them) |
| 21 | `admin/ai-context.ts:84` | `c.get("env")?.CACHE` wrong — should be `c.env.CACHE` — AI caching silently disabled |
| 22 | Widget history UI | Entirely dead code — API endpoints exist but UI calls wrong paths |
| 23 | `queue-consumer.ts:330-337` | Polar refund failures silently acked — no retry |
| 24 | `tracking.ts:122-124` | `updateOrderStatusFromShipment` swallows all errors silently |
| 25 | `admin-auth.ts:113-117` | Logic flaw — `userPerms.size > 0` grants admin gate to ANY permissioned user |
| 26 | `jwt.ts:113-129` | `refreshTokenIfNeeded` decodes without verifying — could re-sign forged token |
| 27 | `collections.service.ts:283` | `noopQuery` returns `{id: null}` instead of null — `enrichProduct` called with garbage |

## Scalability Issues

| # | File | Issue |
|---|---|---|
| 28 | `attributes.service.ts:254-361` | `listAttributeValues` loads ALL rows into memory, paginates in JS |
| 29 | `admin/orders.ts:492-503` | N+1: fetches all products, then 1 variant query per product |
| 30 | `admin/ai-context.ts:139-161` | O(products × variants) DB/KV calls |
| 31 | `admin/rbac.ts:154-158` | Sequential permission inserts in for loop (not batched) |
| 32 | `admin/collections.ts:52-62` | Unbounded product fetch (no limit) for form options |
| 33 | `schema/inventory.ts:18` | `notNull()` + `onDelete: "set null"` — blocks variant deletion |
| 34 | `schema/marketing.ts:55` | `discounts.code` not unique — race can create duplicates |
| 35 | `schema/products.ts:97` | `productVariants.sku` not unique — scanner lookups can return wrong variant |

## Architecture Strengths (Preserve These)

1. **Response envelope consistency** — `ok()`/`created()` used 271 times across 59 route files
2. **Error class hierarchy** — clean `ApiError` classes, 274 usages
3. **Import boundaries** — storefront has zero imports from `@scalius/core` or `@scalius/database`
4. **Two-layer storefront cache** — L1 in-memory + L2 Cloudflare Cache API + KV versioning
5. **Queue architecture** — proper DLQ, retry, batch processing for order ingest
6. **Atomic payment processing** — `db.batch()` for payment + order + inventory
7. **SDK pipeline** — OpenAPI schemas → generated types → client factory
8. **File naming consistency** — `{domain}.service.ts`, `{domain}.validation.ts`
9. **Middleware chain** — correct ordering with single-responsibility per middleware
10. **Dev experience** — one-command setup, zombie cleanup, staggered ports

---

*Generated by 15 Sonnet 4.6 deep-read agents on 2026-03-20*
*Individual agent transcripts available in /private/tmp/claude-501/ task output files*
