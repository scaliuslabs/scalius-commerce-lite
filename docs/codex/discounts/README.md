# Discounts

Last reviewed: 2026-07-20

This document records the discount authority and the merchant-facing contract.
Source, focused tests, and deployed behavior remain authoritative.

## Shipped model

- Scalius supports customer-entered codes for percentage/fixed product scope,
  percentage/fixed order-subtotal scope, and free delivery.
- Checkout accepts one discount code per order. Stored `combineWith*` columns are
  reserved data only; admin and public APIs must not present them as working
  controls until multi-discount allocation has a complete checkout design.
- `maxUsesPerOrder` is fixed to one for the same reason. Total-use and
  one-per-customer limits remain real controls.
- Customer segments are not implemented. Core rejects a non-empty segment
  instead of silently creating a promotion that applies to everyone.
- Discount codes use trimmed uppercase `A-Z`, `0-9`, underscore, and hyphen.
  Codes remain reserved while in trash; restore the existing code or permanently
  delete an unused one rather than creating an ambiguous replacement.

## Calculation and eligibility authority

- Public `/discounts/validate` is an advisory cart interaction. The order tax
  quote and synchronous order commit re-read authoritative product, variant,
  delivery, customer-phone, and discount facts before money or stock changes.
- The storefront may validate an unrestricted code before the buyer has entered
  a phone number. A one-use-per-customer code returns the structured
  `requiresCustomerPhone` result instead; the cart then focuses the existing
  checkout phone field. Do not block every code behind identity collection.
- Minimum purchase for order and delivery codes uses the merchandise subtotal,
  excluding delivery. A product-scoped code checks the subtotal and quantity of
  eligible lines only; unrelated cart lines cannot satisfy its minimums.
- Percentage results are capped at the eligible amount and rounded with the
  configured currency precision. Fixed discounts cannot make an eligible amount
  negative. Free delivery discounts waive only the authoritative delivery charge.
- A product discount must save at least one product or collection target. Scope
  resolution is fail-closed: an inactive/deleted collection, malformed
  collection config, stale membership, or empty resolved scope never falls back
  to the whole cart.
- Product and collection scope is deduplicated and bounded to 90 saved targets.
  Association inserts are chunked to stay below D1's 100-bound-parameter limit.
- Date eligibility is `[start, end)`. The date-only admin editor serializes the
  selected start at local 00:00 and the selected end at local 23:59:59.999 so the
  end date shown to a merchant remains eligible through that day.

## Usage and lifecycle

- Total-use and one-per-customer reads are buyer-friendly prechecks. D1 triggers
  on the synchronous `discount_usage` insert are the concurrency authority.
- One-per-customer prechecks read the immutable
  `discount_customer_redemptions` claim (`phone:{trimmed checkout phone}`), not
  the editable phone field on an order.
- Redemptions remain consumed when an order is cancelled/refunded because order
  status may be reactivated and reuse would create a promotion/fraud race. A
  future release-credit policy must be an explicit ledger operation, never a
  side effect of changing order status.
- Create defaults inactive. Activation/deactivation requires
  `discounts.toggle_status`; expired discounts cannot be activated without first
  extending their end date.
- Trash always deactivates. Restore always returns an inactive draft.
- Permanent delete is trash-only and is blocked when any order usage history
  exists. This preserves promotion audit evidence.
- Every current code rule has a positive `revision`. Full edits and activation
  commands submit the loaded revision, guard the complete D1 batch before any
  parent/scope write, and increment exactly once. Trash and restore also advance
  the revision so a lifecycle round trip cannot make an old editor current.

## Admin UX decisions

- The create chooser asks what the code reduces, using three compact choices.
- The activation switch uses a stable action label: `Activate after saving` on
  create and `Discount active` on edit. Draft, scheduled, active, and expired
  are lifecycle outcomes shown by the summary badge, not switch labels.
- Product discounts use a dense primary work column plus a sticky checkout
  preview. Limits state that one code is accepted per order and that redemption
  is commit-time enforced.
- False combination and multi-use-per-order controls are removed from all three
  editors and from list summaries. Saved payloads explicitly clear their legacy
  values.
- Percentage inputs reject values above 100 before submission. Code, date, and
  end-of-day normalization match core validation.
- A typed `DISCOUNT_REVISION_CONFLICT` preserves the merchant's unsaved editor
  values and requires an explicit latest-version reload. A stale one-click
  activation rolls back its optimistic state, explains the refresh, and reloads
  the authoritative row.
- Hidden legacy values that the current editor intentionally normalizes (for
  example a free-delivery rule with a zero numeric placeholder, obsolete
  combination flags, ignored order-wide scope, segment text, or a non-one
  per-order limit) are a pending repair, not a clean no-op form. The editor
  explains that saving preserves the visible offer, enables the versioned Save
  action even when no visible field changed, and writes the current canonical
  one-code rule. It must never show a list warning while silently disabling the
  only safe repair path.

## Live workflow checkpoint (2026-07-19)

- Production discount `NN7HXMAX` reproduced the legacy-repair mismatch: the
  list correctly flagged one invalid saved free-delivery value while the editor
  normalized it invisibly and disabled Save.
- The deployed editor now showed `Saved rule needs repair`, `Repair ready to
  save`, and an enabled Save action. One explicit save advanced the rule through
  its normal revisioned write, retained the active free-delivery outcome and
  BDT 1,000 merchandise minimum, and removed the list diagnostic.
- The repaired list was verified in dark mode at 1440 px and a real 390 x 844
  viewport with no horizontal overflow. The mobile card retains code, outcome,
  minimum, schedule, usage, lifecycle, and a direct edit action without
  compressing the desktop table.
- The same deployment exercise exposed an old-tab lazy-module failure after an
  asset rollout. Route-specific error boundaries now share the platform's
  one-time stale-chunk reload authority instead of trapping the merchant behind
  a generic Try Again button. The recovery is signature-bounded in session
  storage so one stale asset triggers at most one automatic reload while a
  persistent real error remains visible and manually recoverable.
- The create workflow now owns its selected outcome in validated `type` search
  state. Direct links such as `?type=amount_off_order`, refresh, back, and
  forward restore the same builder instead of silently returning to the type
  chooser. **Change type** removes only that search value and retains unrelated
  route context.

## Anonymous validation checkpoint (2026-07-20)

- The public validator now distinguishes identity-free eligibility from rules
  that actually need customer identity. An unrestricted code can be checked
  with the checkout phone field empty; a one-use-per-customer rule returns the
  typed `requiresCustomerPhone` outcome and the cart focuses the existing phone
  control without treating the code itself as invalid.
- Production proof used the active unrestricted free-delivery code `NN7HXMAX`
  with an empty phone field and applied the exact BDT 110 shipping reduction.
  A temporary active one-use code then returned `Enter your phone number to
  check this one-use discount`, applied successfully after a valid Bangladesh
  phone was entered, and was permanently deleted after the test.
- The deployment exercise found a separate stale-client boundary: a generated
  Astro entry filename had remained stable across changed cart logic while its
  response was correctly marked immutable. Storefront assets are now emitted
  below `/_astro/{BUILD_ID}/...`, so reloads and long-lived tabs cannot retain a
  previous client build under the same URL. Desktop and 390 x 844 production
  checks loaded the versioned asset path with no horizontal overflow or browser
  errors.

## Deliberate remaining gaps

These are separate product capabilities, not hidden behavior behind the current
fields:

- automatic discounts and priority/conflict resolution;
- multiple codes, deterministic stacking/allocation, and maximum aggregate caps;
- buy-X-get-Y, tiered/volume pricing, subscription/contract pricing;
- customer segments with a durable membership snapshot at redemption;
- per-market currencies and a merchant-store timezone independent of the browser;
- releasing a redemption through an explicit fraud-safe promotion credit ledger.

Do not advertise or add admin switches for these until checkout, tax allocation,
orders, refunds, analytics, and concurrency enforcement share one design.

## Benchmark direction

- [Shopify](https://help.shopify.com/en/manual/discounts/discount-combinations)
  exposes product, order, and shipping combination classes only because checkout
  owns an explicit calculation order and conflict policy. Scalius must not copy
  those switches ahead of equivalent allocation and refund truth.
- [Vendure](https://docs.vendure.io/current/core/core-concepts/promotions)
  separates promotion conditions from actions. That is the useful extensibility
  boundary for future rules, but the common code workflow should remain a
  compact outcome-first editor rather than a developer-shaped rule tree.
- [Medusa](https://docs.medusajs.com/resources/commerce-modules/promotion/campaign)
  groups promotions into campaigns with usage or spend budgets. A future
  Scalius campaign model should own shared schedule/budget state instead of
  duplicating it across codes.
- [Saleor](https://docs.saleor.io/developer/discounts/promotions) distinguishes
  catalogue-price promotions from checkout-order promotions and chooses the
  best qualifying rule. That distinction is useful only after storefront
  pricing, feed prices, checkout allocation, tax, and refunds consume the same
  evaluator.

The immediate interface remains intentionally smaller: choose the customer
outcome, enter its value and eligibility, review a plain-language summary, then
activate. Advanced promotion mechanics belong behind a shared evaluator first,
not behind speculative form controls.

## Verification

Focused coverage lives in:

- `packages/core/src/modules/discounts/discounts.validation.test.ts`
- `packages/core/src/modules/discounts/discounts.eligibility.test.ts`
- `packages/core/src/modules/discounts/discounts.service.test.ts`
- `packages/core/src/modules/discounts/discounts.revision.test.ts`
- `packages/database/__tests__/discount-revision-migration.test.ts`
- `apps/api/src/routes/discounts.test.ts`
- `apps/api/src/routes/admin/discounts.test.ts`
- `apps/api/src/routes/orders-create.test.ts`
- `apps/admin-v2/src/components/admin/discount/shared-validation.test.ts`
