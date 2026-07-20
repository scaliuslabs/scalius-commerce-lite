# Commerce Settings Competitive Audit

Last reviewed: 2026-07-20
Code baseline inspected: `26d3fc27d`

This is the durable product and architecture decision record for Discounts,
Taxes, Checkout and payment methods, Theme, and administrator Account settings.
It complements the code-adjacent module READMEs and
[`content/THEME-TAX.md`](content/THEME-TAX.md). Source, focused tests, current
Cloudflare state, and deployed browser behavior remain authoritative.

## Release decisions

1. **Promotions replace the current code-only discount model.** A promotion has
   a method (automatic or code), typed conditions, one or more typed effects,
   deterministic priority/combination rules, campaign budgets, immutable order
   allocations, revision safety, and a test-cart simulator. The merchant UI is
   one compact builder, not three independent forms.
2. **Tax keeps its existing calculation authority.** The basis-point,
   destination, class, compound-layer, revision, and order-snapshot model is a
   strong foundation. Rework the workspace around readiness, regions/rates,
   exceptions, classification, and an exact checkout preview; do not replace
   the engine with a percentage textbox.
3. **Checkout configuration becomes an outcome-led workspace.** Separate the
   buyer flow, payments, shipping/delivery, localization, and post-purchase
   policy into addressable routes. A payment method is not one boolean: setup,
   provider state, test/live mode, checkout eligibility, and runtime health are
   distinct facts.
4. **Theme becomes a versioned presentation editor.** The primary workflow is
   semantic brand controls plus the real storefront preview, with desktop and
   mobile modes, draft/publish/history, contrast validation, and shared tokens.
   Raw CSS variables remain an advanced escape hatch.
5. **Account splits at the authority boundary.** “My profile and security” is
   personal. “Users and roles” is store administration. Invitations, active
   users, sessions, suspension, roles, and audit history must not remain four
   tabs inside a decorative profile card.
6. **No compatibility scaffolding for demo-era models.** Before the stable
   merchant release, replace weak schemas and wipe/reseed demo promotions,
   tax configuration, and presentation settings where that is cleaner. Never
   erase order/payment/inventory audit facts merely to simplify a migration;
   historical orders retain their saved calculation/allocation snapshots.

## Evidence and benchmark patterns

### Shopify

- A signed-in live-admin inspection on 2026-07-13 confirmed the current
  workflow rather than relying only on help copy. “Create discount” first asks
  for one outcome—amount off products, Buy X get Y, amount off order, or free
  shipping. The Buy X get Y editor then treats code/automatic as a method,
  keeps qualifying **Customer buys** and rewarded **Customer gets** sets
  separate, and presents one dense main column beside a continuously updated
  outcome summary. Eligibility, per-order and total limits, combination
  classes, schedule, channels, and tags remain progressive sections in the
  same workflow. Scalius should preserve that legibility, but improve it with a
  production-backed test cart, explicit rejected-candidate explanations, and a
  deliberate automatic-gift/customer-choice policy instead of requiring a
  merchant to infer checkout behavior from switches.

- Shopify distinguishes code and automatic methods and supports amount-off,
  free-shipping, and Buy X Get Y promotion types. Buy X Get Y separates the
  qualifying “customer buys” set from the discounted “customer gets” set,
  supports customer/segment/market eligibility, and schedules in the store time
  zone. It still requires buyers to add the get-item manually. See
  [Discount types](https://help.shopify.com/en/manual/discounts/discount-types),
  [Automatic discounts](https://help.shopify.com/en/manual/discounts/discount-methods/automatic-discounts),
  and [Buy X get Y discounts](https://help.shopify.com/en/manual/discounts/discount-types/buy-x-get-y).
- Combination is expressed in product, order, and shipping classes. The current
  evaluation order is product discounts, then order discounts, then shipping;
  Shopify also documents active/code caps and chooses the best eligible result
  when incompatible discounts conflict. See
  [Combining discounts](https://help.shopify.com/en/manual/discounts/discount-combinations).
- The official Buy X Get Y documentation explicitly says the free/discounted
  item is never added automatically. Merchant reports continue to identify that
  behavior as confusing and conversion-hostile; see the recent Shopify
  Community thread
  [“Buy 2 Get 1 Free” discount logic creates poor customer experience](https://community.shopify.com/t/buy-2-get-1-free-discount-logic-creates-poor-customer-experience-needs-fix-or-update/571529).
  This is directional user evidence, not a substitute for our own usability and
  cart-integrity tests.
- Shopify's theme editor uses a section/block tree, contextual settings, a real
  storefront preview, desktop/mobile modes, undo/redo, and adaptive stacked
  panels. Publishing preserves the previous theme as a draft. See
  [Theme editor overview](https://help.shopify.com/en/manual/online-store/themes/customizing-themes/theme-editor/features-overview),
  [The theme editor](https://help.shopify.com/en/manual/online-store/themes/customizing-themes/theme-editor),
  and [Publishing themes](https://help.shopify.com/en/manual/online-store/themes/managing-themes/publishing-themes).
- Shopify treats checkout/account presentation as a real previewable surface,
  while checkout form policy remains explicit. See
  [Checkout and accounts editor](https://help.shopify.com/en/manual/checkout-settings/customize-checkout-configurations),
  [Checkout style](https://help.shopify.com/en/manual/checkout-settings/customize-checkout-configurations/checkout-style),
  and [Checkout form options](https://help.shopify.com/en/manual/checkout-settings/checkout-form-options).
- Shopify makes gateway test mode conspicuous and supports successful, declined,
  failure, and chargeback simulations. Deactivated payment integrations remain
  available for outstanding returns. See
  [Payment gateway test mode](https://help.shopify.com/en/manual/checkout-settings/test-orders/payments-test-mode)
  and [Deactivating additional payment methods](https://help.shopify.com/en/manual/payments/additional-payment-methods/deactivate-payment-methods).
- Tax configuration is region/market-led, supports product/shipping overrides,
  and recommends verifying changes with the same calculation used by a draft
  order. See
  [Tax overrides and exemptions](https://help.shopify.com/en/manual/taxes/tax-overrides/),
  [Duties and taxes by market](https://help.shopify.com/en/manual/markets/customizations/duties-and-taxes),
  and [Verifying tax settings with a test order](https://help.shopify.com/en/manual/taxes/registration/migrate).
- User management separates roles, permission dependencies, status, suspension,
  device revocation, and personal account security. See
  [Managing users](https://help.shopify.com/en/manual/your-account/users/manage-users),
  [Store permissions](https://help.shopify.com/en/manual/your-account/users/roles/permissions/store-permissions),
  and [Searching and filtering users](https://help.shopify.com/en/manual/your-account/users/searching-and-filtering-users).

### Vendure

- Vendure models a promotion as constraints plus composable conditions and
  actions. Coupon code is optional, and priority is derived from the configured
  operations. This is a better extensibility boundary than adding columns for
  every new promotion idea. See
  [Promotions](https://docs.vendure.io/current/core/core-concepts/promotions)
  and the [Promotion entity](https://docs.vendure.io/current/core/reference/typescript-api/entities/promotion).
- Payment methods separate an eligibility checker from the provider handler,
  allowing availability by address, order contents/total, or customer group.
  Authorization and capture/settlement are separate state transitions. See
  [Payment methods](https://docs.vendure.io/current/core/user-guide/settings/payment-methods)
  and [Payment workflows](https://docs.vendure.io/current/core/core-concepts/payment).
- Tax categories classify variants and rates join a category to a destination
  zone. Zones are shared geographic building blocks for tax and shipping. See
  [Taxes](https://docs.vendure.io/current/core/user-guide/settings/taxes)
  and [Zones](https://docs.vendure.io/current/core/core-concepts/zones).
- Vendure's permission model exposes Promotions separately from store Settings,
  reinforcing the need for route-level domain permissions rather than a single
  broad Settings switch. See
  [Permissions](https://docs.vendure.io/current/core/core-concepts/permissions).

### Medusa

- Medusa separates the promotion, rules, application method, and campaign. The
  application method explicitly defines target (items, shipping, or order),
  allocation (`each`, `across`, or `once`), Buy X rules, and maximum quantity.
  See
  [Promotion concepts](https://docs.medusajs.com/resources/commerce-modules/promotion/concepts),
  [Application method](https://docs.medusajs.com/resources/commerce-modules/promotion/application-method),
  and [Creating a promotion](https://docs.medusajs.com/user-guide/promotions/create).
- Campaign budgets support total usage, total spend, and per-attribute usage.
  See [Campaigns](https://docs.medusajs.com/resources/commerce-modules/promotion/campaign).
- A payment collection can own several sessions/payments, and providers handle
  authorization, capture, refund, and asynchronous webhook state. See
  [Payment collections](https://docs.medusajs.com/resources/commerce-modules/payment/payment-collection),
  [Payment providers](https://docs.medusajs.com/resources/commerce-modules/payment/payment-provider),
  and [Payment webhook events](https://docs.medusajs.com/resources/commerce-modules/payment/webhook-events).
- Medusa tax regions support subregions, default rates, combinable parent rates,
  and targeted overrides for products, product types, and shipping options. See
  [Tax regions](https://docs.medusajs.com/user-guide/settings/tax-regions)
  and [Tax rates and rules](https://docs.medusajs.com/resources/commerce-modules/tax/tax-rates-and-rules).
- User and invitation management are separate workflows; pending invitations
  can be listed, resent, copied, or revoked. See
  [Users](https://docs.medusajs.com/user-guide/settings/users) and
  [Invites](https://docs.medusajs.com/user-guide/settings/users/invites).

## Current-state findings

| Domain | What is already sound | Release-blocking or high-cost gaps |
| --- | --- | --- |
| Discounts | Case-normalized global code identity; a URL-addressable replacement Promotions list/builder/test-cart; revisioned typed CRUD/preview/activate/pause/archive; exact code-promotion checkout evaluation; total/per-customer/spend-budget claims in the order batch; immutable line/shipping allocations consumed by tax and refund integrity checks; buyer-safe rejection reasons | Live typed scope is deliberately one code promotion/order with subtotal/quantity conditions and line/order/shipping effects. Automatic promotion authoring/activation, selectors/audiences, BOGO/gifts, campaign sharing, stacking, cursor pagination beyond the first bounded list wave, and item-aware refund commands remain unavailable. Legacy authoring remains a compatibility surface for codes not yet represented by typed authority and is no longer the visible sidebar destination. |
| Tax | Basis points, class hierarchy, destination scope, compound layers, version/CAS, immutable order snapshots, shared checkout calculator, truthful coverage states, and bounded saved-hierarchy stacking diagnostics | Five equally weighted tabs, merchant-facing priority field, no bulk classification, no customer exemption workflow, incomplete region/readiness mental model, and insufficient refund/rounding regression matrix. |
| Checkout/payment | D1 authority; fail-closed public config; encrypted secrets; provider readiness; checkout-policy compatibility; payment session/idempotency/webhook/refund machinery; customer-request policy | Six unrelated domains in local-state tabs; no route/deep link; gateway setup and checkout visibility are interleaved; no first-class test transaction/connection/webhook-health center; no credential rotation lifecycle; partial payment is a single fixed amount without balance-policy authoring. |
| Theme | One versioned semantic presentation document, durable drafts, real route/device preview, contrast gates, publication history, rollback, revision CAS, and cache invalidation | Header, footer, navigation, heroes, and Theme remain separate authorities; a future unified Presentation workspace must compose them without making Theme an unbounded CSS editor or changing the protected product-detail composition. |
| Account | Better Auth sessions, forced invite password setup and 2FA enrollment, one-use reset links, RBAC roles/overrides, permission checks, bounded personal session/device revocation, a dedicated Profile workspace, and URL-owned Profile/security/team sections | The current blocked-user invitation model now supports setup-email resend but is not yet a first-class pending-invite entity with expiry/revoke/copy-link state. Suspend/reactivate, recent security-event history, bulk user operations, and path-separated authority routes remain unavailable. |

### Code evidence

- Discount storage and unsupported future flags:
  `packages/database/src/schema/marketing.ts`.
- Discount validation/evaluation/CRUD:
  `packages/core/src/modules/discounts/discounts.validation.ts`,
  `discounts.eligibility.ts`, and `discounts.service.ts`.
- Replacement typed merchant workspace:
  `apps/admin-v2/src/components/admin/promotion/**`,
  `apps/admin-v2/src/routes/admin/promotions/**`, and
  `apps/admin-v2/src/lib/api-functions/promotions.ts`.
- Legacy compatibility builder and form model:
  `apps/admin-v2/src/components/admin/discount/DiscountCodeBuilder.tsx` and
  `discount-editor-model.ts`.
- Tax UI and domain:
  `apps/admin-v2/src/components/admin/taxes/**` and
  `packages/core/src/modules/tax/**`.
- Checkout/payment UI and domain:
  `apps/admin-v2/src/components/admin/settings/CheckoutSettingsPage.tsx`,
  `CheckoutFlowSettings.tsx`, `PaymentGatewaysManager.tsx`,
  `packages/core/src/modules/settings/checkout-config.service.ts`, and
  `packages/core/src/modules/payments/**`.
- Theme UI and authority:
  `apps/admin-v2/src/components/admin/settings/ThemeSettingsPage.tsx` and
  `packages/core/src/modules/settings/theme-settings.service.test.ts`.
- Account/team UI and authority:
  `apps/admin-v2/src/components/admin/account-settings/**`,
  `apps/api/src/routes/admin/auth-management.ts`, and
  `packages/core/src/auth/**`.

## Discounts and promotions

### Why the legacy implementation felt glitchy

- The first choice asks what a *code* reduces, so the architecture cannot express
  an automatic promotion even though method and effect are independent facts.
- Amount-off-order and free-shipping each implement their own large form;
  product discounts use a third section system. Defaults, date pickers,
  validation copy, summaries, activation, error handling, and layout diverge.
- `CombinationsSection.tsx` exists, and combination columns exist in D1, but the
  working form does not render the section and core rejects every true flag.
  Dead capability-shaped code makes future work and audits harder.
- `customerSegment` and `maxUsesPerOrder` are stored, but segments are rejected
  and max uses is capped at one. These are schema promises without product
  behavior.
- Current code-rule updates and activation commands require the loaded positive
  revision. A D1 batch guard covers the parent row and every scope replacement,
  advances exactly once, and returns a typed conflict rather than allowing two
  merchant tabs to silently overwrite promotion rules.
- The legacy list reported redemption totals but hid combined requirements and
  called a usage-exhausted code active. The current code surface now explains
  both saved minimums, reached usage limits, and persisted rule states checkout
  cannot honor. It still cannot explain a specific cart, cross-rule conflicts,
  line allocations, or campaign budget because those require the target
  evaluator and allocation ledger.

### Documentation re-verification and Scalius decisions (2026-07-13)

The benchmark was rechecked against the current primary documentation for
[Shopify discount methods and types](https://help.shopify.com/en/manual/discounts),
[Shopify combinations](https://help.shopify.com/en/manual/discounts/discount-combinations),
[Shopify code limits and expiry](https://help.shopify.com/en/manual/discounts/discounts-faq),
and [Vendure promotions](https://docs.vendure.io/current/core/core-concepts/promotions).
The current documents still support these observations:

- Method and outcome are separate facts. Shopify exposes automatic and code
  methods across product, order, and shipping classes; Vendure makes coupon
  code optional on a promotion built from conditions and actions.
- Combining is evaluator behavior, not presentation metadata. Shopify applies
  product, then order, then shipping classes and documents many compatibility
  restrictions. Vendure requires every configured condition to pass before
  actions run.
- Shopify currently permits up to 25 active automatic discounts and up to five
  product/order codes plus one shipping code, but applies product effects before
  evaluating order effects against the revised subtotal and selects the best
  valid result when candidates conflict. A row of combination switches cannot
  explain those consequences; the evaluator must return the basis, rejected
  candidates, and winning allocation.
- Vendure's separation remains a useful extension seam: common schedule, code,
  and per-customer constraints wrap an all-conditions-must-pass set, followed
  by one or more line, order, or shipping actions. Scalius should adopt that
  boundary without adopting side effects that cannot be made idempotent.
- Schedule, total usage, per-customer usage, target, and purchase requirements
  affect eligibility independently and must be previewed as one rule.

Merchant reports remain useful only for locating confusing boundaries. The
Shopify Community thread
[“Why aren't my automatic discount codes combining at checkout?”](https://community.shopify.com/c/shopify-discussions/why-aren-t-my-shopify-discount-codes-combining-at-checkout/m-p/2118337)
shows that merchants can enable combination-looking controls without
understanding target overlap and class restrictions. This is directional
problem evidence, not calculation authority.

A more recent Shopify Developer Community report,
[“Discount combinations: order discount with minimum subtotal”](https://community.shopify.dev/t/solved-confusion-discount-combinations-order-discount-with-minimum-subtotal/24636),
initially looked like a platform bug to its author. The result was actually the
best-value evaluator comparing an order tier against product discounts after
the product discounts changed the qualifying subtotal. This reinforces a
specific UI rule: show the exact minimum basis and AND/OR relationship, and
eventually show why a candidate won or failed. Direct merchant requests for
cheapest-item and multi-collection promotions also show the cost of workarounds
when a system lacks separate qualifying and rewarded sets; see
[this directional Shopify merchant discussion](https://www.reddit.com/r/shopify/comments/10wm9k8/cant_find_an_app_to_makes_the_kind_of_discounts_i/).

Explicit Scalius decisions:

1. The current release surface remains one checkout code per order. The admin
   says **Discount code** and **Used alone**; it does not expose automatic or
   combination controls that checkout cannot execute.
2. Create, edit, and duplicate use one compact builder and one Zod/payload
   model for product, order, and delivery outcomes. The three divergent forms
   and dead `CombinationsSection` were removed.
3. A product discount must save at least one product or collection. Empty,
   deleted, inactive, or unreadable scope is ineligible and never degrades to
   the full subtotal. Order and delivery discounts reject stray product scope.
4. Purchase amount and item quantity are independent optional requirements.
   When both exist, both must pass. Product rules count only eligible lines;
   order and delivery rules count the complete merchandise cart.
5. Duplicate always creates an inactive draft. Save failure preserves the
   local draft, dirty navigation is guarded, edit-read failure remains on the
   route with retry, and local date controls state their inclusive day bounds.
6. Public validation accepts bounded non-negative prices/totals/shipping and
   positive integral quantities only. Final checkout re-runs authority and
   preserves the evaluator's bounded buyer-safe rejection reason. It evaluates
   minimums against the server-resolved merchandise subtotal (never delivery),
   carries exact product scope into calculation, and ignores browser discount
   and shipping amounts. D1 triggers remain the concurrent authority for total
   usage and immutable canonical-phone redemption claims.
7. The builder and list show the exact amount and quantity minimums together,
   explicitly state that both are required, and never label a usage-exhausted
   code active. The list marks targetless, mismatched, invalid-schedule, and
   legacy segment/combination/per-order states for review instead of silently
   presenting unsupported saved intent as live capability.
8. Typed code promotions now own checkout whenever a submitted normalized code
   exists in the promotion authority. An inactive or ineligible typed code is a
   matched rejection and never falls through to legacy discounts. Legacy
   evaluation remains only for codes absent from typed authority. Automatic
   rules, richer targeting, cross-promotion combination, BOGO/gifts, and the
   replacement merchant builder remain unavailable rather than capability-
   shaped switches with no live enforcement.

### Target domain model

`promotions`

- identity: `id`, internal `name`, optional buyer-facing title, tags;
- lifecycle: `draft | scheduled | active | paused | expired | archived`,
  `startsAt`, `endsAt`, `timezone`, `revision`, soft-delete fields;
- method: `automatic | code`; codes move to a child table so bulk unique codes
  and single reusable codes share one promotion;
- ordering: bounded integer `priority`; lower evaluates first;
- combination policy: allowed effect classes plus a same-target policy of
  `best` or `stack`; never a mutual pairwise checkbox graph;
- campaign: optional `campaignId` for shared dates and budgets.

`promotion_conditions`

- typed condition plus normalized arguments, with initial built-ins for
  merchandise subtotal, eligible quantity, include/exclude product/variant,
  category/collection, first order, claimed customer/group/tag, destination,
  and shipping method;
- AND across condition rows for v1. Add explicit nested any/all groups only when
  the evaluator, builder, and explanation engine can all preserve them.

`promotion_effects`

- target class: `line | order | shipping`;
- value: percentage, fixed, free, or fixed target price;
- allocation: `each | across | once`, maximum quantity, eligible target rules;
- Buy X Get Y adds a qualifying buy-rule set distinct from get-target rules;
- a single promotion may contain several effects, such as order savings plus
  free shipping, without pretending they are several customer codes.

`promotion_campaigns` and budget ledgers

- optional shared dates/audience;
- total redemption-count budget, total discount-spend budget, and per-customer
  usage budget;
- reserve/claim/reconcile in the order commit transaction. Advisory cart checks
  never become the concurrency authority.

`order_discount_allocations`

- immutable rows for promotion/effect, order line or shipping target, currency,
  base amount, discounted amount, and evaluator revision;
- order and refund calculations consume saved allocations. A later promotion
  edit never reinterprets an existing order.

### Deterministic evaluation contract

1. Snapshot current cart prices, quantity, customer/account proof, destination,
   shipping selection, currency, and time.
2. Resolve all active automatic promotions plus normalized submitted codes.
3. Evaluate conditions and budgets fail-closed with a machine reason and safe
   buyer explanation.
4. Apply compatible line effects, then order effects, then shipping effects.
5. On a conflicting same target, apply the explicitly stacked set or the
   highest-saving valid candidate; break equal savings by priority then stable
   promotion ID.
6. Cap every allocation at its remaining eligible base. Total discounts cannot
   make an order, line, or shipping amount negative.
7. Re-run and atomically claim budgets/redemptions during synchronous order
   commit. Persist allocations with the order.

### Implemented promotion authority foundation (2026-07-13)

- Migration `0028_cute_ghost_rider` adds dormant promotion, code, condition,
  effect, and order-allocation tables alongside the legacy discount tables.
  D1 checks keep the first condition/effect arguments aligned with their kinds;
  code ownership stays aligned with method, and normalized codes are unique
  inside the typed promotion authority.
- Migration `0029_messy_silver_surfer` makes used effects safely mutable at the
  aggregate boundary. Replacing or removing an effect soft-retires its identity
  behind partial active-target/position indexes, so restrictive allocation FKs
  continue to preserve history. D1 triggers also reserve normalized code
  identity across both legacy discounts and typed promotions in either write
  order; application prechecks provide a useful conflict while the triggers
  close concurrent races.
- Migration `0030_messy_ultragirl` adds total redemption, per-customer
  redemption, and same-currency discount-spend limits plus one immutable
  redemption claim per order. D1 insert triggers are the serialized final
  authority after advisory preview/checkout evaluation. Claims count committed
  orders, are never deleted, and remain consumed after cancellation, return, or
  refund; a future release policy requires a separate immutable adjustment
  ledger rather than mutating historical claims.
- Evaluator version 1 separates `automatic | code` method from typed conditions
  and effects. Its deliberately bounded vocabulary is AND-ed merchandise
  subtotal/item-quantity conditions plus percentage/fixed line or order effects
  and free shipping. It applies line, then order, then shipping effects within
  one promotion and selects one best promotion by savings, priority, then stable
  ID. Candidate IDs, code choice, rejection output, and cart-line allocation are
  normalized for order-independent results.
- Every merchandise saving, including an order-level effect, is proportionally
  materialized against exact order-item bases. Shipping is the only allocation
  without an order-item target. Insert guards bind snapshots to the promotion
  revision, effect, method, active normalized code when applicable, and the
  same order item; update/delete triggers make committed rows immutable.
- A revisioned aggregate service and `/api/v1/admin/promotions` API now create,
  read, replace, list, archive, preview, activate, and pause code promotions. Parent,
  code, condition, and effect writes share one D1 batch; replacements guard the
  current positive revision and advance it exactly once. List enrichment uses
  one bounded 90-ID wave rather than per-row fan-out. Preview claims the saved
  revision and runs evaluator v1, explicitly reporting when draft status was
  assumed active for simulation. Activation/pause is revision-CAS protected,
  permission-gated, and rejects automatic rules, missing active codes/effects,
  ended schedules, and exhausted limits.
- Storefront apply-code, authoritative tax quote, order build, and synchronous
  order commit use the same typed evaluator. A typed code is re-evaluated at
  commit, its claim and exact allocations are inserted in the order batch, and
  D1 rejects concurrent final-budget losers. Existing-order retries return
  before a second evaluation or claim. Exact allocations reduce the same tax
  bases, are reconciled before refund side effects, and define conservative
  minor-unit proration for later item-aware partial refund commands.
- The live boundary is intentionally one submitted code and one winning
  promotion per order. Unknown codes alone may use legacy compatibility.
  Automatic authoring/activation, cross-promotion combination/stacking,
  audience/catalog selectors, campaign sharing, and gifts remain dormant.
  Buy X Get Y must keep
  qualifying-buy and rewarded-get sets separate; combination must expose effect
  classes/same-target policy; and the admin builder/test cart must render the
  production evaluator's applied and rejected reasons before any automatic,
  stacking, budget, or gift control becomes visible.

### Implemented merchant workspace and live proof (2026-07-20)

- The visible **Discounts** navigation now opens `/admin/promotions`. The
  replacement list owns URL-validated search and status filters, compact
  desktop rows/mobile cards, honest outcome/requirement/schedule/status
  summaries, and permission-gated creation. The legacy `/admin/discounts`
  route remains reachable only as a compatibility surface while unsupported
  targeting and automatic rules are designed against typed authority.
- One compact builder owns internal/customer naming, normalized single or bulk
  codes, independent item/order/delivery effects, subtotal and quantity
  requirements, timezone-aware schedule, total/per-customer redemption limits,
  discount-spend budget, revision state, lifecycle commands, and archive. It
  does not render automatic, stacking, audience/catalog selector, BOGO, or gift
  controls that checkout cannot yet honor.
- The builder's **Test cart** drawer calls the saved promotion preview route and
  renders the production evaluator's exact applied allocation classes. Drafts
  are explicitly marked as assumed active for simulation. Lifecycle and
  archive actions use the same create/edit/toggle/delete permission boundary as
  the API, and revision conflicts refresh the authoritative aggregate without
  misclassifying ordinary code-identity 409s.
- Authenticated production proof created `Welcome order + delivery` with code
  `WEEKENDSHIP`, 10% order savings, free delivery, a `৳5,000` subtotal
  requirement, total/per-customer/spend budgets, and `Asia/Dhaka` schedule
  authority. A test cart with `৳8,990` merchandise and `৳110` delivery
  produced exactly `৳899` order plus `৳110` shipping allocations. After
  activation the buyer cart showed `-৳1,009` and total `৳8,091`; pause
  rejected the same code as inactive, and reactivation restored the exact
  result. The production list then showed the active code, combined outcome,
  minimum-subtotal requirement, and no-end-date schedule without reopening the
  form.

### Builder information architecture

- Header: internal name, method badge, lifecycle, schedule, duplicate, archive.
- Main column: **Method → Customer gets → Applies to → Requirements → Audience →
  Combinations → Schedule and limits**.
- Sticky summary: concise natural-language rule, readiness errors, estimated
  savings for the current test cart, and Draft/Activate action.
- “Test promotion” drawer: choose existing products/SKUs, quantities, customer,
  destination, shipping, and time; show every applied/rejected promotion and
  exact allocation reason from the production evaluator.
- List: saved views for Active, Scheduled, Automatic, Codes, Needs attention,
  and Archived; compact mobile cards; method/effect/status/schedule/usage/budget
  columns; bulk pause/archive; duplicate is a first-class action.

### Promotion edge-case matrix

| Case | Required behavior |
| --- | --- |
| Lowercase or surrounding-space code | Normalize once; global case-insensitive uniqueness. |
| Duplicate bulk codes | Reject the duplicate subset without creating ambiguous identities. |
| Starts/ends at DST or store-time-zone boundary | Store UTC instants plus authored zone; preview exact effective instant. |
| Fixed discount in another currency | Convert from campaign/store currency using the order's saved rate, or mark the promotion ineligible; never guess. |
| Eligible collection becomes empty/deleted | Remains restricted and ineligible; never degrades to entire cart. |
| Product/SKU is trashed after scheduling | Omit that target and diagnose promotion readiness. |
| Percentage >100 or fixed savings >base | Reject invalid percentage; cap valid allocation at eligible base. |
| Buy and get set overlap | Select the cheapest eligible get quantities deterministically after satisfying buy quantities. |
| Free gift out of stock | Do not auto-add/reserve it; explain unavailability and keep paid lines unchanged. |
| Automatic gift | Offer only for a deterministic SKU. Add/remove idempotently as eligibility changes; never override buyer-selected variants. |
| Customer-selectable gift | Surface an explicit chooser; promotion is pending until a valid get-line exists. |
| Guest per-customer limit | Use the platform's canonical checkout phone claim; preserve immutable redemption identity. |
| Account later claims guest profile | Redemption remains one identity; do not reopen eligibility. |
| Two tabs edit one promotion | Revision conflict preserves the local draft and offers latest/diff/retry. |
| Concurrent final redemption | D1 transaction/trigger or CAS permits only the budgeted winners and releases any stock reserved by losers. |
| Code plus automatic conflict | Explain applied and rejected results; never silently replace savings. |
| Refund/partial return | Refund the saved allocation proportionally or by saved line amount; never recalculate current rules. |
| Manual order adjustment | Record a separate manual adjustment source; do not counterfeit a promotion redemption. |

## Taxes

### Keep the engine; change the merchant model

The existing engine already embodies the strongest cross-platform patterns:
variant/product/store class inheritance, destination rules, compound layers,
versioned writes, minor-unit calculation, and immutable order snapshots. The
next work should make that authority understandable and testable.

### Workspace information architecture

- **Overview:** enabled state, inclusive/exclusive outcome, default class,
  shipping policy, destinations covered/uncovered, conflicts, and last test.
- **Regions and rates:** region/delivery hierarchy first; within a region show
  the default and class overrides. Keep priority/compound in Advanced unless an
  overlap requires it.
- **Exceptions:** product, SKU, shipping, and later customer exemptions with
  inherited-source badges and bulk edit.
- **Test calculation:** same core calculator as checkout; select destination,
  products/SKUs, quantity, discount, shipping, and currency. Show taxable base,
  rate winner/layers, rounding, and buyer-visible total.
- **History/export:** revision, actor, changed facts, CSV/JSON export. Historical
  orders link to their saved tax snapshot, not current configuration.

### Tax edge-case matrix

| Case | Required behavior |
| --- | --- |
| Tax disabled or configuration unreadable | Zero tax and explicit readiness failure; never guessed rates. |
| Inclusive and exclusive price | Same saved policy in listings, cart, checkout, order, invoice, and refund. |
| Same-priority rates | One layer with an order-independent base. |
| Compound rates | Include only completed lower-priority layers. |
| Overlapping jurisdiction/rate | Diagnose before activation and preview the exact winner. |
| Missing destination | Use only an explicit store fallback; otherwise no tax plus readiness explanation. |
| Product/SKU exception | SKU overrides product; product overrides store default; show source. |
| Shipping tax override | Independent from product tax and based on saved shipping class/policy. |
| Promotion changes taxable base | Apply the documented discount allocation before tax and snapshot both. |
| Zero-, two-, and three-decimal currency | Round using currency precision at the documented line/order boundary. |
| Partial quantity refund | Use saved line tax/allocation and deterministic proration. |
| Configuration changes after order | Never change order/invoice/refund authority retroactively. |
| Bulk reclassification conflict | Aggregate revision/CAS rejects stale changes without partial silent writes. |

### Implemented coverage and overlap workflow (2026-07-13)

- One pure diagnostic model now drives both overview readiness and the Rates
  workspace. Classes distinguish all-destination, selected-only, empty, and
  exempt behavior without claiming legal completeness.
- Saved rate checks cover repeated exact scopes, all-destination plus local
  stacking, and city/zone/area ancestor overlaps proven by the active delivery
  hierarchy. Inactive rates, different tax classes, unrelated locations, and
  label similarity do not create false warnings.
- The workspace makes each result actionable: prepare a broad rate, review a
  participating rule, or test a destination through the same calculator used
  by checkout. A proposed active rate previews its existing overlaps before
  save; intentional stacking remains allowed.
- Detail output is bounded to eight cases with aggregate and hidden counts.
  This explains current saved behavior only. Registration/nexus authority,
  history/export, bulk classification, customer exemptions, and the complete
  refund/rounding matrix remain separate release work.

## Checkout and payment configuration

### Route and navigation model

Replace the six local tabs in `CheckoutSettingsPage.tsx` with addressable
settings routes and one readiness overview:

- `/admin/settings/checkout` — buyer flow, required/optional fields, guest versus
  account policy, consent, checkout branding link, and live readiness.
- `/admin/settings/payments` — payment methods and provider health.
- `/admin/settings/shipping` — shipping methods and eligibility.
- `/admin/settings/delivery-locations` — country/city/zone/area authority.
- `/admin/settings/localization` — languages and market/currency presentation.
- `/admin/settings/customer-requests` — cancellation/return/refund request
  policy and buyer preview.

The overview may link these domains, but each owns its data, permission, dirty
state, failures, and URL. A tab switch must never hide an unsaved form.

### Payment method state model

Every payment method reports these facts separately:

- `configured`: required credentials and non-secret fields exist;
- `providerEnabled`: merchant allows provider calls;
- `environment`: test or live, conspicuously labeled;
- `checkoutSelected`: merchant wants it offered;
- `eligible`: current checkout policy/customer/cart/currency/destination allows it;
- `healthy`: latest configuration test and webhook/provider signals;
- `effective`: all required facts are true.

The admin list shows one effective status plus the blocking reason. The details
drawer/page exposes setup steps, masked credentials, callback/webhook URLs with
copy actions, environment, supported currencies, test connection/transaction,
event health, credential rotation, disable, and checkout eligibility. Do not
make merchants coordinate an accordion toggle, an internal provider toggle,
and a separate checkout visibility save without a single resulting preview.

### Checkout/payment edge-case matrix

| Case | Required behavior |
| --- | --- |
| Settings/readiness read fails | Lock saves that depend on unknown facts; public checkout fails closed. |
| Credentials exist but provider is off | “Configured, provider off”; never call or display it. |
| Provider on but not checkout-selected | “Ready, hidden”; preserve credentials. |
| Checkout-selected but missing/undecryptable secret | Block save/effective state with exact missing fact. |
| Test provider on a live storefront | Persistent test-mode banner in admin and checkout; stable release gate fails. |
| Currency unsupported by gateway | Ineligible with a specific reason before session creation. |
| COD with advance deposit | Hide COD as initial payment; define allowed balance collection separately. |
| Fixed deposit exceeds total | Charge at most payable total or reject policy before publish; never create negative balance. |
| Deposit paid, balance session fails | Order retains paid allocation and offers idempotent recovery. |
| Duplicate payment click/webhook | One attempt/claim; replay returns current state without double charge/order. |
| Provider success but browser interrupted | Webhook/recovery completes the existing order/session. |
| Webhook secret rotated | Grace window or coordinated cutover; health shows last verified event. |
| Disable provider with open refunds | Hide new checkout use but retain handler/credentials needed for historical refunds. |
| Guest checkout disabled | Require a fresh claimed customer session whose canonical phone matches checkout. |
| Phone field configured optional | Reject the setting; Bangladesh identity/checkout requires phone. |
| No active shipping method/location | Block order placement and show merchant readiness, not a guessed fallback. |
| Gateway/notification provider dummy credential | Treat as not configured; no paid calls or retry storms. |

### Implemented payment-environment checkpoint (2026-07-13)

- Stripe readiness now rejects a recognizable test secret key paired with a
  live publishable key, or the reverse. The save path validates partially
  edited credentials against decrypted retained values, so a masked stored key
  cannot hide an environment mismatch.
- Public gateway configuration now emits one provider-neutral `testMode` fact
  for Stripe, SSLCommerz, and Polar. Checkout labels every test gateway with
  “Test mode · no real charge”; a temporary `sandbox` fallback keeps cached
  SSLCommerz/Polar responses truthful during rollout.
- This closes environment-pair correctness and buyer disclosure only. A stable
  release still needs provider connection tests, verified webhook health,
  credential rotation/cutover, and a release gate that rejects any effective
  test-mode gateway on a production storefront.

### Implemented payment-readiness workspace checkpoint (2026-07-13)

- One pure admin outcome model now renders COD, Stripe, SSLCommerz, and Polar
  setup, provider enablement, checkout selection, saved-flow eligibility,
  environment, and resulting buyer visibility. Missing, placeholder,
  mismatched, disabled, hidden, and flow-excluded states all project hidden;
  only the complete method chain projects visible.
- Connection health is deliberately **Not checked**. Credential shape is setup
  readiness, not proof that a provider or webhook is healthy.
- Checkout visibility is an explicit draft with Saved/Unsaved, Reset, a
  ready-method-only default selector, and a no-op/invalid save lock. A
  successful save refreshes authority without flashing the whole workspace;
  post-write refresh failure preserves the last loaded workspace, marks status
  stale, and locks dependent saves until retry. An unavailable checkout-flow
  read likewise locks payment-method saves instead of assuming Standard flow.
- The complete provider matrix and remaining boundaries are recorded in
  [`PAYMENT-METHOD-READINESS.md`](PAYMENT-METHOD-READINESS.md). Addressable
  settings routes, provider probes, webhook health, rotation, and sandbox
  transaction evidence remain release work.

### Deployed buyer-handoff checkpoint (2026-07-19)

One real `Rider Court Trainers / 40 / Sand` SKU was checked out through four
fresh browser sessions using the deployed storefront and synthetic guest buyer
facts. This is handoff/authority evidence, not a claim that the full provider
matrix is complete:

| Method | Deployed result | Order/inventory result |
| --- | --- | --- |
| Stripe test | Stripe Card Element mounted with a test publishable key and accepted the official test-card fields. An intentionally stale customer cookie was rejected before write and then cleared; the deployed recovery now presents an explicit **Continue as guest** action. The subsequent attempt reached Stripe field validation; authorization was not completed. | One incomplete Stripe order, `HXPTDZ`; no duplicate order. |
| SSLCommerz sandbox | Redirected to the official EasyCheckout sandbox with **PAY 9,100 BDT**, then completed the documented test-card and OTP success flow. The authoritative order became Paid. See the official [SSLCommerz sandbox integration guide](https://developer.sslcommerz.com/doc/v4/). | Order `SEJ5E0` is **Paid** for BDT 9,100. The first buyer return was truthfully pending during confirmation; the deployed private status reconciliation now resolves it to a successful receipt without putting receipt proof in the URL. |
| Polar sandbox | Redirected to the Polar sandbox with its explicit “payments are not processed” banner and converted USD total. No sandbox payment was submitted. | One incomplete Polar order, `MKCCC5`, labelled **Awaiting hosted payment**. |
| COD | Completed without a provider redirect and rendered the private receipt for order `1NC5RO`. | Pending, unpaid COD order with the exact BDT 8,990 subtotal, BDT 110 shipping, BDT 9,100 balance, and `40 / Sand` line. |

The admin order list and order-detail route loaded all four results without
redirecting. The SKU inventory projection showed on-hand 14, reserved 4, and
available 10, matching two incomplete online attempts, one paid but unfulfilled
online order, and the pending COD order. The Customers directory grouped the
four orders under one phone-owned guest buyer, labelled **Guest**, with a
customer-history route; guest checkout facts are therefore merchant-visible
without inventing a second customer directory.

The SSLCommerz browser initially returned before the receipt page observed the
settled D1 state. Admin already showed Paid, but the buyer page did not
reconcile its first pending snapshot. Storefront deployment
`0e039efc-64dc-4b2d-a3dd-cdc992bd6354` added a bounded same-origin status read
backed by the private httpOnly receipt cookie. The deployed endpoint returned
only `order_placed` and `updatedAt`, and the receipt rendered Paid after reload;
focused tests cover automatic reload when a pending state settles.

Still unproved: Stripe authorization, Polar sandbox completion, SSLCommerz
decline and timeout paths, delayed/duplicate webhooks, post-deploy automatic
transition during a second fresh provider attempt, capture/settlement, refunds,
credential failure, and live cutover. Do not promote this checkpoint into
“gateway healthy.”

### Verification scenarios for every gateway

Each gateway must have a documented sandbox run for: successful authorization,
decline, provider error/timeout, duplicate submit, delayed webhook, duplicate
webhook, browser interruption, capture/settlement if applicable, partial and
full refund, refund retry/reconciliation, credential failure, and test-to-live
cutover. COD adds collection evidence, partial collection, cancellation before
shipment, return after collection, and reconciliation.

## Theme and presentation

### Historical defects resolved by the versioned Theme workspace

- The page title says “Storefront Theme,” but its only durable fact is an
  allowlisted color map. Typography, density, radius, card style, container,
  buttons, header/footer, and templates live elsewhere or are hard-coded.
- `PREDEFINED_PALETTES` and fallback behavior live in the React file while the
  storefront owns its own CSS defaults. They can drift.
- “Sample Preview” is synthetic admin markup, not a real storefront route. “Use
  defaults” clears overrides and then previews admin theme variables, which can
  disagree with the storefront default.
- The custom picker popover uses `bg-white`, so it violates dark-mode surface
  semantics. The destructive preview appends alpha text to values that may be
  `hsl(...)`, producing invalid CSS rather than a reliable preview.
- Draft is browser-tab memory only. Revision CAS prevents silent overwrite, but
  there is no durable draft, history, diff, rollback, shareable preview, or
  navigation guard.
- No automated contrast or focus-visible validation blocks inaccessible pairs.

### Target model and editor

- One shared, versioned presentation schema owns semantic brand tokens,
  typography, type scale, corner style, density, container width, buttons,
  inputs, cards, and safe product-card presentation choices.
- Generate low-level CSS variables from semantic settings in shared code.
  Storefront and admin import the same defaults and preset definitions.
- Keep Hero, Header, Footer, Navigation, and Theme as separate versioned
  documents, composed by one Presentation workspace and preview session.
- Draft → Preview → Publish. A draft is durable and expected-revision guarded;
  publish creates history, invalidates/warm paths once, and keeps rollback.
- Preview actual storefront home, collection, product, cart, checkout, account,
  and content routes in desktop/mobile widths. The owner-approved product-page
  composition remains protected.
- Validate WCAG contrast for text/background, primary, secondary, destructive,
  muted text, border/focus, and disabled states before publish.
- Mobile editor uses the Shopify-style stacked pattern: structure/settings in a
  bottom sheet with the real preview retained, rather than squeezing a desktop
  two-column canvas.

### Theme edge cases

| Case | Required behavior |
| --- | --- |
| Invalid/unsupported color | Diagnose at field; never persist or silently drop on publish. |
| Contrast fails | Block publish for essential text/actions; name the pair and suggested fix. |
| Huge logo/hero asset | Preview the production transform/object-fit/focal point; never crop by accidental defaults. |
| Draft based on stale revision | Preserve draft, show latest diff, rebase or explicitly replace. |
| Publish invalidation fails | Published D1 revision remains authority; retry bounded warming without rolling back facts. |
| Rollback | Create a new revision from history; never mutate an old revision. |
| Mobile-only media absent | Fall back to desktop media with previewed crop, not a broken blank surface. |
| Dark preset | Validate every semantic surface; no hard-coded white popovers/cards. |

## My account, users, roles, and sessions

### Information architecture

- `/admin/account/profile` — display name, avatar, email state.
- `/admin/account/security` — password, 2FA method, backup codes, active
  sessions/devices, revoke-other-sessions, recent security events.
- `/admin/settings/users` — searchable/filterable Active, Pending, Suspended,
  Setup required, and 2FA required users; compact mobile cards.
- `/admin/settings/users/invites` — invite, pending list, resend, copy setup
  link only when policy permits, revoke, expiry.
- `/admin/settings/roles` — system/custom roles, permission dependencies,
  assignments, clone, safe delete.

The current secure setup-link and mandatory invited-admin 2FA flow should be
retained. What changes is lifecycle visibility and operational control.

### Account edge-case matrix

| Case | Required behavior |
| --- | --- |
| Invite email fails | Keep blocked pending invite; show resend after provider recovery. Never email a temporary password. |
| Invite expires/used twice | One use; clear status; resend creates/replaces proof safely. |
| User has multiple roles | Effective permission is explicit and explainable; dependencies cannot be silently removed. |
| Last owner/super-admin removal | Block suspension/deletion/role removal that would orphan administration. |
| User removes self | Require ownership transfer or another qualified admin; avoid accidental lockout. |
| Password reset | Revoke existing sessions according to policy and require onboarding steps still outstanding. |
| Lost device | Revoke one session/device or all others without deleting the user. |
| 2FA method change | Require fresh password/session proof and verified new method before switching. |
| Backup codes viewed/regenerated | Show once, hash at rest, invalidate old set, log security event. |
| Role changed in another tab | Revision conflict; permission cache invalidates immediately after commit. |
| Mobile team management | Identity/status first; actions in an accessible menu; no horizontal row overflow. |

### Implemented Theme and Account interface slice (2026-07-13)

- Theme now presents the existing color authority honestly: five accessible
  starting palettes, paired background/foreground rows, compact native color
  inputs, field-level sanitizer errors, and 4.5:1 contrast results for opaque
  hex pairs. A failing scored pair blocks publish.
- The old synthetic “Summer Collection” product preview and hard-coded white
  picker were removed. A semantic token map replaces it and explicitly defers
  real route/device preview to the versioned presentation editor.
- Theme reads now fail closed instead of rendering editable assumed defaults.
  Dirty state compares normalized saved values, navigation is guarded, and a
  CAS conflict blocks publish until the merchant uses the latest revision or
  explicitly rebases only their changed color fields onto it.
- Account removed the decorative cover treatment and oversized avatar. The
  compact identity row keeps profile actions reachable at mobile touch sizes,
  while navigation now distinguishes **Personal** security from **Store
  access** administration.
- The account subsection control is URL navigation rather than a simulated tab
  demo: it uses a compact desktop rail, a non-clipping mobile rail, direct
  `aria-current` state, and permission-denied deep links still fall back to
  personal security.
- Identity now states administrator and 2FA readiness explicitly. Password
  controls use semantic dark-mode-safe strength states and consistent reveal
  controls; 2FA method choices are compact pressed-choice semantics, and turning 2FA
  off requires password proof plus a destructive confirmation.
- Administrator rows stack identity, status, and actions on narrow viewports;
  long email addresses wrap instead of widening the page.
- Account subsections now survive refresh/back/forward through a validated URL
  value. The administrator workspace has searchable compact rows, one honest
  onboarding-readiness status, shape-preserving loading, retryable user/role
  failures, and a role-read failure cannot silently become an empty selector.
- Active sessions now load from current D1 authority, cap visible presentation
  at 25 rows, derive bounded device and masked-network hints, and expose only an
  HMAC-derived `acs_` command identity rather than Better Auth tokens or D1
  session row IDs. Any authenticated administrator may revoke their own
  non-current device or every other device without a team-management grant.
  Both commands revalidate and preserve the current active session; stale,
  foreign, current-session, and missing-secret cases fail closed.
- The session workspace uses stacked mobile rows, 44 px personal/action targets,
  local retry/error states, fresh-on-mount reads, and authority refresh after
  every revoke attempt. The current device is explicitly marked protected,
  empty and failed reads keep all revoke actions locked, and hidden rows remain
  covered by revoke-all.

### Implemented Account profile and setup-recovery slice (2026-07-19)

- Profile is now the default, independently addressable Account section rather
  than an identity card repeated above Two-factor, Password, Sessions, Team,
  and Roles. Unknown or permission-denied Account sections recover to Profile;
  the validated URL value survives refresh, back, and forward navigation.
- The Profile workspace owns display name and avatar editing only. Role and 2FA
  readiness are no longer decorative profile badges because their authorities
  remain in Store access and Two-factor respectively.
- An administrator still completing the forced password-setup flow can receive
  a new one-use setup link from the Administrators workspace. The command is
  permission-gated, resolves the target by administrator ID, rejects non-admin
  or already-ready accounts, and turns provider failure into a generic
  retryable outcome without logging or returning recipient/provider details.
- The deployed Profile and Administrators workspaces were re-read from the live
  authenticated DOM. Profile retained `section=profile`, Administrators retained
  `section=team`, and the personal profile card was absent from the team route.

### Implemented administrator suspension slice (2026-07-20)

- The existing Better Auth `banned` authority now powers a first-class
  suspend/restore workflow instead of introducing a parallel account state.
  Suspension and deletion of every target session commit in one guarded D1
  batch, and a second authority guard prevents two administrators from racing
  the store into a last-admin lockout.
- The current user and store owner cannot be suspended. Restoring access keeps
  the administrator's roles and overrides. Banned users were already rejected
  by both API and dashboard session authority, so the UI state matches the
  existing sign-in boundary.
- Completed administrator identities can no longer be hard-deleted through the
  team endpoint. Only unfinished password-setup invitations may be revoked;
  ready and 2FA-setup administrators must be suspended so historical ownership
  is preserved.
- The Administrators workspace distinguishes warning-level setup work from a
  destructive suspended state, exposes exact suspend/restore/revoke actions,
  and searches by lifecycle status as well as name, email, and role.

This remains an honest intermediate lifecycle. A dedicated invitation entity
with expiry/revoke timestamps, recent security-event history, bulk operations,
and path-separated authority routes remain required.

## Shared UI contract

These settings must look like one product, not five isolated component demos.

- Page background uses the shared admin canvas; work surfaces use `bg-card` and
  borders from semantic tokens in both light and dark mode. Do not hard-code
  white, zinc, green, amber, or red backgrounds without dark equivalents.
- Standard page header: compact title, one sentence at most, readiness/status,
  and one primary action. Remove decorative gradients and “release-safe” or
  architecture copy from normal merchant workflows.
- A setting row is 44–56 px high when simple. Use a details drawer/page for
  credentials and advanced rule arguments instead of nested large cards.
- URL owns selected subsection, filters, search, page, and list view. Browser
  back/forward and shared links restore the workspace.
- Every write surface has dirty state, discard, expected revision, preserved
  input on error, and conflict recovery. Switching route/tab warns when dirty.
- Loading uses shape-preserving skeletons; read failure is local, retryable, and
  never replaced with a default that can later be saved.
- Destructive actions state dependencies and outcome. Draft/inactive resources
  trash first; audit-linked records cannot be hard-deleted.
- Keyboard: logical tab order, Enter only submits the intended form, Escape
  closes the top overlay, focus returns to its trigger, and all selectors are
  searchable without a mouse.

### Mobile requirement

Mobile support is not “the desktop table scrolls.” At 320, 360, 390, and 430 px:

- no page-level horizontal overflow;
- minimum 44 px touch targets for primary controls;
- sticky bottom action bar respects safe-area insets and never covers fields;
- tabs become route rows, a compact horizontally scrollable strip with clear
  affordance, or a select—never clipped unlabeled icons;
- discount, tax, gateway, and user lists render domain cards with the same
  selection/actions as desktop;
- dialogs become full-height sheets when forms exceed one screen;
- secret fields, generated codes, URLs, and error messages wrap without
  exposing values or widening the viewport;
- dark mode is checked independently, including hover/focus/disabled/error,
  native color/date controls, charts/previews, and portal content.

## Migration stance

All deployed commerce data is currently demo data. Use that freedom deliberately:

1. Add the new promotion schema/evaluator and order allocation snapshot first.
2. Replace checkout reads/writes atomically; remove the old discounts,
   association tables, combination flags, segment string, and duplicated forms.
3. Wipe and reseed realistic demo promotions rather than maintaining a dual
   evaluator. Preserve existing demo orders only if their current discount
   totals/snapshots remain internally consistent; otherwise regenerate the demo
   orders too, while never weakening the future immutable-order rule.
4. Keep the tax schema unless a focused test proves a model defect. Demo rates
   and classes may be wiped/reseeded after the new workflow is ready.
5. Replace the theme color document with the shared presentation document.
   Import one current published palette if useful, then delete the legacy
   settings path after storefront/admin parity is proven.
6. Keep the current signed-in administrator during account IA work. Other demo
   users/invites may be reset. Never turn a demo-data reset into an auth bypass
   or a production migration precedent.

## Prioritized implementation slices

### P0 — release authority

1. **Promotion calculation specification and tests:** cart fixtures covering
   automatic/code, line/order/shipping, conflicts, BOGO, budgets, concurrent
   redemption, tax ordering, refunds, and immutable allocations.
2. **Promotion schema/evaluator cutover:** revisioned typed model, D1 commit-time
   claims, allocation snapshots, one evaluator for cart/checkout/test preview.
3. **Payment readiness and test center:** split provider/setup/visibility facts,
   test/live banner, exact blocker, test transaction, webhook health, disable
   without breaking historical refunds.
4. **Checkout configuration E2E matrix:** every checkout mode, gateway, guest
   versus account, shipping/destination readiness, failure/recovery, mobile, and
   buyer-visible error state.
5. **Account security operations:** active sessions/device revocation, invite
   lifecycle, last-admin guard, and route split before cosmetic redesign.

### P1 — merchant workflow

6. **Unified promotion builder/list/test cart:** delete the three forms and dead
   unsupported controls; add mobile cards and route-backed state.
7. **Tax workspace:** overview/readiness, region-led rates, overlap diagnostics,
   bulk classification, production-calculator preview, export/history.
8. **Checkout settings route split:** move shipping, delivery, localization, and
   customer requests to their authorities; add one concise overview.
9. **Users and roles workspace:** pending/suspended/setup states, search/filter,
   compact detail drawer, mobile actions, role dependency explanations.

### P2 — presentation system

10. **Shared semantic theme schema:** typography, radius, density, container,
    component styles, generated tokens, contrast validation.
11. **Real storefront draft preview:** actual routes, desktop/mobile, asset
    transforms/focal points, shareable draft, history, rollback.
12. **Cross-settings visual QA:** 320–1440 px, light/dark, keyboard/screen reader,
    slow/error/conflict states, and copy pass removing implementation language.

Do not begin P2 by polishing the current synthetic theme card while the Theme
authority still means “17 colors.” Likewise, do not expose discount combination
checkboxes until the evaluator and allocation ledger make them true.

## Stable-release proof

Completion requires all of the following evidence, not merely passing component
tests:

- focused domain tests for every matrix row above;
- API contract and migration checks, with generated SDK refreshed where needed;
- sequential package typechecks and builds on the 16 GB host;
- deployed desktop/mobile browser runs for creation, edit, conflict, deactivate,
  trash/restore, failure/retry, and buyer projection;
- sandbox success/failure/webhook/refund run for each enabled payment gateway;
- promotion test-cart output matching cart, checkout, order detail, refund, tax,
  invoice, analytics, and feeds where applicable;
- tax preview matching checkout and immutable order/refund snapshots;
- theme preview matching published storefront at desktop/mobile widths and
  passing contrast checks;
- invite, mandatory 2FA, session revoke, role change, suspension, and last-admin
  lockout tests;
- updated operations evidence and a clean `pnpm release:check` after sequential
  deploys.
