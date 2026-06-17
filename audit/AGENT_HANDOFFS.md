# Agent Handoffs

Use these slices when launching future agents. Each slice should be owned end to end by one agent unless the work is explicitly split at a stable boundary.

Most historical slices below are now verified and should be treated as regression-audit prompts, not open remediation instructions. Use [REMEDIATION_TRACKER.md](REMEDIATION_TRACKER.md) for live status before assigning work.

## Slice 1: Admin Auth, 2FA, RBAC, Scanner

Tracker IDs: `SEC-001`, `SEC-002`, `ADMIN-002`.

Current state: verified. The API admin middleware now enforces completed 2FA for 2FA-enabled sessions except exact 2FA info, verify, complete-verification, and method-completion endpoints, scanner access uses a scanner session cookie limited by `packages/shared/src/scanner-auth.ts`, and scanner token minting has focused RBAC coverage. Future work should be a fresh regression audit, not a repeat of the old open findings.

Scope:

- `apps/api/src/middleware/admin-auth.ts`
- `apps/admin-v2/src/routes/api/scanner-token.tsx`
- `apps/admin-v2/src/middleware/rbac.server.ts`
- `apps/api/src/routes/admin/auth-management.ts`
- scanner allowlist in `packages/shared/src/scanner-auth.ts`

Prompt:

```md
Re-audit admin API auth/RBAC for 2FA and scanner access. Do not change unrelated admin screens. Verify unverified 2FA sessions are still rejected by API routes, low-permission admins still cannot mint scanner tokens, scanner cookies remain limited to the allowlist, and admin shell access matches API RBAC expectations.
```

## Slice 2: Public API Surface And Privacy

Tracker IDs: `SEC-003`, `PRIV-001`, `SEC-004`.

Current state: verified. Public checkout-language mutations are not mounted on the public router, order-success receipts require receipt tokens and render minimal DTOs, and checkout summary user data is rendered as text. Future work should re-audit these boundaries for regressions.

Scope:

- `apps/api/src/app.ts`
- `apps/api/src/routes/checkout-languages.ts`
- `apps/storefront/src/pages/order-success.astro`
- `apps/storefront/src/lib/api/orders.ts`
- `apps/storefront/src/lib/checkout/index.ts`

Prompt:

```md
Fix public mutation/privacy issues. Split checkout-language public reads from admin mutations, protect order receipt PII with a receipt token or minimal DTO, and remove unsafe checkout summary innerHTML. Add focused API/storefront tests where possible and document any manual browser checks.
```

## Slice 3: Order Inventory State Machine

Tracker IDs: `ORDER-001`, `ORDER-002`, `ORDER-003`, `ORDER-004`.

Scope:

- `packages/core/src/modules/orders/orders.queue.ts`
- `packages/core/src/modules/orders/orders.fulfillment.ts`
- `packages/core/src/modules/inventory/expiry.ts`
- `apps/api/src/routes/orders.ts`
- related order/inventory tests

Prompt:

```md
Audit and repair order/inventory state transitions. Verify reservation expiry cannot release live order stock, fulfillment side effects do not precede durable local claims, mixed batch failures are isolated, and order create handles queue/KV ordering safely.
```

## Slice 4: Payments And Webhook Idempotency

Tracker IDs: `PAY-001`, `PAY-002`, related parts of `ORDER-002`.

Scope:

- `apps/api/src/routes/webhooks/stripe.ts`
- `apps/api/src/routes/webhooks/sslcommerz.ts`
- `apps/api/src/routes/webhooks/polar.ts`
- `packages/core/src/modules/payments/**`
- queue consumer payment branches

Prompt:

```md
Make payment webhooks idempotent before side effects. Bring Stripe/SSL closer to Polar's durable claim model, make duplicate failed-payment handling safe, and route full refunds through an order status/inventory state transition.
```

## Slice 5: Delivery And Shipment Semantics

Tracker IDs: `DEL-001`, parts of `ORDER-002`.

Scope:

- `packages/core/src/modules/delivery/**`
- `packages/core/src/modules/orders/orders.fulfillment.ts`
- `apps/api/src/routes/webhooks/steadfast.ts`
- `apps/api/src/routes/admin/orders-status.ts`

Prompt:

```md
Unify delivery/shipment semantics. Ensure webhook idempotency does not drop later status changes, every provider status maps to an explicit order behavior, and single/bulk/manual shipment paths use the same state transition rules.
```

## Slice 6: Storefront Checkout, Cart, Cache, API Transport

Tracker IDs: `STORE-001`, `STORE-002`, `STORE-003`, `STORE-004`, `TEST-002`.

Scope:

- `apps/storefront/src/lib/api/client.ts`
- `apps/storefront/src/lib/api/checkout.ts`
- `apps/storefront/src/lib/api/shipping.ts`
- `apps/storefront/src/pages/api/purge-cache.ts`
- `apps/storefront/src/pages/cart.astro`
- `apps/storefront/src/components/LocationSelector.tsx`
- `apps/storefront/src/lib/checkout/**`

Prompt:

```md
Fix storefront reliability around API transport, checkout recovery, cart prefill, and cache invalidation. Avoid global SDK mutation where feasible, preserve cart recovery through redirect gateways, make location prefill match the rendered controls, and unblock focused storefront tests.
```

## Slice 7: Content And SEO Rules

Tracker IDs: `CONTENT-001`, `CONTENT-002`.

Scope:

- `packages/core/src/modules/pages/pages.service.ts`
- `apps/storefront/src/pages/sitemap-pages.xml.ts`
- `apps/storefront/src/pages/sitemap-static.xml.ts`
- `apps/storefront/src/pages/cart.astro`
- layout SEO/noindex handling

Prompt:

```md
Make public content visibility and SEO policy explicit. Enforce `publishedAt <= now` for public pages and sitemaps, remove transactional/private URLs from sitemap output, and add noindex where appropriate.
```

## Slice 8: Contracts, Generated SDK, Migrations

Tracker IDs: `CONTRACT-001`, `CONTRACT-002`, `CONTRACT-003`, `DB-001`, `DOC-001`.

Scope:

- `apps/storefront/src/lib/api/types.ts`
- `apps/storefront/src/lib/api/discounts.ts`
- `apps/storefront/src/lib/cart/server.ts`
- `apps/api/src/schemas/**`
- `packages/api-client/**`
- `packages/database/migrations/**`

Prompt:

```md
Reduce contract drift. Remove stale discount usage calls, derive storefront order payloads from generated/shared types, standardize timestamp schemas, add SDK generation drift checks, and make migration snapshot/journal handling explicit.
```

## Slice 9: Platform, Dev, Deploy, Wrangler Types

Tracker IDs: `OPS-001`, `OPS-002`, `PLAT-001`, `DEV-001`, `DEV-002`, `BUILD-001`, `BUILD-002`.

Scope:

- `package.json`
- `turbo.json`
- `scripts/*.mjs`
- `scripts/dev.sh`
- `apps/*/wrangler.jsonc`
- `apps/*/src/env.d.ts`
- `apps/api/src/hono-env.d.ts`
- storefront build-id generation

Prompt:

```md
Make platform verification honest. Fix clean-checkout build-id behavior, add focused deploy safety gates, align dev docs/scripts/ports, scope dev cleanup, add real lint coverage, include relevant Turbo inputs, and generate Cloudflare Env types from Wrangler configs.
```

## Slice 10: Notifications And Settings Credentials

Tracker IDs: `NOTIF-001`, `NOTIF-002`, `CONF-001`.

Scope:

- `apps/api/src/queue-consumer.ts`
- `apps/api/src/utils/encryption-key.ts`
- `packages/core/src/modules/notifications/**`
- `packages/core/src/modules/settings/**`
- provider credential helpers

Prompt:

```md
Unify notification and credential contracts. Share notification queue type definitions, thread credential encryption keys into SMS notification paths, and make credential encryption use the intended key consistently.
```

## Slice 11: Admin API Wrapper Simplification

Tracker IDs: `ADMIN-001`, `ADMIN-003`, `ADMIN-004`.

Scope:

- `apps/admin-v2/src/lib/api-functions/**`
- `apps/admin-v2/src/lib/api-query-options/`
- `apps/admin-v2/src/lib/api-mutations/**`
- `apps/admin-v2/src/lib/api.mutations.ts` compatibility exports only
- one selected admin domain route/component set

Current state: `ADMIN-001` is verified. The legacy admin server-function barrel has been removed, and server functions live in typed domain slices under `apps/admin-v2/src/lib/api-functions/`. Use fresh `rg` scans for volatile counts. Future admin simplification should focus on one domain at a time: remove UI casts, replace broad DTO adapters, keep URL-search loaders aligned with query keys, and reduce direct component calls where a mutation/query wrapper would be clearer.

Prompt:

```md
Simplify one existing admin API domain slice. Keep behavior unchanged, replace broad local DTO casts with generated SDK types or shared schemas, align route loaderDeps with rendered query keys, and prove the touched slice with focused typecheck/lint/tests.
```
