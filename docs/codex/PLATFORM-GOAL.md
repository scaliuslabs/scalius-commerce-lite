# Platform Goal

Last reviewed: 2026-07-12

Scalius Commerce is a lightweight, nearly complete commerce platform for small and medium businesses in Bangladesh. The product should feel cheaper to run, easier to operate, and more reliable than closed-source ecommerce SaaS.

## Product Bar

- Merchant workflows should be obvious without training: products, variants, checkout, orders, delivery, payments, notifications, analytics, and settings must explain themselves through the UI.
- Customer flows should never strand buyers: stale carts, deleted products, sold-out variants, failed OTP, failed payment, partial payment, guest receipt recovery, support requests, and post-sale history need buyer-safe repair paths.
- Bangladesh-local integrations and UX must stay current with real merchant/buyer behavior: payment gateways, COD, partial payment, SMS, WhatsApp, delivery providers, city/zone/area data, BDT, phone identity, Meta CAPI, and analytics.
- Every paid or external service should have a Cloudflare-native default or a first-class Cloudflare path where the platform can reasonably provide one.
- SEO and public discovery should expose accurate commerce truth: crawlable pages, canonical/noindex discipline, Merchant-compatible feeds, structured data matching checkout/SKU reality, and useful merchant-provided content. Do not ship markup that does not reflect real buyer-visible facts.
- Merchant controls should separate buyer visibility, search indexing, sitemap inclusion, feed inclusion, and structured-data output instead of hiding multiple meanings behind one switch.
- Resource canonical overrides are route-shaped same-store path controls only. They must not allow off-origin, query-string, fragment, or arbitrary dead-path canonical hacks; products use `/products/<slug>`, categories `/categories/<slug>`, collections currently use `/collections/<collectionId>` (not a collection slug), and CMS pages use one non-reserved `/<slug>` segment. Blank or invalid persisted values must cleanly fall back to the resource's normal public route.
- UCP (Universal Commerce Protocol) is the next commerce-discovery surface after SEO is proven: expose protocol capabilities only from the same checkout, SKU, payment, delivery, and policy authorities that buyers already use. The shipped UCP surface remains read-only catalog search/lookup; checkout/cart/order/payment capabilities remain hidden until their own D1 session, idempotency, signing, and payment recovery model is built.

## Architecture Bar

- Prefer Cloudflare-native primitives first: Workers, D1, Queues, R2, KV, Cache API, Durable Objects, Email, Turnstile, and service bindings.
- Keep D1 as the durable authority for domain facts that affect money, identity, stock, checkout, payments, sessions, or provider idempotency.
- Use KV and Cache API for speed, not authority, unless the data is explicitly safe to lose or repair.
- Use Queues for retryable async work after a durable local claim. Do not put buyer checkout completion on a queue when synchronous commit can return quickly.
- Use Durable Objects only when there is a clear coordination need that D1 CAS/transactions, queues, or cache invalidation cannot satisfy more simply.
- Simplify first. The best solution is the least code and least moving parts that still proves reliability, performance, cost, and UX under real pressure.
- Until a stable merchant-facing release creates real compatibility obligations, there is no legacy to protect. Do not keep bad APIs, confusing settings, weak data models, or broken UX in the name of backward compatibility.

## Release Bar

A stable release is credible only when:

- No open P0/P1 tracker item blocks checkout, auth, payments, orders, inventory, notifications, cache freshness, product/variant management, first-admin setup, or dashboard/storefront runtime.
- Core buyer and merchant flows pass local verification and deployed live smoke tests using real Cloudflare Workers paths where relevant.
- Dummy or missing provider credentials fail closed without hot retry loops, runaway queues, noisy logs, or confusing dashboard states.
- Cache invalidation and rewarming are scoped to affected content and prove freshness without turning every write into a global purge.
- Documentation and tracker entries name what was verified, what remains risky, and which commit/deployment proved the behavior.

## Stable-release work program

- The current catalog program covers Products, Categories, Attributes,
  Collections, Inventory, catalog settings, their APIs/database/cache paths,
  and every related storefront projection. Catalog completion is a release gate,
  not completion of the platform goal.
- Immediately after the catalog gate passes, audit and harden Pages, Media,
  Orders, Abandoned checkouts, Customers, Discounts, Analytics, Content,
  remaining Settings, and their storefront/buyer surfaces to the same bar.
- For every domain, cover authority and invariants, calculations, lifecycle and
  destructive edge cases, permissions, idempotency/conflicts, cache freshness,
  scale bounds, compact desktop/mobile UI, keyboard/accessibility, failure and
  recovery states, focused tests, durable decisions, deployment, and live smoke
  evidence. A cosmetic pass alone never completes a domain.
- Use the product editor's successful principles consistently: dense but
  readable work surfaces, progressive disclosure, arbitrary merchant data
  rather than hard-coded retail assumptions, explicit save/dirty/conflict
  state, direct manipulation where safe, and minimal duplicate modes or APIs.

## Engineering Operating Style

- Treat the lead thread as tech lead and product manager for goal-mode work: assign implementation work when practical, keep ownership clear, review patches, resolve conflicts, verify behavior, update docs, deploy when needed, and commit only meaningful achievements.
- Use parallel workstreams only with disjoint file ownership and concrete verification targets; the lead thread owns prioritization, integration, release judgment, and final accountability.
- After the current narrow slice, prefer not to self-implement broad code changes in the lead thread. Direct lead edits should be limited to docs, conflict resolution, tiny unblocking changes, or integration fixes that are faster and safer than another handoff.
- Do not chase perfection by looping on one small UI or refactor while higher-risk checkout/payment/auth/order issues remain open.
- When a user-reported complaint points to a deeper product flaw, fix the system rule, not just the symptom.
- When an external setup blocks proof, record the exact blocker, required owner action, and safe verification command, then move to the next code-owned risk instead of inventing speculative complexity.
- Commit after a meaningful verified achievement. Keep unfinished exploratory edits out of unrelated commits.
- If a context file grows because the codebase is confusing, prefer making the code/test boundary clearer over adding more prose.
- Keep root engineering context as an index. Add detailed guidance only to focused docs or code-adjacent README files with a clear owner, verification note, and removal path when the rule becomes enforceable in code/tests.
