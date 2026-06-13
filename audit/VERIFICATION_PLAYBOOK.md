# Verification Playbook

This repo is hard to run end to end locally. Use this playbook to prove one slice at a time, and record exactly what was and was not verified.

## Baseline Commands

Run these before broad future remediation work or re-audits:

```bash
git status --short
pnpm typecheck
pnpm exec drizzle-kit check --config packages/database/drizzle.config.ts
pnpm --filter @scalius/database check:migrations
pnpm check:env
pnpm test
```

Current expected result:

- `pnpm typecheck` passes.
- Drizzle check passes.
- Database migration metadata guard passes.
- Worker Env declaration guard passes.
- Root tests currently pass with `pnpm test`.

## Focused Typecheck Commands

```bash
pnpm --filter @scalius/api typecheck
pnpm --filter @scalius/admin-v2 typecheck
pnpm --filter @scalius/storefront typecheck
pnpm --filter @scalius/core typecheck
pnpm --filter @scalius/database typecheck
```

Note: admin server functions now live under `apps/admin-v2/src/lib/api-functions/`; keep new slices covered by normal admin typecheck and avoid file-level `@ts-nocheck`.

## Focused Test Patterns

API routes:

```bash
pnpm --filter @scalius/api test -- src/routes/path/to/test.ts
```

Core services:

```bash
pnpm --filter @scalius/core test -- src/modules/domain/domain.test.ts
```

Admin components:

```bash
pnpm exec vitest run apps/admin-v2/src/path/to/test.ts
```

Admin shell/list routing:

```bash
pnpm exec vitest run apps/admin-v2/src/lib/admin-access.test.ts apps/admin-v2/src/routes/api/scanner-token.test.tsx
pnpm --filter @scalius/admin-v2 typecheck
```

Admin server-function slice changes:

```bash
pnpm --filter @scalius/admin-v2 typecheck
pnpm --filter @scalius/admin-v2 lint
git diff --check
rg -n "\b(exportNameOne|exportNameTwo)\b" apps/admin-v2/src --glob '!routeTree.gen.ts'
rg -n "as unknown as|legacyPayloadName" touched/file/one.ts touched/file/two.ts
```

For server-function slices, check the API route request schema and remember that `apps/admin-v2/src/lib/api.server.ts` unwraps `{ success, data }`; type the returned inner `data` shape, not the whole envelope.

Storefront tests:

```bash
pnpm --filter @scalius/storefront exec vitest run src/path/to/test.ts --passWithNoTests
```

Focused storefront Vitest now starts after adding the missing `happy-dom` dev dependency.

Storefront checkout/content/SEO regression checks:

```bash
pnpm --filter @scalius/storefront exec vitest run src/lib/checkout/render-summary.test.ts src/pages/seo-regressions.test.ts src/components/LocationSelector.test.ts
pnpm --filter @scalius/core test -- src/modules/pages/pages.service.test.ts
pnpm --filter @scalius/storefront typecheck
```

Storefront API contract checks:

```bash
pnpm --filter @scalius/storefront exec vitest run src/lib/api/client-url-policy.test.ts src/lib/checkout/render-summary.test.ts
pnpm --filter @scalius/storefront typecheck
pnpm --filter @scalius/api-client typecheck
pnpm --filter @scalius/api test -- src/routes/orders-create.test.ts
pnpm --filter @scalius/core test -- src/modules/orders/orders.queue.test.ts
rg -n 'discounts/usage|recordDiscountUsage\(' apps/storefront/src apps/api/src packages/core/src
```

SDK timestamp contract checks:

```bash
pnpm generate:sdk
pnpm --filter @scalius/api typecheck
pnpm --filter @scalius/api-client typecheck
pnpm --filter @scalius/storefront typecheck
rg -n 'string \| number \| unknown|string \| string \| unknown|number \| unknown' packages/api-client/src/generated/types.gen.ts
```

Notification and credential-encryption checks:

```bash
pnpm --filter @scalius/api test -- src/queue-consumer.test.ts src/utils/encryption-key.test.ts
pnpm --filter @scalius/core test -- src/modules/notifications/notifications.service.test.ts
pnpm --filter @scalius/core typecheck
pnpm --filter @scalius/api typecheck
pnpm --filter @scalius/admin-v2 typecheck
```

Payment-session, payment-webhook, shipping, and abandoned-checkout remediation checks:

```bash
# PAY-003/PAY-004/PAY-005 coverage
pnpm --filter @scalius/api test -- src/routes/payment/payment-session.test.ts src/routes/orders-receipt.test.ts
pnpm --filter @scalius/api exec vitest run src/routes/payment/payment-session.test.ts src/routes/webhooks/sslcommerz.test.ts
pnpm --filter @scalius/api exec vitest run src/utils/webhook-idempotency.test.ts src/routes/webhooks/stripe.test.ts src/routes/webhooks/sslcommerz.test.ts src/routes/webhooks/polar.test.ts src/routes/webhooks/steadfast.test.ts
pnpm generate:sdk
pnpm --filter @scalius/api typecheck
pnpm --filter @scalius/storefront typecheck
pnpm --filter @scalius/api-client typecheck

# ORDER-006 coverage
pnpm --filter @scalius/core test -- src/modules/orders/orders.storefront.test.ts
pnpm --filter @scalius/core typecheck

# ORDER-007 coverage
pnpm --filter @scalius/core exec vitest run src/modules/orders/orders.fulfillment.test.ts src/modules/delivery/tracking.test.ts src/modules/payments/polar.test.ts src/modules/payments/process-payment.test.ts
pnpm exec vitest run tests/unit/core/orders/update-order-atomicity.test.ts tests/unit/core/payments/refund-validation.test.ts
pnpm --filter @scalius/api exec vitest run src/routes/webhooks/steadfast.test.ts src/routes/admin/abandoned-checkouts.test.ts
pnpm --filter @scalius/core typecheck
pnpm --filter @scalius/api typecheck

# ORDER-008 coverage
pnpm --filter @scalius/core exec vitest run src/modules/orders/orders.fulfillment.test.ts src/modules/delivery/tracking.test.ts src/modules/payments/process-payment.test.ts
pnpm --filter @scalius/api exec vitest run src/routes/payment/payment-session.test.ts
pnpm exec vitest run tests/unit/core/orders/update-order-atomicity.test.ts
pnpm --filter @scalius/database check:migrations
pnpm exec drizzle-kit check --config packages/database/drizzle.config.ts
pnpm typecheck

# ORDER-009 coverage
pnpm exec vitest run tests/unit/core/orders/update-order-atomicity.test.ts
pnpm --filter @scalius/core exec vitest run src/modules/orders/orders.fulfillment.test.ts src/modules/delivery/tracking.test.ts src/modules/payments/process-payment.test.ts
pnpm --filter @scalius/core typecheck

# ORDER-010 coverage
pnpm --filter @scalius/core test -- src/modules/orders/orders.queue.test.ts
pnpm exec vitest run tests/unit/core/orders/order-ingest-queue.test.ts
pnpm --filter @scalius/core typecheck

# ORDER-011 coverage
pnpm exec vitest run tests/unit/core/orders/update-order-atomicity.test.ts
pnpm exec vitest run tests/unit/core/inventory/reserve-deduct-release.test.ts
pnpm --filter @scalius/core typecheck
pnpm --filter @scalius/core lint

# ORDER-005 coverage
pnpm --filter @scalius/api test -- src/routes/admin/abandoned-checkouts.test.ts
pnpm --filter @scalius/api typecheck
pnpm --filter @scalius/api lint
```

Use the PAY-003/PAY-004 checks to prove that payment-session routes reject missing or wrong receipt tokens before gateway calls, derive gateway URLs from trusted config, reject disabled or mismatched deposit attempts, ignore caller currency for session creation, and force public Stripe manual capture off. Use the PAY-005 SSLCommerz webhook checks to prove canonical validated transaction data is used instead of form metadata. Use the webhook-idempotency checks to prove fresh `processing` claims dedupe, stale `processing` claims are leased/reclaimable by only one retry, `failed` claims are reclaimable, `queued`/`processed` claims stay terminal, and non-duplicate insert failures throw for provider retry. Use the ORDER-006 checks to prove storefront order creation rejects bogus shipping methods and derives shipping from active backend methods. Use the ORDER-007 checks to prove same-status retries repair inventory across admin status changes, fulfillment, COD, delivery webhook/refresh, admin full edits, refunds, and returns while fulfilled refunds do not auto-restock deducted inventory. Use the ORDER-008 checks to prove provider shipment creation owns an order-level shipment claim, active claims block admin/order/refund/payment-session mutations and shipment refresh, queue/webhook paths retry instead of skipping, provider failures clear claims, and provider success plus final local CAS failure leaves reconciliation-required state without inventory side effects. Use the ORDER-009 checks to prove admin full order edits reject failed negative inventory deltas before item replacement, preserve old item context when item replacement fails, compensate pre-write inventory on later write failures, and treat delivered as a stock-deducting status consistently with the central inventory transition helper. Use the ORDER-010 checks to prove order-ingest fallback reuses held reservations, detects ambiguous shared-batch commits before inventory mutation, and never retries into a second reservation unless the first reservation was confirmed released. Use the ORDER-005 checks to prove abandoned-checkout cleanup releases reserved inventory before archiving, does not hard-delete orders, and leaves orders/items retryable when release fails.

## Local Dev Commands

```bash
pnpm dev
pnpm dev:all
pnpm dev:api
pnpm dev:admin
pnpm dev:storefront
pnpm dev:setup
pnpm dev:reset
pnpm dev:admin:create
pnpm dev:admin:reset
pnpm dev:admin:status
pnpm dev:doctor
pnpm dev:doctor:api
pnpm dev:doctor:admin
pnpm dev:doctor:storefront
pnpm dev:doctor:all
```

Expected ports:

- API: `http://localhost:8787`
- Admin: `http://localhost:4323/admin`
- Storefront: `http://localhost:4322`
- Swagger UI: `http://localhost:8787/api/v1/docs`
- OpenAPI: `http://localhost:8787/api/v1/openapi.json`

Known local-dev risks:

- `dev:setup` and `dev:reset` create `admin@local.scalius.test` / `ScaliusLocal123!` by default. Override with `--admin-email`, `--admin-password`, `--admin-name`, or `LOCAL_ADMIN_*`.
- `dev:setup` reuses existing shared secrets when only some local `.dev.vars` files exist, and fails if existing API/admin/storefront shared secrets disagree. Use `pnpm dev:setup --env-only` for env-file repair without migrations/admin creation, and `pnpm dev:setup --force --env-only` when intentionally regenerating all local env files.
- API local dev uses `apps/api/wrangler.local.jsonc`, which omits the remote Workers AI binding so setup/admin/storefront can boot without a Cloudflare remote proxy session.
- Dev startup applies pending local D1 migrations before API starts unless `SCALIUS_SKIP_DEV_MIGRATIONS=1`. `pnpm dev:api`, `pnpm dev:admin`, `pnpm dev:storefront`, and `pnpm dev` run through the wrapper; combined modes wait for API `/api/v1/setup` before starting dependent apps.
- `pnpm dev:doctor` is non-mutating. Plain mode reports missing env/state, non-local or wrong-port local URL values, and warns when servers are not running. Use the matching profile shortcut after startup: `pnpm dev:doctor:api`, `pnpm dev:doctor:admin`, `pnpm dev:doctor:storefront`, or `pnpm dev:doctor:all`.
- Use `SCALIUS_WRANGLER_STATE=/tmp/scalius-commerce-state` or `--state /tmp/scalius-commerce-state` to test setup/reset/dev against disposable local state without touching the default `.wrangler/state`. Script `--state` values are normalized from the repo root; prefer absolute paths in audit notes.
- Admin production uses `env.API`; local dev should hit HTTP fallback whenever `PUBLIC_API_BASE_URL` points at localhost. `pnpm dev:doctor` fails local env URL values that point at production domains or the wrong ports. Verify both server functions and `/api/v1/admin/*` browser proxy routes after transport changes.
- Unauthenticated `/admin` should server-redirect before rendering HTML: `curl -i http://localhost:4323/admin` should return `307` with `location: /auth/login`. Authenticated browser login should render the dashboard without Better Auth session-schema errors.
- `scripts/dev.sh` kills only Scalius dev ports by default. Set `SCALIUS_DEV_KILL_ALL_WORKERD=1` only when aggressive cleanup is needed.

Local helper regression checks:

```bash
bash -n scripts/dev.sh
node --check scripts/dev-local-utils.mjs
node --check scripts/dev-admin.mjs
node --check scripts/dev-setup.mjs
node --check scripts/dev-reset.mjs
node --check scripts/dev-doctor.mjs
pnpm exec vitest run scripts/dev-admin-cli.test.mjs scripts/dev-local-utils.test.mjs scripts/dev-doctor.test.mjs scripts/dev-sh.test.mjs --passWithNoTests
pnpm dev:doctor
pnpm dev:doctor --profile api
```

Expected result:

- Valueless flags such as `--password`, `--state`, or `--admin-password` fail before side effects.
- `dev:admin:reset` proves API reachability before clearing local auth tables.
- `dev:setup --env-only` repairs missing or blank runtime and build-time env keys without migrations/admin creation.
- `scripts/dev.sh` preserves the failing child process exit code after cleanup.
- `scripts/dev.sh` has a dry-run regression proving API-only startup and API-readiness ordering before admin/storefront startup.
- `dev:doctor --profile api|admin|storefront|all` checks only the services expected for that local stack, so intentional partial stacks do not create false service warnings/failures.

Disposable reset smoke test:

```bash
rm -rf /tmp/scalius-commerce-state
pnpm dev:reset --state /tmp/scalius-commerce-state \
  --admin-email disposable@local.test \
  --admin-password 'Disposable123!' \
  --admin-name 'Disposable Admin'

SCALIUS_WRANGLER_STATE=/tmp/scalius-commerce-state pnpm dev:admin
SCALIUS_WRANGLER_STATE=/tmp/scalius-commerce-state pnpm dev:doctor:admin
```

Expected result:

- All D1 migrations apply to the disposable path.
- `/api/v1/setup` creates the admin.
- If setup previously inserted a Better Auth user but failed before admin promotion, rerunning `pnpm dev:admin:create` should recover the partial first-admin state instead of returning a 500.
- Browser login at `http://localhost:4323/auth/login` reaches `/admin`.
- API worker logs show `GET /api/v1/admin/dashboard 200 OK`.
- The admin proxy route can be checked with a cookie jar; `GET http://localhost:4323/api/v1/admin/dashboard` should return `200 OK` and `x-proxy-base-url: http://localhost:8787/api/v1`.

## Turbo And Deploy Checks

Inspect the actual task graph before trusting root scripts:

```bash
node --check scripts/deploy.mjs
pnpm check:dist-secrets
pnpm deploy:api --dry-run
pnpm exec turbo run build --dry=json
pnpm exec turbo run lint --filter='!@scalius/tsconfig' --dry=json
pnpm exec turbo run deploy --filter=@scalius/api --dry=json
pnpm exec turbo run deploy --filter=@scalius/admin-v2 --dry=json
pnpm exec turbo run deploy --filter=@scalius/storefront --dry=json
```

Use these checks to verify:

- Deploy targets include typecheck and migration gates where required.
- Lint tasks actually exist for the seven code workspaces; `@scalius/tsconfig` is intentionally filtered from root lint.
- Build inputs include relevant `src/**`, `public/**`, scripts, configs, and generated asset inputs.
- Build outputs exclude local env files such as `.dev.vars`, `.env*`, and `*.vars`.
- Storefront build cache does not preserve stale build IDs.
- Root and package-local `deploy` shortcuts route through `scripts/deploy.mjs --only ...` and keep typecheck, dist-secret checks, and migration gates.
- Deploy dry runs validate typecheck/build/dist output but do not apply D1 migrations or deploy Workers.
- `scripts/copy-flags.mjs` fails if `country-flag-icons` or required copied flags are missing.

## Generated Contract Checks

OpenAPI/SDK:

```bash
pnpm generate:sdk
git diff --exit-code packages/api-client/openapi.json packages/api-client/src/generated
```

Database:

```bash
pnpm db:generate
git diff -- packages/database/migrations packages/database/src/schema
```

Cloudflare bindings:

```bash
pnpm check:env
pnpm --filter @scalius/api exec wrangler types
pnpm --filter @scalius/admin-v2 exec wrangler types
pnpm --filter @scalius/storefront exec wrangler types
```

Use `pnpm check:env` as the routine drift guard. Use generated Wrangler output only when intentionally replacing or refreshing type declaration files. Do not hand-edit generated SDK files.

## Security And Privacy Verification

2FA API boundary:

1. Create or use an admin with 2FA enabled.
2. Start a session that has not completed 2FA.
3. Call an admin API route directly.
4. Expected current verified behavior: API rejects the request until 2FA is verified.

Scanner RBAC:

1. Log in as an admin without inventory stock permissions.
2. `POST /api/scanner-token`.
3. Exchange the token for scanner session.
4. Attempt `POST /api/v1/admin/inventory/stock-adjust`.
5. Expected current verified behavior: token minting or scanner mutation is denied.

Public order receipt:

1. Create an order and capture both `orderId` and `receiptToken`.
2. Open `http://localhost:4322/order-success?orderId=<id>` in a private browser with no cookies.
3. Expected: storefront redirects away from the receipt page and no order PII is rendered.
4. Open `http://localhost:4322/order-success?orderId=<id>&token=<receiptToken>`.
5. Expected: minimal receipt renders, but phone, email, customer ID, shipments, delivery provider objects, and notes are absent.
6. Call `GET /api/v1/orders/receipt/<id>?token=wrong`.
7. Expected: `404`; wrong tokens must not reach the order lookup path.

Checkout DOM injection:

1. Before visiting `/checkout`, set checkout session data with a customer name such as `<img src=x onerror=alert(1)>`.
2. Load checkout.
3. Expected current verified behavior: the string renders as text or is rejected.

Public checkout-language mutations:

```bash
curl -i -X POST http://localhost:8787/api/v1/checkout-languages \
  -H 'Content-Type: application/json' \
  --data '{"name":"Test","code":"xx"}'
```

Expected current verified behavior: public mutation returns 401/403/404/405, while admin-authenticated mutation still works through the admin route.

## Order, Inventory, Payment, Delivery Verification

For every order-state fix, create tests that assert both success and failure ordering:

- CAS conflict after provider success.
- Provider failure after local claim.
- Inventory transition success followed by shipment/order batch failure.
- Duplicate webhook delivery.
- Queue redelivery of one failed message in a mixed batch.
- Full refund with payment, order status, inventory, and notification expectations.
- Soft-delete restore of terminal/restored/deducted orders cannot produce impossible status/inventory pairs such as `delivered + reserved` or `cancelled + reserved`.
- Shipment deletion cannot remove a `reconcile_required` or order-claimed shipment row while an order-level shipment claim remains active.

Suggested focused commands:

```bash
pnpm --filter @scalius/core test -- src/modules/orders/orders.fulfillment.test.ts
pnpm --filter @scalius/core test -- src/modules/orders/orders.queue.test.ts
pnpm exec vitest run tests/unit/core/orders/order-ingest-queue.test.ts
pnpm --filter @scalius/core test -- src/modules/inventory/expiry.test.ts
pnpm --filter @scalius/core test -- src/modules/payments/process-payment.test.ts
pnpm --filter @scalius/core test -- src/modules/payments/polar.test.ts
pnpm --filter @scalius/core test -- src/modules/delivery/tracking.test.ts
pnpm --filter @scalius/api test -- src/routes/webhooks/stripe.test.ts src/routes/webhooks/sslcommerz.test.ts
pnpm --filter @scalius/api test -- src/routes/webhooks/steadfast.test.ts
pnpm --filter @scalius/api test -- src/utils/cache-invalidation.test.ts
pnpm --filter @scalius/storefront exec vitest run src/lib/cache-purge-policy.test.ts --passWithNoTests
pnpm --filter @scalius/storefront typecheck
```

## Storefront Verification

Use browser checks after storefront changes:

- Cart form still submits with guest and logged-in customer.
- Location dropdowns prefill saved city/zone.
- Checkout supports COD and at least one redirect gateway without losing recoverability.
- Customer auth proxy sets cookies on the storefront domain.
- Search/config browser calls do not hit a missing `/api/v1/**` storefront route.
- `sitemap-static.xml` excludes cart/checkout/account/private pages.
- Future `publishedAt` pages are not visible and not in sitemap.
- Cache purge changes are visible after L1 clear and Cache API/L2 behavior is tested under Wrangler or deployed Worker runtime.

Useful commands:

```bash
curl -i 'http://localhost:4322/api/v1/search?q=test'
curl -s http://localhost:4322/sitemap-static.xml | rg '/cart|/checkout|/account'
curl -s http://localhost:4322/cart | rg -i 'noindex|robots'
```

## Hard-To-Run Areas

These need Wrangler, provider sandboxes, or deployed Worker verification:

- Cloudflare service bindings between admin/storefront and API.
- Cache API L2 invalidation across isolates.
- Queues and retry behavior.
- Cron reservation expiry.
- Stripe, SSLCommerz, Polar, Pathao, Steadfast webhooks.
- OTP delivery over email/SMS/WhatsApp.
- Production cookie domain behavior.

When local verification is blocked, write a focused unit or route test first, then document the remaining deployed-runtime check in the tracker.

## Reporting Template

```md
Verification:
- Commands run:
- Manual flows run:
- Passed:
- Failed:
- Blocked:
- Follow-up tracker IDs:
```
