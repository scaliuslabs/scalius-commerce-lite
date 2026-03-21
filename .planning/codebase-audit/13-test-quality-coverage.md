# Test Quality & Coverage Audit

## Executive Summary

The test suite is **private** (gitignored `tests/` directory), containing **9 test files** with **143 test cases** across **44 describe blocks**. Tests cover only the most critical business logic domains (payments, orders, inventory, discounts) plus the API response envelope contract. The test infrastructure includes a well-designed mock factory (`setup.ts`) with mock DB, mock Cloudflare environment, and seed data generators.

**The fundamental problem**: tests do not import or exercise the actual source code. Every test file re-implements ("extracts") pure logic from the source modules, then tests those local reimplementations. This means the tests verify *intent* but cannot catch regressions in the actual codebase. The transition maps in the test state machine have already diverged from the real `order-state-machine.ts` -- a textbook example of this approach failing silently.

Overall coverage is extremely low: ~2,800 lines of test code against ~39,000+ lines of source code. Zero integration tests exist. Zero frontend tests exist. Zero API route tests exist against real handlers. The vitest workspace references three packages (api, core, shared) but none of them contain any test files -- the workspace is effectively inert.

---

## Coverage Map

### Core Modules (`packages/core/src/modules/` -- 20 modules, ~19,577 lines)

| Module | Source Lines | Has Tests? | Quality (1-10) | Gaps |
|--------|-------------|-----------|----------------|------|
| **orders** | ~2,021 | Partial | 5 | Tests reimpl logic locally; lifecycle + state machine covered, but `orders.admin.ts` (902L), `orders.storefront.ts` (358L), `orders.fulfillment.ts` (213L), `orders.queue.ts` (411L) completely untested. State machine transitions **diverged from source**. |
| **payments** | ~1,529 | Partial | 5 | COD idempotency, payment processing, refund validation covered via local reimpl. Gateway integrations (Stripe 4xx/5xx, SSLCommerz, Polar), `gateway-registry.ts`, `factory.ts` completely untested. |
| **inventory** | ~2,343 | Partial | 6 | Reserve/deduct/release logic and batch reservation tested well. But actual CAS retry logic, `inventory-transitions.ts` (300L), `stock-adjustment.ts`, `alerts.ts`, `expiry.ts`, `movements.ts` untested. |
| **discounts** | ~672 | Partial | 6 | Code uniqueness + applicability validation covered. `discounts.eligibility.ts`, actual service CRUD untested. |
| **products** | ~1,870 | None | 0 | Zero tests. Admin product CRUD (730L), storefront queries (539L), variant logic (products.variants.ts) all untested. |
| **customers** | ~1,073 | None | 0 | Zero tests. Auth service (482L), customer CRUD (415L) untested. |
| **delivery** | ~1,200+ | None | 0 | Zero tests. Service (384L), provider integrations (Steadfast, Pathao), status mapper, tracking untested. |
| **categories** | ~700+ | None | 0 | Zero tests. Service (363L), storefront queries, validation untested. |
| **collections** | ~400+ | None | 0 | Zero tests. |
| **media** | ~350+ | None | 0 | Zero tests. R2 upload/delete logic untested. |
| **navigation** | ~400+ | None | 0 | Zero tests. |
| **widgets** | ~400+ | None | 0 | Zero tests. |
| **settings** | ~500+ | None | 0 | Zero tests. Checkout config, site settings untested. |
| **analytics** | ~300+ | None | 0 | Zero tests. Meta CAPI, dashboard analytics untested. |
| **notifications** | ~207 | None | 0 | Zero tests. |
| **pages** | ~300+ | None | 0 | Zero tests. |
| **ai** | ~300+ | None | 0 | Zero tests. |
| **fraud-checker** | ~200+ | None | 0 | Zero tests. |
| **storefront** | ~350 | None | 0 | Zero tests. |
| **attributes** | ~400+ | None | 0 | Zero tests. |

### API Routes (`apps/api/src/routes/` -- 67+ route files, ~17,409 lines)

| Area | Has Tests? | Gaps |
|------|-----------|------|
| Response envelope contract | Yes (1 file) | Tests verify factory functions defined in the test file, not actual Hono handlers |
| Admin routes (30+ files) | None | Zero route handler tests. Orders, products, customers, settings, RBAC, inventory, discounts, media all untested. |
| Storefront routes (20+ files) | None | Zero route handler tests. Checkout, cart, products, search, categories untested. |
| Webhook handlers (4 files) | None | Zero tests for Stripe/Polar/SSLCommerz/Steadfast webhook processing. |
| Payment routes (3 files) | None | Zero tests for payment initiation flows. |

### Shared Utilities (`packages/shared/src/` -- 20 files, ~2,282 lines)

| Module | Has Tests? | Gaps |
|--------|-----------|------|
| price-utils.ts | None | Currency formatting, price calculations untested. |
| customer-utils.ts | None | Customer data normalization untested. |
| order-utils.ts | None | Order utility functions untested. |
| rate-limit.ts | None | Rate limiting logic untested. |
| html-sanitize.ts | None | XSS prevention untested -- security risk. |
| json-repair.ts | None | JSON repair heuristics untested. |
| All 14 other files | None | Zero shared utility tests. |

### Frontend (`apps/admin/` -- 455 files, `apps/storefront/` -- 138 files)

| Area | Has Tests? | Gaps |
|------|-----------|------|
| Admin React components | None | Zero component tests. Forms, tables, state management untested. |
| Storefront Astro pages | None | Zero page/rendering tests. |
| Client-side utilities | None | Nav progress, sidebar state, permission context untested. |

### Database Layer (`packages/database/` -- ~1,427 lines of schema)

| Area | Has Tests? | Gaps |
|------|-----------|------|
| Schema definitions | None | No schema validation tests. |
| Migrations | None | No migration rollback/forward tests. |

---

## Ratings

| Dimension | Score | Justification |
|-----------|-------|---------------|
| **Maintainability** | 4/10 | Good test organization (unit/core/{domain}), solid mock factory in `setup.ts` with seed generators. But tests are isolated from source -- refactors to source code will not break tests and vice versa. No shared assertion helpers. Fixtures directory empty. |
| **Robustness** | 3/10 | Edge cases within tested domains are good (float precision, overpayment, idempotency, cumulative refunds). But only 4 of 20 core modules have any test coverage. Zero integration tests. Zero E2E tests. Zero error path testing against real handlers. Webhook signature verification untested. |
| **Code Quality** | 5/10 | Individual test cases are well-written: descriptive names, AAA pattern, meaningful assertions, good describe nesting. But the fundamental anti-pattern of re-implementing source logic in tests undermines everything. Tests verify copies, not originals. |
| **Scalability** | 3/10 | Vitest workspace configured for parallel package execution but no packages have tests. `--passWithNoTests` flag means CI always green even with zero tests. No test categorization (smoke/unit/integration). No parallelization tags. No test sharding. |
| **Performance** | 7/10 | All tests are pure-function unit tests with zero I/O, zero async waits, zero real DB. They will execute in milliseconds. Mock factory is lightweight. No heavy setup/teardown. However this speed comes from not testing anything real. |
| **Feature Readiness** | 3/10 | Mock DB factory and seed generators provide a foundation for new tests. But no test templates exist. Empty integration/fixtures/shared directories show intent but zero execution. Adding a real integration test (e.g., miniflare-based route test) would require significant infrastructure build-out. |

**Weighted Overall: 3.5/10**

---

## Detailed Findings

### Strengths

1. **Well-structured test infrastructure**: The `setup.ts` mock factory is thoughtfully designed with chainable DB mocks, Cloudflare binding mocks (D1, KV, R2, Queue), and seed data generators with sensible defaults and override support.

2. **Critical domain focus**: Tests deliberately target the highest-risk business logic -- payment processing, inventory management, order state transitions, and refund validation. These are the domains where bugs cause financial harm.

3. **Good edge case thinking within tested areas**: Float precision guards (0.01 tolerance), overpayment handling, cumulative refund sequences, CAS retry simulation, batch rollback atomicity, duplicate variant merging.

4. **Clean test code style**: Consistent AAA pattern, descriptive test names, well-organized describe blocks, no test coupling, no shared mutable state between tests.

5. **CI integration**: GitHub Actions runs `pnpm test` in the pipeline, though `--passWithNoTests` means it provides no safety net.

### Weaknesses

1. **CRITICAL -- Tests do not import source code**: Every test file re-implements business logic as local pure functions instead of importing from `packages/core/src/modules/*`. This creates a parallel universe where tests can pass while the actual code is broken. Changes to source files will never cause test failures.

2. **CRITICAL -- State machine divergence already exists**: The test file `order-state-machine.test.ts` defines `VALID_TRANSITIONS` that **differ from the source** `order-state-machine.ts`:
   - Test allows `PENDING -> SHIPPED` (source does not)
   - Test allows `PROCESSING -> SHIPPED, PENDING` (source does not)
   - Test allows `CONFIRMED -> PENDING` (source does not)
   - Test omits `DELIVERED -> REFUNDED, PARTIALLY_REFUNDED` (source has them)
   - Test omits `COMPLETED -> REFUNDED, PARTIALLY_REFUNDED` (source has them)
   - Test allows `PARTIALLY_REFUNDED -> RETURNED, CANCELLED` (source does not)

   This is direct evidence that the copy-logic-into-tests approach has already failed.

3. **Zero integration tests**: The `tests/integration/` directory has three empty subdirectories (api-routes, checkout, inventory). Not a single integration test exists. For a commerce platform handling real money, this is a critical gap.

4. **Zero API route tests**: 67+ route files with ~17,409 lines of handler code have no tests. The response envelope test only verifies locally-defined factory functions, not actual Hono route responses.

5. **Zero frontend tests**: 455 admin files and 138 storefront files have no component, rendering, or interaction tests.

6. **Zero shared utility tests**: Security-sensitive code like `html-sanitize.ts` and `rate-limit.ts` is completely untested.

7. **No coverage tracking**: No coverage configuration in any vitest config. No coverage thresholds. No coverage reporting in CI. No way to measure or enforce coverage over time.

8. **CI `--passWithNoTests` flag**: The root `pnpm test` command uses `--passWithNoTests`, meaning CI will always report success even if all tests are deleted or the test directory is empty. Since `tests/` is gitignored, CI will always have zero tests to run and will always pass.

9. **Vitest workspace is effectively dead**: `vitest.workspace.ts` references `apps/api`, `packages/core`, and `packages/shared` -- but none of these packages contain any test files. Their vitest configs are empty stubs with only `globals: true`.

10. **No test coverage for validation schemas**: 13 validation files (~547 lines of Zod schemas) have zero tests. Invalid input handling is completely unverified.

### Critical Gaps (Highest Risk)

1. **Webhook signature verification**: Stripe, Polar, SSLCommerz, Steadfast webhook handlers process external callbacks with financial implications -- zero tests.
2. **Payment gateway integration**: Stripe checkout sessions, Polar payment initiation, SSLCommerz redirect flow -- zero tests.
3. **Authentication & authorization**: Customer auth, admin RBAC, 2FA setup -- zero tests.
4. **Data integrity in concurrent operations**: Actual CAS retry behavior under contention -- only simulated, never tested against real (or miniflare) D1.
5. **XSS prevention**: `html-sanitize.ts` protects against injection -- zero tests.
6. **Cart & checkout flow**: The entire purchase funnel is untested end-to-end.

---

## Test-to-Code Ratio Analysis

| Metric | Value |
|--------|-------|
| Source code lines (core modules) | ~19,577 |
| Source code lines (API routes) | ~17,409 |
| Source code lines (shared utilities) | ~2,282 |
| Source code lines (database schema) | ~1,427 |
| Source code lines (admin frontend) | ~455 files (est. ~30,000+ lines) |
| Source code lines (storefront) | ~138 files (est. ~8,000+ lines) |
| **Total estimated source** | **~78,000+ lines** |
| Test code lines (including setup) | ~3,045 |
| **Test-to-code ratio** | **~1:26** |
| Test cases | 143 |
| Modules with any coverage | 5 of 20 core modules (25%) |
| Modules with zero coverage | 15 of 20 core modules (75%) |
| API routes tested | 0 of 67+ (0%) |
| Frontend components tested | 0 of 455+ (0%) |
| Integration tests | 0 |
| E2E tests | 0 |

Industry benchmarks for e-commerce platforms typically target a test-to-code ratio of 1:1 to 2:1, with minimum 60% code coverage. This codebase is at approximately 1:26 with an effective coverage near 0% (since tests don't import source code).

---

## Recommendations

### P0 -- Immediate (Before Next Deploy)

1. **Fix the import problem**: Every test must `import` the actual functions from `packages/core` instead of re-implementing them locally. The state machine test should `import { canTransitionTo, getAvailableTransitions } from "@scalius/core/modules/orders/order-state-machine"`. This single change would have caught the transition map divergence.

2. **Fix the CI false-pass**: Remove `--passWithNoTests` from the root test command. Since `tests/` is gitignored, either: (a) un-gitignore it, or (b) move tests into the packages they test so the workspace vitest configs find them in CI.

3. **Add coverage thresholds**: Configure vitest coverage (c8 or istanbul) with a minimum threshold. Start low (20%) and ratchet up. Add coverage reporting to CI.

### P1 -- Short-Term (Next 2 Sprints)

4. **Integration test infrastructure**: Set up miniflare-based integration tests that run Hono handlers against a real D1 database in-memory. Focus on the checkout -> payment -> order lifecycle first.

5. **Webhook handler tests**: Write integration tests for all four webhook handlers with signature verification, replay protection, and payload validation.

6. **Shared utility tests**: Add unit tests for `html-sanitize.ts`, `rate-limit.ts`, `price-utils.ts`, and `customer-utils.ts`. These are pure functions -- easy wins.

7. **Validation schema tests**: Test all 13 Zod validation schemas with valid, invalid, and boundary inputs.

### P2 -- Medium-Term (Next Quarter)

8. **API contract tests**: Add tests for every route handler that verify correct response shapes, error codes, and authentication requirements.

9. **Admin component tests**: Add Vitest + React Testing Library tests for critical admin forms (order create/edit, product create/edit, discount create).

10. **Test data fixtures**: Populate `tests/fixtures/` with realistic test data sets representing common scenarios (multi-variant products, orders with discounts, partial payments, etc.).

11. **Test templates**: Create generator scripts or file templates for adding tests to new modules, reducing the friction of writing tests.

### P3 -- Long-Term

12. **E2E tests**: Add Playwright or Cypress tests for critical user flows (browse -> add to cart -> checkout -> payment -> order confirmation).

13. **Performance regression tests**: Add benchmarks for key operations (product search, order creation, inventory reservation) with regression thresholds.

14. **Mutation testing**: Use Stryker or similar to measure the actual fault-detection capability of the test suite.
