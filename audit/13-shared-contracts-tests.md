# Audit Agent 13: Shared Contracts, SDK Surfaces, and Tests

## Scope

Owned paths:

- `packages/shared/**`
- `packages/api-client/**`
- `tests/**`

Selected cross-package verification boundaries reviewed to validate the real contract flow:

- `apps/api/src/utils/api-response.ts`
- `apps/api/src/app.ts`
- `apps/api/src/routes/products.ts`
- `apps/api/src/routes/orders.ts`
- `apps/api/src/routes/search.ts`
- `apps/api/src/routes/abandoned-checkouts.ts`
- `apps/api/src/routes/admin/settings/delivery-locations.ts`
- `apps/api/src/routes/payment/sslcommerz-routes.ts`
- `apps/api/src/routes/webhooks/pathao.ts`
- `apps/api/src/routes/webhooks/steadfast.ts`
- `apps/api/src/routes/webhooks/stripe.ts`
- `apps/admin-v2/src/lib/api-helpers.ts`
- `apps/admin-v2/src/types/api-responses.ts`
- `apps/storefront/src/lib/api/{client,orders,products,types,unwrap}.ts`

Verification run during this audit:

- `pnpm test` -> passed, 9 files / 143 tests
- `pnpm --filter @scalius/shared typecheck` -> passed
- `pnpm --filter @scalius/api-client typecheck` -> passed

The important takeaway is that the current checks are green, but several of them validate copied expectations rather than the real shared contract surface.

## How Shared Contracts And Testing Work

Shared contract flow today:

1. The API defines the success/error envelope in `apps/api/src/utils/api-response.ts`.
2. Routes implemented with `createRoute()` + `app.openapi()` are included in `/api/v1/openapi.json`, which is checked into `packages/api-client/openapi.json`.
3. `packages/api-client` turns that spec into generated request/response types plus SDK methods.
4. The storefront and admin consume those generated artifacts, but both also keep local contract adapters and local domain types because the generated types are often too loose for direct use.
5. End-to-end verification is weak because the test suite is almost entirely unit-style shadow logic; there are no integration tests under `tests/integration/`, no shared-package tests under `tests/unit/shared/`, and no automated freshness gate that proves the checked-in OpenAPI spec still matches the live API routes.

Concrete boundary helpers:

- Real success envelope: `apps/api/src/utils/api-response.ts:3-44`
- Admin envelope unwrapping: `apps/admin-v2/src/lib/api-helpers.ts:40-53`
- Storefront envelope unwrapping: `apps/storefront/src/lib/api/unwrap.ts:16-35`
- SDK generation entrypoint: `packages/api-client/scripts/generate-spec.ts:8-46`
- SDK package exports: `packages/api-client/package.json:5-18`

## Findings

### 1. High: the response-envelope test suite is validating the wrong contract

The real API contract is `{ success: true, data: T }`, but the only dedicated contract test still asserts the legacy spread shape `{ success: true, ...data }` and a legacy string error payload. That means the repo currently gets a green contract suite even if consumers and API helpers disagree about the real envelope.

Exact refs:

- Real contract: `apps/api/src/utils/api-response.ts:3-44`
- Admin consumer expects `.data`: `apps/admin-v2/src/lib/api-helpers.ts:40-53`
- Storefront consumer expects `.data`: `apps/storefront/src/lib/api/unwrap.ts:16-35`
- Stale test comments and factories: `tests/unit/api/response-envelope.test.ts:4-57`
- Stale success assertions: `tests/unit/api/response-envelope.test.ts:94-141`
- Stale error-shape assertions: `tests/unit/api/response-envelope.test.ts:145-203`
- Internal contradiction: `tests/README.md:90` says the envelope is `{ success: true, data: T }`, while the test file asserts the opposite

Why this matters:

- This is the most important verification surface for every generated client and manual consumer.
- The current suite gives false confidence on exactly the shared contract that binds API, admin, storefront, and SDK generation together.

### 2. High: wildcard CORS matching is over-broad and runs with credentials enabled

`getCorsOriginContext()` builds wildcard rules by replacing `*` with `.*` and then feeding the result directly to `RegExp` without escaping dots or other regex characters. With `credentials: true` enabled in the API CORS middleware, a configured origin like `https://*.scalius.com` will also match sibling-looking domains such as `https://foo-scalius.com`, not just true subdomains.

Exact refs:

- Regex construction: `packages/shared/src/cors-helper.ts:15-19`
- Auto-generated wildcard origins: `packages/shared/src/cors-helper.ts:63-79`
- Credentialed CORS middleware using that matcher: `apps/api/src/app.ts:137-145`

Why this matters:

- This is a real cross-package security boundary because it affects every browser caller of the API.
- The bug is in shared code, not in one route.
- There is no automated coverage for `cors-helper.ts`.

### 3. High: most “business logic” tests are shadow models, not tests of the real implementation

The suite passes 143 tests, but many of the core tests explicitly re-implement extracted logic inside the test file instead of importing and exercising the production modules. That means a production regression can slip through as long as the copied model in the test remains self-consistent.

Representative refs:

- Order state machine copied into test: `tests/unit/core/orders/order-state-machine.test.ts:1-70`
- Payment confirmation logic copied into test: `tests/unit/core/payments/process-payment.test.ts:27-100`
- Refund logic copied into test: `tests/unit/core/payments/refund-validation.test.ts:29-111`
- Inventory lifecycle logic copied into test: `tests/unit/core/orders/order-lifecycle.test.ts:41-71`
- Inventory reservation simulator copied into test: `tests/unit/core/inventory/batch-reservation.test.ts:39-130`
- Inventory CAS/backoff simulated with literals, not real code paths: `tests/unit/core/inventory/reserve-deduct-release.test.ts:486-528`

Why this matters:

- The suite is good at documenting intended behavior, but weak at catching drift in the implementation.
- This is the main reason current green tests should not be treated as strong end-to-end verification.

### 4. Medium-High: the contract surface is fragmented across generated SDK types, manual local types, and raw fetch fallbacks

The API client only covers documented OpenAPI routes, but the live surface includes plain Hono endpoints that never reach the generated SDK. Consumers have already started working around that by using raw `fetchWithRetry()` and local contract types. That fragmentation increases drift risk and makes it harder to trust type-safety as an end-to-end guarantee.

Exact refs:

- SDK generator only reads checked-in OpenAPI: `packages/api-client/openapi-ts.config.ts:3-20`, `packages/api-client/scripts/generate-spec.ts:8-46`
- Public product variants are missing from the SDK surface, so storefront falls back to raw fetch: `apps/storefront/src/lib/api/products.ts:84-96`
- The public product routes file ends without defining a `/products/{id}/variants` route: `apps/api/src/routes/products.ts:165-197`
- Checked-in spec includes admin variants paths but no public product-variants path: `packages/api-client/openapi.json:69973-72999`
- Undocumented live endpoints exist outside the SDK, including Pathao import endpoints: `apps/api/src/routes/admin/settings/delivery-locations.ts:344-399`
- Undocumented SSLCommerz redirect endpoints exist outside the SDK: `apps/api/src/routes/payment/sslcommerz-routes.ts:193-257`
- Webhook surfaces are live but outside generated contract coverage: `apps/api/src/routes/webhooks/pathao.ts:14-200`, `apps/api/src/routes/webhooks/steadfast.ts:14-219`, `apps/api/src/routes/webhooks/stripe.ts:16-57`

Local type forks deepen the problem:

- Admin explicitly forks SDK types because generated types are too loose: `apps/admin-v2/src/types/api-responses.ts:1-11`
- Storefront does the same and keeps a local order payload subset: `apps/storefront/src/lib/api/types.ts:5-7`, `apps/storefront/src/lib/api/types.ts:384-410`
- The generated SDK already supports `paymentMethod?: 'stripe' | 'sslcommerz' | 'polar' | 'cod'`: `packages/api-client/src/generated/types.gen.ts:4822`
- The storefront local subset omits `polar`: `apps/storefront/src/lib/api/types.ts:387-410`

Why this matters:

- Even when the generated SDK is “typed,” it is not the only contract source in the repo.
- Manual forks are now the places where drift can accumulate silently.

### 5. Medium-High: the shared rate limiter is a non-atomic read-modify-write and can be bypassed under concurrency

`rateLimit()` reads a JSON blob from KV, increments it in memory, then writes it back. If two requests race, both can read the same counter and both can write `count + 1`, effectively undercounting bursts. This is especially relevant because the helper protects order creation and public search-like endpoints.

Exact refs:

- Non-atomic KV read/parse/update/write sequence: `packages/shared/src/rate-limit.ts:35-57`
- Used on order creation: `apps/api/src/routes/orders.ts:290-297`
- Used on abandoned checkout capture: `apps/api/src/routes/abandoned-checkouts.ts:43-50`
- Used on storefront search: `apps/api/src/routes/search.ts:73-80`

Why this matters:

- This is a shared-state anti-pattern in a security-sensitive helper.
- It will appear to work in light traffic and still fail under concurrent bursts, which makes it easy to miss without targeted concurrency tests.

### 6. Medium: the shared in-memory layout cache is now effectively dead code, but its invalidation hooks still exist

`layout-cache.ts` advertises a per-isolate cache with invalidation semantics, but there are no reads or writes anywhere in the repo. The only usages are invalidation calls from admin settings routes. Meanwhile the real storefront URL cache now lives in KV in `settings.service.ts`. This leaves behind misleading shared complexity without any verification surface.

Exact refs:

- Cache implementation: `packages/shared/src/layout-cache.ts:1-55`
- No reads/writes found; only invalidations remain: `apps/api/src/routes/admin/settings/site.ts:348-354`, `apps/api/src/routes/admin/settings/system.ts:334-337`
- Real storefront URL caching now uses KV instead: `packages/core/src/modules/settings/settings.service.ts:55-74`

Why this matters:

- It is easy for future maintainers to assume cross-worker cache invalidation exists when it does not.
- The current shared helper is effectively unused but still shapes mental models and docs.

## Coverage Gaps

Current gaps that can hide regressions:

- There are 9 test files total, 0 integration test files, and 0 shared utility test files.
- `packages/shared` has no direct automated coverage for:
  - `cors-helper.ts`
  - `rate-limit.ts`
  - `image-optimizer.ts`
  - `media-url.ts`
  - `customer-utils.ts`
  - `currency.ts`
  - `price-utils.ts`
  - `json-repair.ts`
  - `tag-parser.ts`
  - `html-sanitize.ts`
  - `css-scope.ts`
  - `timestamps.ts`
- There is no automated check that regenerates `packages/api-client/openapi.json` and fails when the checked-in SDK/spec drift from the live API.
- There is no automated verification that all public browser-consumed endpoints are represented in OpenAPI.
- There is no concurrency test proving rate-limit behavior under parallel requests.
- There is no contract test that exercises the real `ok()`, `created()`, `noContent()`, and real API error objects end-to-end through the generated client.
- The vitest alias config points at `../src`-style root aliases in `tests/vitest.config.ts:10-15`, but the repo is a monorepo without a root `src/`; the current tests avoid those aliases, so this latent config mismatch remains unverified.

## Prioritized Follow-Ups

1. Replace `tests/unit/api/response-envelope.test.ts` with tests that import and exercise the real API response helpers and a small real route surface. Make the success and error shape assertions match `{ success: true, data: T }` and `{ success: false, error: { code, message, details? } }`.
2. Fix `packages/shared/src/cors-helper.ts` by escaping literal characters before expanding wildcards, and add focused tests for exact domain, subdomain wildcard, and near-miss hostile domains. Keep `credentials: true` behavior in mind while validating the matcher.
3. Stop relying on shadow-model tests for critical logic. Import real helpers/modules where possible, or introduce tiny pure functions in production code so tests can target the real implementation rather than copied logic.
4. Add a CI gate that regenerates `packages/api-client/openapi.json` and fails on diff, and separately enumerate or intentionally exempt live routes that are outside OpenAPI.
5. Remove or migrate manual local type forks where possible. Start with `apps/storefront/src/lib/api/types.ts` so the order payload path uses `OrderPostRequest` directly instead of a stale local subset.
6. Replace the KV rate limiter with an atomic strategy appropriate for burst control, or explicitly scope it as best-effort only and add concurrency tests that demonstrate its real behavior.
7. Delete `layout-cache.ts` if it is dead, or wire it back into real reads with explicit tests. Right now it adds confusion without enforcement.
