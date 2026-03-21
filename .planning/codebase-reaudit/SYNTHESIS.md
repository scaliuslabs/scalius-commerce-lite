# Codebase Re-Audit Synthesis

**Date:** 2026-03-21
**Scope:** 25 agents re-audited all domains after the 8-agent fix session
**Comparison against:** `.planning/codebase-audit/` (pre-fix baseline)

---

## Overall Score: 6.6/10 (was ~6.0/10)

The fix session improved security posture significantly and resolved the two most critical systemic patterns (z.any() and err.statusCode). However, many lower-priority issues remain, and several fixes introduced new issues.

---

## Domain Scorecard

| Domain | Before | After | Delta | Fixed | Still Open | New Issues |
|--------|--------|-------|-------|-------|------------|------------|
| API Framework | 7.5 | **8.5** | +1.0 | 5 | 8 | 3 |
| Storefront Infra | ~6 | **8.0** | +2.0 | 6 | 4 | 4 |
| Shared/Search | ~7 | **8.0** | +1.0 | 3 | 20 | 0 |
| Cross-cutting | 8.0 | **8.5** | +0.5 | 2 systemic | 1 systemic | 0 |
| Payments | ~6 | **7.5** | +1.5 | 4 | 16 | 6 |
| Database | ~7 | **7.5** | +0.5 | 2 | 5 | 2 |
| Attributes | ~5.5 | **7.5** | +2.0 | 6 | 15 | 4 |
| Customers | ~6.5 | **7.5** | +1.0 | 2 | 16 | 6 |
| Products | ~6 | **7.0** | +1.0 | 3 | 15 | 4 |
| Collections | ~5.5 | **7.0** | +1.5 | 5 | 14 | 3 |
| Inventory | ~5.5 | **7.0** | +1.5 | 7 | 13 | 5 |
| Auth | ~5.5 | **7.0** | +1.5 | 3 | ~10 | 0 |
| Pages | ~5 | **7.0** | +2.0 | 6 | 10 | 4 |
| Admin Infra | ~6 | **7.0** | +1.0 | 4 | 6 | 6 |
| Widgets | ~5 | **6.5** | +1.5 | 7 | 15 | 3 |
| Categories | ~5.5 | **6.5** | +1.0 | 4 | 17 | 6 |
| Orders | ~6 | **6.0** | 0 | 0 | 25 | 5 |
| Discounts | ~5 | **6.0** | +1.0 | 7 | 9 | 6 |
| Storefront Module | ~5 | **6.0** | +1.0 | 2 | 10 | 3 |
| Notifications | 5 | **6.0** | +1.0 | ~3 | ~12 | 7 |
| Media | ~5 | **5.5** | +0.5 | 3 | 21 | 7 |
| Delivery | ~5 | **5.0** | 0 | 3 | 18 | 4 |
| Analytics/AI/Fraud | ~5 | **5.0** | 0 | 1 | 18 | 5 |
| Navigation | ~4 | **5.0** | +1.0 | 0 | all | dead code added |
| Settings | ~4 | **4.0** | 0 | 2 | 19 | 6 |

---

## Systemic Patterns Status

| # | Pattern | Before | After | Status |
|---|---------|--------|-------|--------|
| P1 | Timestamp Corruption (`new Date()` in services) | CRITICAL | IMPROVED | Fixed in 4 domains, but `new Date()` still in 6 places in settings routes |
| P2 | Response Envelope Double-Wrapping | CRITICAL | STILL OPEN | 50+ service functions still return `success: true` |
| P3 | Thin HTTP Layer (inline DB in routes) | OPEN | IMPROVED | 3 public routes extracted (categories, attributes, pages), but navigation and settings still inline |
| P4 | `z.any()` in OpenAPI Schemas | BLOCKING | **RESOLVED** | Replaced in 37 route files, only 2 remain (binary content - correct) |
| P5 | `err.statusCode` vs `err.status` | OPEN | **RESOLVED** | 15 broken catch blocks removed |
| P6 | Empty Array Guards for `inArray()` | OPEN | IMPROVED | Added in products, categories, collections, widgets; not all domains |

---

## Critical Issues Introduced by Fixes

1. **Widget XSS sanitization not wired** — Sanitization functions created in `widgets.service.ts` but public routes bypass them (still serve raw HTML)
2. **Category public service exposes deleted categories** — `getPublicCategoryBySlug` doesn't filter `deletedAt`
3. **Notification channel preferences non-functional** — API returns flat record, UI expects `{ channels: ... }` wrapper
4. **Notification tracking ID on wrong field** — `trackingId` placed incorrectly in enqueue call
5. **Navigation service is dead code** — 6 functions + 4 validation schemas created but no route uses them
6. **Delivery credential encryption regression** — Missing `encryptionKey` parameter in provider update route
7. **`timestamps.ts` and `html-sanitize.ts` have zero consumers** — Created but never imported

---

## Top Performing Domains (7.5+)

1. **API Framework (8.5)** — z.any() eliminated, duplicate error handler removed, typed errors
2. **Cross-cutting (8.5)** — 2 of 6 systemic patterns fully resolved
3. **Storefront Infra (8.0)** — ALS migration, typed unwrap, cart fix, dead code removal
4. **Shared/Search (8.0)** — SQL injection fixed, dead modules cleaned

## Domains Needing Most Work (5 or below)

1. **Settings (4.0)** — 7 routes with inline DB, unencrypted tokens, notification feature broken
2. **Navigation (5.0)** — All new code is dead code, original issues remain
3. **Delivery (5.0)** — Credential encryption regression, dual provider interfaces
4. **Analytics/AI/Fraud (5.0)** — Only 1 of 20 issues fixed
5. **Media (5.5)** — Non-atomic delete still open, hook extraction introduced bugs

---

## Fix Session Effectiveness

- **Total previous findings:** ~400
- **Verified FIXED:** ~85 (21%)
- **Verified PARTIALLY FIXED:** ~15 (4%)
- **Still Open:** ~245 (61%)
- **New Issues Introduced:** ~55 (14%)
- **Net improvement:** +0.6 average score across 25 domains

## Key Takeaway

The fix session was most effective at **security hardening** (JWT, XSS, SQL injection, webhook auth) and **SDK readiness** (z.any() elimination). It was least effective at **settings**, **navigation**, **analytics**, and **orders** — domains where the fixes were either incomplete or didn't land. Several fixes created new issues because the fix agents didn't wire their changes into the consuming code (routes calling new services, sanitization applied to actual endpoints).
