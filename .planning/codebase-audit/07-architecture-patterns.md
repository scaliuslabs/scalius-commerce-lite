# Architecture & Design Patterns Audit

## Architecture Diagram

```
                        +--------------------------+
                        |     Cloudflare Edge      |
                        |  (CDN, Cache, DNS, WAF)  |
                        +----------+---+-----------+
                                   |   |
                    +--------------+   +---------------+
                    |                                   |
          +---------v----------+             +----------v----------+
          | Admin Worker :4321 |             | Storefront :4322    |
          | (Astro 6 SSR +     |             | (Astro 6 SSR +      |
          |  React 19)         |             |  React 19)          |
          |                    |             |                     |
          | Middleware chain:  |             | Middleware chain:    |
          |  auth -> rbac ->   |             |  apiContext ->       |
          |  csp               |             |  cachingMiddleware   |
          |                    |             |                     |
          | Imports:           |             | Imports:            |
          |  @scalius/core     |             |  @scalius/shared    |
          |  @scalius/database |             |  @scalius/api-client|
          |  @scalius/shared   |             |                     |
          |  @scalius/api-client             | Caching:            |
          +-------+------------+             |  L1: In-memory Map  |
                  |                          |  L2: CF Cache API   |
                  | Service Binding          |      + KV versions  |
                  | (env.API)                +--------+------------+
                  |                                   |
                  |          Service Binding           |
                  |          (env.BACKEND_API)         |
                  |                                   |
                  +--------+     +--------------------+
                           |     |
                    +------v-----v------+
                    | API Worker :8787   |
                    | (Hono + OpenAPI)   |
                    |                    |
                    | Entry Points:      |
                    |  fetch() -> Hono   |
                    |  queue() -> Q cons.|
                    |  scheduled()-> cron|
                    |                    |
                    | Middleware:         |
                    |  DB/KV/R2 init     |
                    |  CORS              |
                    |  authMiddleware    |
                    |  adminAuthMiddleware|
                    |  cacheMiddleware   |
                    +--------+----------+
                             |
                             | delegates to
                             |
                +------------v-----------+
                | @scalius/core          |
                | (Domain Services)      |
                |                        |
                | modules/               |
                |  orders/               |
                |    orders.admin.ts     |
                |    orders.storefront.ts|
                |    orders.queue.ts     |
                |    order-state-machine |
                |  products/             |
                |  inventory/            |
                |  payments/             |
                |  delivery/             |
                |  notifications/        |
                |  ... (20 domains)      |
                |                        |
                | auth/                  |
                |  Better Auth + RBAC    |
                |                        |
                | providers/             |
                |  Universal registry    |
                |  Payment, Email,       |
                |  Delivery, SMS         |
                |                        |
                | integrations/          |
                |  email, storage,       |
                |  firebase, analytics   |
                +--------+--+-----------+
                         |  |
              +----------+  +----------+
              |                        |
    +---------v-------+     +----------v--------+
    |@scalius/database|     | @scalius/shared    |
    | Drizzle ORM     |     | Pure utilities     |
    | D1 adapter      |     | (currency, price,  |
    | 11 schema files |     |  utils, cors, etc.)|
    | migrations      |     +-------------------+
    +--------+--------+
             |
     +-------v--------+
     | Cloudflare D1   |
     | (SQLite)        |
     | + FTS5 indexes  |
     +-------+---------+
             |
     +-------v--------+   +---+---+   +---------+
     | CF Queues       |   | CF KV |   | CF R2   |
     | (4 queues +     |   | Cache |   | Media   |
     |  DLQs)          |   +-------+   +---------+
     +-----------------+
```

**Data Flow Summary:**
1. Browser -> CF Edge -> Admin/Storefront Worker (Astro SSR)
2. Astro SSR -> Service Binding -> API Worker (Hono, 0ms latency in prod)
3. API Worker -> thin HTTP layer (validation, auth) -> @scalius/core services
4. @scalius/core services -> @scalius/database -> Cloudflare D1 (SQLite)
5. Async operations: API routes enqueue -> CF Queues -> queue-consumer.ts -> core services
6. Cron: scheduled() -> releaseExpiredReservations() every 15 min


## Executive Summary

This is a well-architected Turborepo monorepo implementing a headless e-commerce platform on Cloudflare Workers. The architecture follows a disciplined layered approach: thin HTTP layer (Hono routes) -> domain services (@scalius/core) -> persistence (@scalius/database), with clear module boundaries enforced by package exports. The system leverages Cloudflare-native primitives (D1, KV, R2, Queues, Service Bindings) effectively, resulting in a low-latency, globally distributed architecture with no traditional server infrastructure.

**Key Strengths:** Strong domain separation, consistent API envelope contract, sophisticated inventory management with CAS concurrency control, explicit state machines, comprehensive OpenAPI spec generation, and a well-designed multi-layer caching strategy.

**Key Weaknesses:** Admin app has structural coupling to core/database packages that should go through the API, some domain services have inconsistent typing patterns (mixed Database type imports), the universal provider registry is partially implemented, and in-memory state (rate limiter, layout cache) limits horizontal scaling readiness.

**Overall Architecture Grade: 7.5/10** -- A solid, production-grade architecture with thoughtful design decisions, a few areas of technical debt that are explicitly tracked, and clear extension points for future growth.


## Ratings

| Dimension | Score | Justification |
|-----------|-------|---------------|
| **Maintainability** | 8/10 | Strong package boundaries, consistent module structure (20 domains each with service/validation/types), barrel re-exports, shared tsconfig. Admin's direct core/database imports are the main blemish. |
| **Robustness** | 7/10 | Queue retry with DLQs, idempotent payment processing, CAS concurrency on inventory, graceful cache degradation (L2 -> L1 -> no cache). Known gap: token blacklist fails open when KV unavailable. |
| **Code Quality** | 8/10 | Consistent patterns throughout (OpenAPIHono routes, ok()/created() helpers, typed errors, Zod validation). ~66 `any` usages in core (mostly Drizzle batch typing). FTS5 has SQL injection guards. |
| **Scalability** | 6/10 | Cloudflare Workers auto-scale per-request. Single D1 database is the primary bottleneck. In-memory Maps (rate limiter, layout cache, DB singleton) are isolate-scoped. No read replicas or sharding strategy. |
| **Performance** | 8/10 | Service bindings for 0ms inter-worker latency, L1+L2 caching with KV version invalidation, Cloudflare edge compression, SWR cache headers, DB batch operations, FTS5 for search. Well-optimized for the Cloudflare model. |
| **Feature Readiness** | 7/10 | Universal provider registry exists but partially populated. Good extension points (how-to recipes in CLAUDE.md). No feature flags. Plugin architecture started but not complete. Settings KV store is extensible. |


## Detailed Findings

### Strengths

#### 1. Disciplined Layered Architecture (Thin HTTP -> Domain Services -> Persistence)

The codebase enforces a strict separation between the HTTP layer and business logic. API routes in `apps/api/src/routes/` are thin -- they validate input via Zod, check auth, then delegate to `@scalius/core` service functions. The core package owns all business rules.

**Evidence:**
- `apps/api/src/routes/admin/orders.ts` imports from `@scalius/core/modules/orders` and calls service functions directly
- Core services accept a `db: Database` parameter instead of accessing a global, making them testable and framework-agnostic
- The `@scalius/core` package has no dependency on Hono, Astro, or any HTTP framework

#### 2. Explicit State Machines

The `order-state-machine.ts` implements a formal state transition graph for three dimensions (order status, payment status, fulfillment status). All status changes must pass through `validateTransition()` before executing. This prevents invalid state combinations and makes the domain rules auditable.

Similarly, `inventory-transitions.ts` acts as the single source of truth for how inventory reacts to order status changes, with clear per-action guards (`inventoryAction` column) preventing double-processing.

#### 3. Consistent API Envelope Contract

Every success response follows `{ success: true, data: T }`, enforced by `ok(c, data)` and `created(c, data)` helpers. Error responses follow `{ success: false, error: { code, message, details? } }`. The global `onError` handler catches all exceptions including typed `AppError` subclasses and converts them to this format.

This contract is documented in CLAUDE.md, enforced in code, and consumed consistently by both admin and storefront.

#### 4. Domain-Aligned Module Structure

The `@scalius/core/modules/` directory contains 20 domain modules, each following a consistent pattern:
- `index.ts` -- barrel re-exports
- `*.service.ts` -- admin CRUD operations
- `*.storefront.ts` -- public read-only queries (where applicable)
- `*.validation.ts` -- Zod schemas
- `*.types.ts` -- TypeScript interfaces
- `README.md` -- domain documentation

This consistency makes it trivial to navigate the codebase and understand module boundaries.

#### 5. Sophisticated Multi-Layer Caching

The storefront implements a production-grade caching strategy:
- **L1**: In-memory Map per Worker isolate (fast, dies on cold start)
- **L2**: Cloudflare Cache API keyed by KV version + BUILD_ID (persistent at edge)
- **API-level**: KV-backed cache middleware on Hono routes with configurable TTL
- **Cache invalidation**: KV version bumping purges all cached entries without iterating keys
- **Per-request isolation**: AsyncLocalStorage prevents cross-request cache context contamination

#### 6. Cloudflare-Native Design

The architecture fully embraces Cloudflare primitives rather than fighting them:
- D1 (SQLite) with Drizzle ORM -- no ORMs fighting the storage model
- KV for caching and session storage
- R2 for media with CDN + Image Resizing
- Queues with DLQs for async processing (payments, notifications, OTP, order ingest)
- Service Bindings for 0ms inter-worker communication in production
- Cron Triggers for inventory reservation expiry
- `WorkerEntrypoint` pattern exposing fetch/queue/scheduled methods

#### 7. OpenAPI-First API Design

All routes use `@hono/zod-openapi`'s `createRoute()` with typed request/response schemas. This generates a live OpenAPI 3.0 spec at `/api/v1/openapi.json`, powers Swagger UI at `/api/v1/docs`, and feeds SDK generation via `@hey-api/openapi-ts`. The spec is the contract between API, admin, and storefront.

#### 8. JIT Package Consumption

Packages have no build step. Wrangler/esbuild bundles directly from TypeScript source via the `exports` map in each package.json. This eliminates build coordination complexity, reduces CI time, and means that code changes are reflected immediately without waiting for downstream builds.


### Weaknesses

#### 1. Admin App Structural Coupling (Medium Severity)

The admin app imports directly from `@scalius/core` (auth, RBAC, utilities) and `@scalius/database` (DB client, KV cache). In a strict layered architecture, the admin should only communicate with the API worker. The admin needs direct imports because:
- Better Auth session verification requires the auth module
- RBAC permission checking in Astro middleware needs the permission helpers
- DB/KV/R2 initialization happens in the admin middleware for SSR data loading

This creates a "god dependency" where the admin bundles core domain logic. If the API ever becomes a separate microservice, the admin would need significant refactoring.

**Impact:** Increases admin bundle size, tighter coupling than necessary, harder to extract the API into a separate service.

#### 2. Inconsistent Database Type Imports (Low Severity)

Core services use two different patterns for the Database type:
- `import type { Database } from "@scalius/database/client"` (most services)
- `import type { DrizzleD1Database } from "drizzle-orm/d1"` + `type Database = DrizzleD1Database<typeof schema>` (products.admin.ts, products.storefront.ts)

The second pattern duplicates the type definition instead of using the canonical export. This is a minor inconsistency but could cause issues if the Database type definition changes.

#### 3. Universal Provider Registry is Partially Implemented (Medium Severity)

The `@scalius/core/providers/` directory has a well-designed universal provider registry with:
- Type-safe registration/retrieval
- Zod schema validation for settings
- Lifecycle hooks (initialize, healthCheck, dispose)
- Category-based organization (payment, email, delivery, SMS)

However, the CLAUDE.md Known Backlog states: "Delivery and SMS have type definitions with zero registered implementations in the new system. Legacy interfaces still in use." Payment and email have migrated, but delivery providers (Pathao, Steadfast) still use the legacy `factory.ts` + `provider.ts` pattern.

#### 4. In-Memory State Limits Horizontal Scaling (Medium Severity)

Several components use in-memory Maps that are isolate-scoped:
- `InMemoryCache` in `kv-cache.ts` (fallback for local dev)
- Rate limiter in `@scalius/shared/rate-limit.ts`
- Layout cache in `@scalius/shared/layout-cache.ts`
- DB singleton in `@scalius/database/client.ts` (module-level `_db`)

On Cloudflare Workers, each isolate restart loses this state. For single-tenant use this is acceptable (and documented), but multi-tenant or high-traffic scenarios would need KV-backed alternatives.

#### 5. No Feature Flag System (Low Severity)

There is no feature flag infrastructure. New features are deployed atomically. For a commerce platform where A/B testing, gradual rollouts, and merchant-specific feature toggles are common, this is a gap that will need addressing as the platform scales.

#### 6. Route Permission Mapping is Fragile (Medium Severity)

`route-permissions.ts` maps URL patterns to permissions using string-based glob matching. Some patterns use `/api/products/*` while others use `/api/v1/admin/categories`. This inconsistency suggests the mapping was built incrementally. If routes are renamed or reorganized, the permission mapping can silently break (no compile-time guarantee that a route's permission is defined).


### Critical Issues

#### 1. Single D1 Database -- No Read Replica or Sharding Strategy

All data for all tenants lives in a single Cloudflare D1 database. D1 has a write-per-second limit and a maximum database size (currently 10GB for paid plans). The architecture has no:
- Read replica configuration
- Write/read splitting
- Database sharding strategy
- Multi-database routing

For the current single-tenant model this is not an issue, but it is the primary scaling bottleneck if the platform moves to multi-tenant or high-volume operation.

**Mitigation in place:** KV caching and L2 Cache API reduce read pressure on D1 significantly for storefront traffic.

#### 2. Token Blacklist Fails Open

Documented in Known Backlog: "When KV is unavailable, revoked JWT tokens are accepted instead of rejected." The `verifyToken()` function in `apps/api/src/utils/jwt.ts` checks KV for blacklisted tokens but falls through to allowing the token when KV is unreachable. This is a security concern -- a compromised token remains valid during KV outages.


## Architectural Debts

| Debt | Severity | Description | Recommended Fix |
|------|----------|-------------|-----------------|
| Admin-core coupling | Medium | Admin imports @scalius/core and @scalius/database directly for auth/RBAC. Should go through API service binding. | Extract auth/RBAC to a thin package or use API endpoints for RBAC data. Move DB init to the API worker. |
| Partial provider registry migration | Medium | Delivery and SMS providers use legacy interfaces instead of the universal provider registry. | Migrate Pathao/Steadfast providers to the registry pattern. Implement SMS provider interface. |
| Inconsistent Database type import | Low | Some services re-declare the Database type instead of using the canonical `@scalius/database/client` export. | Find and replace `DrizzleD1Database<typeof schema>` with `Database` import from client.ts. |
| No feature flag system | Low | No infrastructure for gradual rollouts, A/B testing, or per-merchant feature toggles. | Implement a simple KV-backed feature flag system using the existing settings table or a dedicated flags table. |
| In-memory rate limiter | Low | Rate limiting state is lost on isolate restart and not shared across isolates. | Migrate to KV-backed rate limiting with sliding window counters. |
| Route-permission mapping fragility | Medium | String-based URL pattern matching for RBAC has no compile-time safety. | Consider deriving permissions from route metadata (decorators or route config) rather than a separate mapping file. |
| Dual settings storage | Low | `siteSettings` (typed singleton) and `settings` (KV table) coexist. The boundary of when to use which is documented but could drift. | Consider migrating `siteSettings` columns into the `settings` KV table to unify the pattern, or at minimum add validation that prevents overlap. |
| No database connection pooling | N/A (by design) | D1 bindings are stable handles with no per-connection cost. Not actually a debt -- noted for clarity since traditional architectures would flag this. | None needed for D1. |


## Clean Architecture / Hexagonal Architecture Assessment

The codebase partially adheres to Clean Architecture principles:

**What it does well:**
- **Dependency Rule (mostly followed):** Dependencies point inward. `@scalius/shared` has no dependencies. `@scalius/database` depends only on `drizzle-orm`. `@scalius/core` depends on database + shared. Apps depend on core + shared + database.
- **Use Case layer (strong):** Core modules like `orders.admin.ts`, `orders.storefront.ts` are effectively use case implementations that orchestrate entities and persistence.
- **Entity layer (partial):** Drizzle schema definitions in `@scalius/database/schema/` serve as entities, with Zod schemas in `*.validation.ts` serving as entity validation rules.
- **Interface Adapters (strong):** API routes are classic interface adapters -- they translate HTTP requests into service calls and service responses into HTTP responses.

**Where it diverges:**
- **No Ports/Adapters abstraction for persistence:** Services directly call Drizzle ORM queries rather than going through repository interfaces. This makes the core tightly coupled to SQLite/Drizzle, which would need refactoring to support alternative databases. Given the Cloudflare-D1-only deployment target, this is a pragmatic trade-off.
- **Admin app pierces the layers:** By importing `@scalius/core` directly, the admin frontend bypasses the API adapter layer, breaking the hexagonal pattern.
- **Provider registry is the closest to Ports/Adapters:** The `@scalius/core/providers/` system with its factory pattern, schema validation, and lifecycle hooks is the most hexagonal-architecture-aligned component. It defines ports (provider interfaces) and adapters (Stripe, Pathao implementations).

**Assessment:** The architecture is best described as **Layered Architecture with Domain Services**, not strict Clean/Hexagonal Architecture. The pragmatic trade-offs (no repository interfaces, direct Drizzle usage, admin-core coupling) are reasonable for the team size and deployment model, but would need addressing if the system grows to multiple database backends or true microservice decomposition.


## Recommendations

### Short-term (next 1-2 sprints)

1. **Unify Database type imports** -- Replace all `DrizzleD1Database<typeof schema>` declarations in core services with `import type { Database } from "@scalius/database/client"`. Simple search-and-replace with zero behavioral change.

2. **Add compile-time route-permission validation** -- Create a script that extracts all registered Hono routes and verifies every admin route has a corresponding entry in `route-permissions.ts`. Run in CI to prevent silent permission gaps.

3. **Fix token blacklist to fail closed** -- When KV is unreachable, deny the request with a 503 rather than allowing potentially-revoked tokens through. Add a configuration option for the behavior.

### Medium-term (next quarter)

4. **Migrate delivery providers to universal registry** -- Port Pathao and Steadfast from the legacy `factory.ts` + `provider.ts` pattern to `registerProvider()`. This completes the provider abstraction and makes adding new delivery providers a single-file task.

5. **Implement KV-backed rate limiting** -- Replace the in-memory rate limiter with a KV-backed sliding window counter. This is necessary before any multi-tenant or high-traffic scenario.

6. **Add a feature flag system** -- Implement a simple flags table + KV cache + admin UI for toggling features per-merchant. Start with the existing `settings` table pattern.

### Long-term (next 6 months)

7. **Decouple admin from core/database** -- Move the admin's auth middleware to use the API worker's auth endpoints via service binding. Remove the admin's direct `@scalius/core` and `@scalius/database` dependencies. This prepares the system for API extraction into a true microservice.

8. **Introduce repository interfaces** -- If multi-database support becomes a goal, add repository interfaces in core that abstract away Drizzle-specific queries. Currently the pragmatic direct-Drizzle approach is correct for a single-database system.

9. **Evaluate D1 read replicas** -- When Cloudflare ships D1 read replicas (currently in beta), architect the read path to use replicas for storefront queries while keeping writes on the primary. The existing admin vs. storefront query separation in core modules maps well to this split.

10. **Consider Event Sourcing for orders** -- The current `inventoryMovements` table and `webhookEvents` table are partial event logs. Formalizing an event sourcing pattern for the order lifecycle would improve auditability, enable replay-based debugging, and support eventual consistency patterns needed for multi-region deployment.
