# Performance & Scalability Audit

## Executive Summary

The codebase runs on **Cloudflare Workers + D1 (SQLite)** with **Cloudflare KV** for caching. This architecture imposes hard constraints (D1 row limits, 128MB Worker memory, 30s CPU time, KV eventual consistency) that the codebase largely respects. The team has made strong architectural choices: batched D1 queries, KV-based response caching on storefront routes, queue-based order processing, and proper database indexing. However, several significant performance gaps exist -- particularly N+1 query patterns in bulk operations, unbounded result sets in feed/sitemap generators, missing pagination on some admin queries, and the absence of any performance monitoring infrastructure. The codebase is well-suited for low-to-medium traffic (sub-10k orders/day) but would need targeted fixes for the next order of magnitude.

---

## Bottleneck Inventory

| # | Location | Type | Severity | Impact |
|---|----------|------|----------|--------|
| 1 | `orders.admin.ts:bulkDeleteOrders` (L884-902) | N+1 query loop | **HIGH** | Sequential per-order DB reads + inventory ops inside a for-loop; bulk delete of 50 orders = 50+ sequential queries |
| 2 | `orders.admin.ts:updateOrder` (L760-780) | N+1 variant reads | **HIGH** | Per-variant sequential `select().from(productVariants)` inside a for-loop when inventory is "deducted"; editing an order with 10 variants = 10+ sequential queries |
| 3 | `sitemap-products.xml.ts` + `facebook-feed.xml.ts` | Unbounded product fetch | **HIGH** | Fetches up to 5000 products by making 50 sequential API calls in batches of 5; generates massive XML payloads in-memory on a single Worker (128MB limit) |
| 4 | `discounts.service.ts:listDiscounts` (L64-101) | Sequential secondary queries | **MEDIUM** | After paginated list, 3 additional unbatched queries (products, collections, usage) for all discount IDs on the page |
| 5 | `customers.service.ts:listCustomers` (L111-122) | Post-query location enrichment | **MEDIUM** | After paginated customer list, fetches all location names in a separate query; not batched with the main query |
| 6 | `orders.admin.ts:listOrders` (L99-106) | Count query not batched | **MEDIUM** | Count query runs as a separate await before the data query, doubling round-trips |
| 7 | `dashboard.service.ts:getDailyActivityData` (L140-211) | Two separate group-by queries | **MEDIUM** | Daily orders and daily customers are separate queries instead of a single query; 90-day window generates a 91-element array with date-fill logic |
| 8 | `collections.service.ts:listCollections` (L54-58) | Count query not batched | **LOW** | Count runs separately from data query |
| 9 | `media.service.ts:uploadMediaFiles` (L63-122) | Sequential file uploads with sleep | **LOW** | Files uploaded one-at-a-time within each batch of 5, with 100ms sleep between batches |
| 10 | `media.service.ts:listMediaFolders` (L181) | Unbounded folder list | **LOW** | `select().from(mediaFolders)` with no limit or pagination; safe for small folder counts but no guardrail |
| 11 | `analytics.service.ts:listAnalyticsScripts` (L31) | Unbounded list | **LOW** | `select().from(analytics)` with no limit; analytics scripts are typically few but no guardrail |
| 12 | `kv-cache.ts:deleteCacheByPattern` (L195-236) | KV list pagination loop | **LOW** | Iterates all KV keys with a given prefix and deletes one-by-one; acceptable for moderate key counts but scales linearly |
| 13 | `widget.service.ts:listWidgets` (L37-69) | Two separate queries | **LOW** | Widgets + collections fetched sequentially instead of batched |
| 14 | `getCustomerOrders` (L383-396) | Correlated subquery for images | **LOW** | Uses `SELECT url FROM product_images WHERE ... LIMIT 1` as a scalar subquery per order item; acceptable but could be a join |

---

## Ratings

| Dimension | Score | Justification |
|-----------|-------|---------------|
| **Maintainability** | 7/10 | Consistent service layer patterns, clear module boundaries, but no performance profiling infrastructure or query logging |
| **Robustness** | 6/10 | Queue retry with backoff is solid; inventory reservation + rollback is well-designed; but no request timeouts, no circuit breakers on external calls (WhatsApp, Steadfast), and bulk operations lack chunking limits |
| **Code Quality** | 7/10 | Good use of `db.batch()` for D1, `Promise.all` for parallel reads, and `Map` for enrichment; admin React components use `useMemo`/`useCallback` (128 occurrences); but some `select()` without column projection, and sequential patterns where batch would work |
| **Scalability** | 5/10 | D1 is a single-region SQLite database with no read replicas; KV cache provides eventual-consistency reads; queue decouples checkout from writes; but no horizontal scaling strategy, no connection pooling (N/A for D1), and bulk operations scale linearly |
| **Performance** | 6/10 | KV caching on all storefront GET routes is excellent; product queries use proper indexes and FTS5; `db.batch()` reduces round-trips; but N+1 patterns in order updates/bulk deletes, unbounded feed generators, and dashboard queries scanning all orders without materialized aggregates |
| **Feature Readiness** | 4/10 | No performance budgets, no lighthouse CI, no APM integration, no query timing, no slow-query logging; cache TTLs are hardcoded; no feature-flag framework for performance gating |

---

## Detailed Findings

### 1. API Layer

#### 1.1 Caching Strategy (Strength)

The KV-based caching middleware (`apps/api/src/middleware/cache.ts`) is applied to **19 storefront route files**. The implementation is solid:
- Cache-Control headers with `stale-while-revalidate` and `stale-if-error`
- Group-based cache invalidation (`cache-invalidation.ts`) with clear admin-path-to-group mappings
- Cache key includes query string and optional auth hash
- In-memory fallback for local dev (capped at 5000 entries)

**Gap**: Admin API routes have no caching at all. The dashboard endpoint (`GET /api/v1/admin/dashboard`) runs 5 aggregate queries on every load. Even a 30-second KV cache would eliminate redundant dashboard reloads.

#### 1.2 Query Patterns (Mixed)

**Good**: Most list endpoints use `db.batch()` to combine count + data queries into a single D1 round-trip (products admin, customers, orders admin). Product storefront queries use `Promise.all` to parallelize image/variant/attribute fetches.

**Bad**: Several services still run count queries as separate awaits:
- `orders.admin.ts:listOrders` L99-106: count query is a separate `await` before data query
- `discounts.service.ts:listDiscounts` L31: count is a separate `.get()` call

**Bad**: `bulkDeleteOrders` (L884-902) runs a for-loop over each order ID, doing individual `select + inventory transition` per order. For a bulk delete of N orders, this is N sequential read queries + N sequential inventory operations.

#### 1.3 Payload Sizes

**Good**: Storefront product list selects only needed columns (no `select()`). Product detail uses parallel fetches with column projection.

**Concern**: `getDiscountById` and `listDiscounts` use `select()` (all columns) on the discounts table, which includes potentially large JSON config fields. Similarly, `getActiveHomepageWidgets` returns full widget HTML/CSS content in every response.

#### 1.4 Queue Architecture (Strength)

Order creation uses Cloudflare Queues with a well-designed batch processing pipeline:
- Storefront validates and enqueues (fast HTTP response)
- Queue consumer batches all DB writes into a single `db.batch()` call
- Inventory reservations grouped by pool
- Automatic rollback on batch failure
- KV-based checkout status polling

This is a strong architectural decision that decouples the hot path (checkout response) from the heavy path (DB writes + inventory).

### 2. Frontend Performance

#### 2.1 Admin (React SPA on Astro)

**Good**: 128 `useMemo`/`useCallback` occurrences across 30+ admin component files. The product list, customer list, and navigation builder all properly memoize expensive computations and callbacks.

**Missing**: No evidence of code splitting, `React.lazy()`, or dynamic imports for admin routes. The admin is a single Astro-hosted React app, meaning all component code likely ships in one bundle. For a dashboard with 20+ distinct pages (products, orders, customers, discounts, settings, etc.), this is a significant bundle size concern.

**Missing**: No image optimization on the admin side. Product images are served directly from R2 URLs without any CDN transformation, resizing, or format conversion.

#### 2.2 Storefront (Astro SSR)

**Good**: 45 lazy-loading occurrences across 16 files. Product images use `loading="lazy"`, hero sliders use preload for above-the-fold images, and product galleries use progressive loading.

**Missing**: No `<Image>` component from `@astrojs/image` or Cloudflare Image Transformations. All product images are served at their original upload size. For a catalog with 1000+ products, this means:
- No WebP/AVIF automatic conversion
- No responsive `srcset` with multiple sizes
- No CDN-edge image resizing

**Good**: Astro SSR with `prerender = false` on dynamic pages means HTML is server-rendered at the edge. Static pages (if any had `prerender = true`) would be fully cached.

### 3. Database Performance

#### 3.1 Index Coverage (Strong)

Every table has appropriate indexes:
- **products**: slug (unique), categoryId, isActive+deletedAt (composite), deletedAt
- **productVariants**: productId, sku (unique), barcode
- **productImages**: productId, productId+isPrimary (composite)
- **orders**: status, paymentStatus, customerId, createdAt, deletedAt
- **orderItems**: orderId, productId, variantId
- **customers**: email, phone (unique constraint + index)
- **deliveryShipments**: orderId, externalId, providerId+status (composite)
- **inventoryMovements**: variantId, orderId, createdAt

**Missing indexes**:
- `orders.customerPhone` -- used in FTS search and queue discount validation (`eq(orders.customerPhone, customerPhone)`) but no index exists
- `discountUsage.orderId` -- used in queue discount validation join but only has a composite `(discountId, customerId)` index
- `webhookEvents` -- no index on `processedAt` for time-based cleanup queries
- `customerHistory` -- no index on `createdAt` for time-based queries
- `metaConversionsLogs` -- no index on `createdAt` or `eventTime` for log retention cleanup

#### 3.2 FTS5 Usage (Good)

Full-text search is implemented via SQLite FTS5 virtual tables for products, product_variants, orders, customers, and discounts. Search queries use `MATCH` with sanitized input. The admin product search also supports barcode-based variant lookup with a fallback to FTS.

**Concern**: FTS5 virtual tables are maintained automatically by SQLite triggers. On D1, these triggers add write amplification to every INSERT/UPDATE on the base tables. This is acceptable for moderate write volumes but would become a concern at high write throughput.

#### 3.3 D1 Batch Usage (Good)

The codebase makes extensive use of `db.batch()` (Drizzle's D1 batch API) for:
- Product CRUD (create: product + images + attributes + content in one batch)
- Order creation (customer + order + items + discount usage in one batch)
- Customer CRUD (customer + history in one batch)
- Admin product list enrichment (variant counts + image counts + primary images + SKUs in one batch)

This is the single most impactful performance pattern in the codebase, reducing D1 round-trips from N to 1 for multi-statement operations.

#### 3.4 Missing Aggregation Tables

The dashboard queries (`getDashboardStats`, `getDailyActivityData`) compute aggregates on-the-fly by scanning the orders and customers tables. For stores with 100k+ orders, these queries will become slow. There are no materialized summary tables or cached aggregates.

### 4. Cross-Cutting Concerns

#### 4.1 No Request Timeout Handling

Cloudflare Workers have a 30-second CPU time limit, but no explicit timeout handling exists in the codebase. Long-running operations (bulk deletes, sitemap generation, Facebook feed) could exceed this limit silently.

#### 4.2 No Rate Limiting

No rate limiting on any API endpoint. The checkout endpoint dispatches to a queue (which provides natural backpressure), but the admin API has no protection against rapid-fire requests.

#### 4.3 No Memory Monitoring

The in-memory cache fallback (`InMemoryCache` in `kv-cache.ts`) has a 5000-entry cap, but no monitoring of actual memory usage. The `stats()` method serializes the entire cache to estimate size, which itself is O(n) and could be expensive.

#### 4.4 Cache Invalidation Pattern Completeness

The group-based cache invalidation is well-designed but has a potential issue: `deleteCacheByPattern` paginates through all KV keys with a given prefix and deletes them individually. For a store with many cached product pages, this could be slow. KV does not support bulk delete.

#### 4.5 External API Calls Without Timeouts

Queue consumer makes external HTTP calls to:
- WhatsApp Graph API (OTP delivery)
- Steadfast delivery API (shipment creation)
- Meta Conversions API (analytics events)
- Email provider (order notifications)

None of these have explicit `AbortSignal` timeouts. A slow external API could consume the entire Worker CPU budget.

---

## Scaling Readiness Assessment

### Current Ceiling: ~5,000 orders/day

The architecture handles this comfortably. KV caching absorbs storefront read traffic, the order queue smooths write spikes, and D1 handles moderate query volumes.

### Bottleneck at ~20,000 orders/day

**Dashboard**: Aggregate queries scanning the orders table become slow (full-table scans with date filters and status aggregation).

**Bulk operations**: Admin bulk-deleting 100 orders runs 100+ sequential queries. Admin order updates with many variants are similarly sequential.

**Feed generation**: Facebook feed and sitemaps for catalogs with 10k+ products hit Worker memory limits when accumulating all products in a single array.

### Hard Limits

| Resource | Limit | Current Usage |
|----------|-------|---------------|
| D1 database size | 10GB | Small (estimated <100MB for most stores) |
| D1 rows read/request | 100,000 | Dashboard scans could approach this |
| D1 rows written/request | 100,000 | Order batch writes well under limit |
| Worker CPU time | 30s | Feed generation could exceed this |
| Worker memory | 128MB | Feed generation with 10k+ products approaches this |
| KV value size | 25MB | Response cache entries well under this |
| KV reads/s | 100,000 | Well under limit |
| Queue batch size | 100 messages | Order ingest handles batches well |

---

## Recommendations

### Priority 1: Fix N+1 Patterns (High Impact, Moderate Effort)

1. **`bulkDeleteOrders`**: Batch-read all orders in one query, compute inventory releases in bulk, then execute all inventory + delete operations in a single `db.batch()`.

2. **`updateOrder` inventory delta loop**: Pre-fetch all needed variants in one `inArray` query, compute deltas in memory, then issue batch updates.

3. **`listDiscounts` secondary queries**: Use `db.batch()` to combine the products, collections, and usage queries into a single round-trip.

4. **`listOrders` count query**: Move into `db.batch()` with the data query (same pattern already used in `listProducts`).

### Priority 2: Bound Feed/Sitemap Generation (High Impact, Low Effort)

5. **Sitemap/Feed generators**: Stream XML output instead of accumulating all products in memory. Alternatively, reduce per-chunk size from 5000 to 500 and enforce strict limits.

6. **Add explicit `AbortSignal` timeouts** to all external API calls in the queue consumer (WhatsApp, delivery providers, email). Use 10-second timeouts.

### Priority 3: Add Dashboard Caching (Medium Impact, Low Effort)

7. **Cache dashboard stats in KV** with a 60-second TTL. The dashboard is the most-loaded admin page and its data is inherently stale (monthly aggregates do not need real-time accuracy).

8. **Batch the dashboard queries**: The 5 `Promise.all` queries in `getDashboardStats` are already parallel, but `getDailyActivityData` runs 2 sequential queries that should be batched.

### Priority 4: Add Missing Indexes (Low Impact, Low Effort)

9. Add index on `orders.customerPhone` -- used in queue discount validation and FTS fallback.
10. Add index on `discountUsage.orderId` -- used in queue validation join.

### Priority 5: Add Performance Infrastructure (Medium Impact, High Effort)

11. **Add query timing middleware**: Log D1 query durations to console (Cloudflare Workers Tail) for slow-query detection.
12. **Add performance budget CI check**: Use bundlesize or similar to gate admin JS bundle size.
13. **Add image optimization**: Either Cloudflare Image Transformations (preferred for the stack) or build-time image processing with srcset generation.

### Priority 6: Future Scaling Preparation (Low Urgency)

14. **Materialized dashboard aggregates**: Create a `daily_stats` table updated by a cron trigger or queue handler.
15. **Admin API caching**: Add KV caching with short TTLs (30-60s) on admin list endpoints.
16. **Admin code splitting**: Add route-based code splitting to the admin React app to reduce initial bundle size.
