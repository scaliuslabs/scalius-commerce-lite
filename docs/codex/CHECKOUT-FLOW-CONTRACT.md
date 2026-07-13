# Checkout Flow Contract

Last reviewed: 2026-07-13

This note defines the merchant-facing checkout controls, their buyer-facing
effects, and the server authority that prevents a stale storefront from
bypassing them. It covers Checkout settings only; gateway credentials,
shipping setup, tax, discounts, and customer-auth provider configuration have
their own owners.

## Authority Chain

| Merchant control | Stored authority | Buyer-facing effect | Fresh server enforcement |
| --- | --- | --- | --- |
| Allow checkout without an account (`guestCheckoutEnabled`) | `site_settings.guest_checkout_enabled` | Cart allows guest checkout when true; when false, checkout requires a signed-in customer. | Order creation reads the current row. When disabled, it requires a valid customer session and requires the submitted phone to match the account phone. |
| Payment flow (`checkoutMode`) | `site_settings.checkout_mode`: `all`, `guest_cod_only`, or `gateways_only` | Public checkout config exposes every compatible method, COD only, or online gateways only. | Order creation and payment-session creation reject a method excluded by the current flow even if a stale tab submits it. |
| Require an online advance (`partialPaymentEnabled`) | `site_settings.partial_payment_enabled` | COD is hidden and an enabled online gateway is required. | Order creation rejects COD; payment-session creation derives the current deposit intent from trusted settings and order state. |
| Advance amount (`partialPaymentAmount`) | `site_settings.partial_payment_amount` | Buyer pays `min(configured advance, order total)` online. Any remaining balance is due on delivery. | Saves require a finite positive amount and a usable online gateway. SSLCommerz's BDT range is applied only when SSLCommerz is one of the usable methods. |

The admin reads and replaces this document through the dedicated
`GET/PUT /api/v1/admin/settings/checkout-flow` contract. Every `PUT` includes
the positive `expectedRevision`; D1 advances `checkout_flow_revision` exactly
once only when the expected value still matches. Saving invalidates the
checkout settings cache group after the committed compare-and-swap. Public
checkout configuration is assembled by `getCheckoutConfig()` and the final
order gate is `assertCheckoutOrderPolicy()`.

## Invariants

- Phone collection is mandatory. Guest checkout means no customer account is
  required; it does not mean anonymous delivery or omission of buyer contact
  details.
- `all` needs at least one usable configured payment method.
- `guest_cod_only` needs usable COD and cannot be combined with an online
  advance.
- `gateways_only` needs at least one usable configured online gateway.
- An advance needs a positive fixed amount and at least one usable configured
  online gateway. COD is not a selectable checkout method while it is active.
- The configured advance is denominated in the store currency. The admin must
  not hard-code a BDT symbol or impose SSLCommerz limits on Stripe/Polar-only
  stores.
- If the order total is at or below the configured advance, the buyer pays the
  full order total online; no negative or zero balance is created.
- Disabling guest checkout does not weaken phone matching: the checkout phone
  must match the signed-in customer's phone.

## Fail-Closed Readiness

Checkout readiness is more than a valid flow selection. The public config also
requires an active shipping method and an active delivery hierarchy. When guest
checkout is disabled, readiness additionally requires the dedicated credential
encryption key and at least one usable OTP provider allowed by the saved
customer-auth policy. If any required fact is incomplete, public config returns
no gateways and an unavailable status. If no usable gateway survives current
credentials, enabled-method selection, flow, and provider checks, checkout is
unavailable rather than guessing COD or a gateway.

The admin preview distinguishes three states:

- **Checking**: do not show a false failure while payment/readiness facts are
  still loading; saving is locked until payment readiness resolves.
- **Needs setup**: the chosen flow is invalid against current usable methods or
  delivery setup.
- **Unavailable**: the readiness check failed. Public checkout still fails
  closed, and the admin offers a retry instead of presenting stale success.

Delivery-readiness issues are visible but do not prevent saving an otherwise
valid payment-flow choice. This lets a merchant configure independent settings
in either order while the public surface remains unavailable until all
prerequisites are ready.

## Admin Interaction Contract

- Payment flow is an explicit three-choice radio group, not a compact dropdown
  whose consequences are hidden.
- Merchant copy describes the actual order/payment behavior and never claims
  that a guest phone has passed OTP verification.
- The preview stays visible beside the form at desktop widths and stacks below
  the first card on narrow screens. At 390 px, controls and action buttons use
  the available width without horizontal scrolling.
- The action bar reports saved versus unsaved state, permits reset to the last
  server response, and disables no-op or invalid saves.
- A stale save receives `409 CHECKOUT_FLOW_REVISION_CONFLICT`. The editor keeps
  the local draft, loads the latest document without refreshing, and offers a
  three-way merge or an explicit replacement with the latest saved version.
- Turning guest checkout off previews customer sign-in provider readiness before
  save and is rejected server-side if no configured OTP channel is usable.
- Colors use semantic design-system tokens and all readiness states have text;
  meaning does not depend on color or icons.

## Evidence

- Admin form: `apps/admin-v2/src/components/admin/settings/CheckoutFlowSettings.tsx`
- Admin/server preview parity: `apps/admin-v2/src/components/admin/settings/checkout-flow-policy.ts`
- Shared flow policy: `packages/core/src/modules/settings/checkout-flow.ts`
- Public config: `packages/core/src/modules/settings/checkout-config.service.ts`
- Fresh order gate: `apps/api/src/routes/orders.ts`
- Order/deposit commit behavior: `packages/core/src/modules/orders/orders.storefront.ts`
- Focused tests:
  - `apps/admin-v2/src/components/admin/settings/checkout-flow-policy.test.ts`
  - `apps/admin-v2/src/components/admin/settings/checkout-readiness-ui.test.ts`
  - `packages/core/src/modules/settings/checkout-flow.test.ts`
  - `packages/core/src/modules/settings/checkout-flow-admin.service.test.ts`
  - `packages/core/src/modules/settings/checkout-readiness.test.ts`
  - `packages/core/src/modules/settings/checkout-config.service.test.ts`
  - `packages/database/__tests__/checkout-flow-revision-migration.test.ts`
  - `apps/api/src/routes/orders-create.test.ts`

## Remaining Release Gaps

- The remaining balance is accurately stored as due, but merchant policy and
  operations for collecting that balance need a separate lifecycle design; do
  not imply automatic collection.
- The exact provider/setup/selection/flow/buyer projection matrix is recorded
  in [`PAYMENT-METHOD-READINESS.md`](PAYMENT-METHOD-READINESS.md). Connection
  health remains explicitly **Not checked** until a real provider probe and
  webhook-health authority exist.
- Source and responsive-contract tests cover the 390 px layout intent. A final
  dark/light browser pass should be performed against the deployed build before
  release sign-off.
