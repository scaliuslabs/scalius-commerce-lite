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

The admin saves these fields through `POST /api/v1/admin/settings/auth` because
they currently share the legacy auth/settings record. Saving invalidates the
checkout settings cache group. Public checkout configuration is assembled by
`getCheckoutConfig()` and the final order gate is `assertCheckoutOrderPolicy()`.

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
requires an active shipping method and an active delivery hierarchy. If those
facts are incomplete, it returns no gateways and an unavailable status. If no
usable gateway survives current credentials, enabled-method selection, flow,
and provider checks, checkout is unavailable rather than guessing COD or a
gateway.

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
  - `packages/core/src/modules/settings/checkout-config.service.test.ts`
  - `apps/api/src/routes/orders-create.test.ts`

## Remaining Release Gaps

- Checkout settings have no monotonic revision/CAS yet, so two merchant tabs can
  overwrite each other. The UI's dirty/reset behavior prevents accidental
  no-op writes but is not concurrency control.
- Checkout fields still share the broad `/settings/auth` mutation with customer
  authentication and legacy WhatsApp fields. A dedicated endpoint would reduce
  coupling but requires an API-contract migration.
- When guest checkout is disabled, the checkout readiness card does not yet
  expose first-class customer-auth provider health; runtime sign-in remains the
  authority.
- The remaining balance is accurately stored as due, but merchant policy and
  operations for collecting that balance need a separate lifecycle design; do
  not imply automatic collection.
- Source and responsive-contract tests cover the 390 px layout intent. A final
  dark/light browser pass should be performed against the deployed build before
  release sign-off.
