# Settings Cache Invalidation Audit

Last reviewed: 2026-07-14

This is the durable dependency map for merchant-setting writes. It answers one
question: after a committed settings mutation, which cached API/storefront
projections can still contain the old fact? Route code and focused tests remain
authoritative when this document and source disagree.

## Runtime contract

- Settings mutations commit D1/KV authority first, then call
  `invalidateApiAndScheduleStorefrontGroups()`. A queue/purge failure must not
  turn a committed settings save into a false write failure.
- API KV invalidation bumps a fence before best-effort prefix deletion, so an
  in-flight old read cannot repopulate the current namespace.
- Storefront `checkout` families are generation-scoped data caches. A
  checkout-only change does not cool unrelated HTML and therefore schedules no
  warm path.
- Groups with `bumpsHtml=true` advance the storefront HTML/L2 version and the
  purge consumer warms `/`. A bounded `htmlPaths` list adds exact warm targets.
- SEO and Storefront URL writes explicitly warm `/`, robots, the sitemap index
  and children, and both catalog feeds. Do not remove those paths when adding a
  discovery switch.
- Shipping methods are both checkout data and Product/Offer JSON-LD facts.
  Their writes therefore invalidate `checkout` plus `product-schema`; the
  latter advances rendered product HTML. Clearing only
  `global_shipping_methods` leaves already-rendered Product JSON-LD stale.

## Settings mutation matrix

`—` means no cache exists for the consumer: the runtime reads D1 on each use.
It does not mean the setting has no consequence.

| Settings domain / mutation routes | Public or admin consumers | API KV group/prefix | Storefront family / HTML effect | Warm paths | Focused proof |
| --- | --- | --- | --- | --- | --- |
| Currency `/settings/currency` | product/layout currency, checkout totals and gateway projection | `layout`, `checkout`; legacy `gw:currency` delete | layout families + checkout generations; HTML version | `/` | `site-cache-invalidation.test.ts`, `cache-invalidation.test.ts` |
| Header `/settings/header` | global header/logo/favicon/menu | `layout` | `storefront_layout_`, header/navigation; HTML version | `/` | `site-cache-invalidation.test.ts` |
| Footer `/settings/footer` | global footer/navigation/legal links | `layout` | `storefront_layout_`, footer/navigation; HTML version | `/` | `site-cache-invalidation.test.ts` |
| Navigation configs `/admin/navigation` | header/footer navigational trees | `layout` | layout/navigation; HTML version | `/` | `navigation.test.ts`, `cache-invalidation.test.ts` |
| Business `/settings/business` | OnlineStore/Product seller identity, invoice defaults, admin reads | `layout` | layout and rendered schema; HTML version | explicit `/` | `business-cache-invalidation.test.ts` |
| Theme `/settings/theme` | semantic storefront presentation document | `layout` | layout/theme consumers; HTML version | `/` | `site-cache-invalidation.test.ts` |
| Media delivery `/settings/media` | CDN URL/host policy used by layout/homepage rendering | `media` (`api:storefront:layout`, `api:storefront:homepage`) | layout/homepage; HTML version | `/` | `site-cache-invalidation.test.ts` |
| SEO, discovery, return policy `/settings/seo` | `/api/v1/seo`, canonical/schema policy, robots, sitemaps, Google/Meta feeds, homepage metadata | `homepage`, `layout`, `discovery` (`api:seo:*` fence included) | SEO, feed and sitemap families; HTML version | `/`, robots, sitemap index/children, both feeds | `site-cache-invalidation.test.ts`, `cache-invalidation.test.ts` |
| Storefront URL `/settings/storefront-url` | canonical URLs, preview links, schema/discovery origins, gateway URL helper | `homepage`, `layout`, `discovery`; `gw:site_settings` plus isolate URL key | layout/SEO/feed/sitemap; HTML version | same discovery set as SEO | `site-cache-invalidation.test.ts` |
| Hero sliders `/settings/hero-sliders/**` | homepage hero projection | `homepage` | hero/homepage; HTML version | `/` | `hero-sliders-cache-invalidation.test.ts` |
| Analytics scripts `/admin/analytics/**` | global analytics injection | `layout` | analytics/layout; HTML version | `/` | `analytics.test.ts` |
| Meta CAPI settings `/settings/meta-conversions` | browser analytics injection and API event dispatch | `layout`; successful save also clears the CAPI circuit marker | analytics/layout; HTML version | `/` | `meta-conversions-admin.test.ts` |
| CSP origins `/settings/security` | API CSP setting cache and storefront CSP/layout | `layout`; exact `security:csp_allowed_domains` is write-through | security/layout; HTML version | `/` | `system-cache-invalidation.test.ts` |
| Allowed countries `/settings/allowed-countries` | checkout/account phone country policy | `checkout` | `checkout_config` generation | none | `site-cache-invalidation.test.ts` |
| Checkout flow `/settings/checkout-flow` | checkout mode, guest/account requirement, advance payment | `checkout`; legacy site-settings cache cleanup | `checkout_config` generation | none | `system-cache-invalidation.test.ts` |
| Customer auth + WhatsApp `/settings/auth` | checkout readiness, OTP policy/provider configuration | `checkout`; legacy site-settings cache cleanup | `checkout_config` generation | none | `system-cache-invalidation.test.ts` |
| Email provider `/settings/email` | notification dispatch and customer-sign-in checkout readiness | `checkout` after any committed field update | `checkout_config` generation | none | `system-cache-invalidation.test.ts` |
| SMS provider `/settings/sms` | SMS dispatch and customer-sign-in checkout readiness | dispatch reads authoritative D1 settings for every send; save invalidates `checkout` | `checkout_config` generation | none | `sms-settings.test.ts`, `sms-cache-invalidation.test.ts` |
| Firebase `/settings/firebase` | admin push dispatch and public `/auth/firebase-config` | —; public config and service account are direct D1 reads. The local `layoutCache` key is compatibility cleanup only | — | none | `system-cache-invalidation.test.ts`, Firebase integration tests |
| Customer/admin notification channels `/settings/notification-channels/**` | order notification outbox/dispatch | —; dispatch reads D1 policy and provider-health rows | — | none | `notification-channels.test.ts` |
| Payment methods + Stripe/SSLCommerz/Polar `/settings/{payment-methods,stripe,sslcommerz,polar}` | public checkout gateways/readiness and payment runtime | provider-specific cache invalidator + `checkout` | `checkout_config` generation | none | `payments.test.ts`, `cache-invalidation.test.ts` |
| Shipping methods `/settings/shipping-methods/**` | checkout methods, cart/checkout SSR reads, Product Offer shippingDetails JSON-LD | `checkout`, `product-schema`; shipping-method API prefix | checkout generations + product page family; HTML version | `/` | `shipping-cache-invalidation.test.ts`, `cache-invalidation.test.ts` |
| Delivery locations and Pathao import `/settings/delivery-locations/**` | checkout city/zone/area selectors and readiness | `checkout` after domain mutations/import chunks | location + checkout generations | none | `delivery-locations-cache-invalidation.test.ts` |
| Delivery providers `/settings/delivery-providers/**` | fulfillment runtime and checkout readiness | `checkout` after create/update/delete/test-state mutation | checkout generations | none | `delivery-providers-cache-invalidation.test.ts` |
| Checkout languages `/settings/checkout-languages/**` | public active checkout labels/field visibility | `checkout` | `global_checkout_language` generation | none | `checkout-languages.test.ts`, `cache-invalidation.test.ts` |
| Tax settings/classes/rates/classification `/admin/taxes/**` | checkout/order tax authority | `checkout` after mutations; preview POST is read-only | `checkout_config` generation | none | `taxes.test.ts`, `cache-invalidation.test.ts` |
| Customer cancellation/return/refund request policy `/settings/customer-requests` | private account/receipt order action eligibility | —; private order reads resolve policy directly from D1 | private pages are not shared HTML cache | none | `customer-requests.test.ts`, policy/service tests |
| Fraud providers `/admin/fraud-checker/**` | order risk lookup during checkout | —; provider config is read directly at lookup time. Test/lookup POSTs are not settings commits | — | none | `fraud-checker.test.ts` |

## Non-domain mutations

- `DELETE /settings/meta-conversions/logs` and manual log cleanup mutate only
  bounded diagnostic history. They do not change public configuration.
- `POST /settings/delivery-providers/create-test` performs a transient provider
  probe and does not commit settings. Testing a stored provider updates its
  health timestamps and currently invalidates checkout conservatively.
- `DELETE /settings/delivery-locations/import-pathao` resets only the import
  progress marker. Imported location rows are invalidated by each import chunk.
- Firebase public config has no API cache middleware today. If one is added,
  give it a named API prefix/fence and extend the Firebase save test in the same
  change; do not rely on the per-isolate `layoutCache` cleanup.
- Account/session administration owns auth/session cache semantics, not
  storefront settings groups, and is intentionally outside this matrix.

## Audit findings closed on 2026-07-14

1. Email and SMS provider saves could change mandatory customer-sign-in
   readiness while `api:checkout:config:v3:*` remained cached. Both now clear
   the `checkout` group after a committed provider update.
2. Shipping-method writes cleared the shipping data cache but not cached
   product HTML containing Offer `shippingDetails`. A dedicated
   `product-schema` group now advances product-page HTML alongside the narrow
   checkout generations.
3. The operator-facing admin-path dependency map now includes email, SMS, tax,
   and the shipping Product-schema dependency, matching the route-owned write
   behavior.
4. SMS dispatch previously cached a decrypted provider instance for five
   minutes in each Worker isolate. A credential rotation could clear only the
   isolate handling the save while a warm queue consumer kept the old provider.
   Dispatch now reads and decrypts authoritative D1 settings for every send;
   the regression test proves two sends perform two reads.

No API response contract or database schema changed in this audit.
