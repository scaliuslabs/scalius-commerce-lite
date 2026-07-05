# Platform Goal

Last reviewed: 2026-07-05

Scalius Commerce is a lightweight, nearly complete commerce platform for small and medium businesses in Bangladesh. The product should feel cheaper to run, easier to operate, and more reliable than closed-source ecommerce SaaS.

## Product Bar

- Merchant workflows should be obvious without training: products, variants, checkout, orders, delivery, payments, notifications, analytics, and settings must explain themselves through the UI.
- Customer flows should never strand buyers: stale carts, deleted products, sold-out variants, failed OTP, failed payment, partial payment, guest receipt recovery, support requests, and post-sale history need buyer-safe repair paths.
- Bangladesh-local integrations must stay current: payment gateways, SMS, WhatsApp, delivery providers, locations, currency, COD, partial payment, Meta CAPI, and analytics.
- Every paid or external service should have a Cloudflare-native default or a first-class Cloudflare path where the platform can reasonably provide one.

## Architecture Bar

- Prefer Cloudflare-native primitives first: Workers, D1, Queues, R2, KV, Cache API, Durable Objects, Email, Turnstile, and service bindings.
- Keep D1 as the durable authority for domain facts that affect money, identity, stock, checkout, payments, sessions, or provider idempotency.
- Use KV and Cache API for speed, not authority, unless the data is explicitly safe to lose or repair.
- Use Queues for retryable async work after a durable local claim. Do not put buyer checkout completion on a queue when synchronous commit can return quickly.
- Use Durable Objects only when there is a clear coordination need that D1 CAS/transactions, queues, or cache invalidation cannot satisfy more simply.
- Simplify first. Complexity must earn its place through measurable reliability, performance, cost, or UX benefit.

## Release Bar

A stable release is credible only when:

- No open P0/P1 tracker item blocks checkout, auth, payments, orders, inventory, notifications, cache freshness, product/variant management, first-admin setup, or dashboard/storefront runtime.
- Core buyer and merchant flows pass local verification and deployed live smoke tests.
- Dummy or missing provider credentials fail closed without hot retry loops, runaway queues, noisy logs, or confusing dashboard states.
- Cache invalidation and rewarming are scoped to affected content and prove freshness without turning every write into a global purge.
- Documentation and tracker entries name what was verified, what remains risky, and which commit/deployment proved the behavior.

## Agent Operating Style

- Orchestrate parallel agents for independent audits or disjoint code slices, but keep ownership clear.
- Do not chase perfection by looping on one small UI or refactor while higher-risk checkout/payment/auth/order issues remain open.
- When a user-reported complaint points to a deeper product flaw, fix the system rule, not just the symptom.
- Commit after a meaningful verified achievement. Keep unfinished exploratory edits out of unrelated commits.
- If a context file grows because the codebase is confusing, prefer making the code/test boundary clearer over adding more prose.
