# Payment Method Readiness

Last reviewed: 2026-07-13

This note records the exact merchant and buyer result for the four currently
supported payment methods. It is a regression matrix, not a claim that Scalius
already has provider connection tests, webhook-health scoring, credential
rotation, or a complete payment-operations center.

## State boundaries

The payment workspace keeps these facts separate:

- **Setup**: the provider's required saved values exist and pass current
  placeholder/environment validation.
- **Provider**: provider calls are enabled. Turning a provider off preserves its
  saved setup and keeps it available for historical payment operations.
- **Environment**: Stripe derives test/live from its key pair; SSLCommerz and
  Polar use their saved sandbox switch. COD has no environment.
- **Checkout selection**: the merchant has included the method in the saved
  payment-method allowlist.
- **Flow eligibility**: the saved checkout flow permits the method. COD is
  excluded by online-only/advance flows; online methods are excluded by the
  COD-only flow.
- **Connection health**: not implemented. The admin says **Not checked** rather
  than treating valid-looking credentials as a successful provider probe.
- **Buyer result**: visible only when setup, provider, selection, and flow all
  pass. The whole checkout can still be unavailable when shipping, delivery
  hierarchy, currency, or required customer sign-in readiness fails.

The pure admin projection is
`apps/admin-v2/src/components/admin/settings/payment-method-outcome.ts`.
Server authority remains
`packages/core/src/modules/payments/gateway-settings.ts`,
`packages/core/src/modules/settings/checkout-config.service.ts`, and the fresh
payment-session allowlist.

## Regression matrix

| Method | Saved situation | Admin outcome | Buyer method projection |
| --- | --- | --- | --- |
| COD | Not checkout-selected | Ready, hidden; setup not required; provider always available | Hidden |
| COD | Selected, but online-only or advance flow | Hidden by flow with the exact flow reason | Hidden |
| COD | Selected and COD-compatible flow | Visible | Visible if whole-checkout readiness also passes |
| Stripe | Required key/secret missing | Needs setup with missing-field reason | Hidden |
| Stripe | Obvious placeholder credential | Needs setup with placeholder reason; no provider call | Hidden |
| Stripe | Test/live key mismatch | Blocked with key-pair mismatch reason | Hidden |
| Stripe | Configured, provider off | Provider off; setup retained | Hidden |
| Stripe | Configured/provider on, not checkout-selected | Ready, hidden | Hidden |
| Stripe | Configured/provider on/selected, flow excludes it | Hidden by flow | Hidden |
| Stripe | Matching test keys and all method gates pass | Visible; Test mode | Visible with buyer-facing test-mode disclosure |
| Stripe | Matching live keys and all method gates pass | Visible; Live mode | Visible |
| SSLCommerz | Store ID or password missing | Needs setup with missing-field reason | Hidden |
| SSLCommerz | Obvious placeholder ID/password | Needs setup with placeholder reason; no provider call | Hidden |
| SSLCommerz | Configured, provider off | Provider off; setup retained | Hidden |
| SSLCommerz | Configured/provider on, not selected or flow-excluded | Ready, hidden or Hidden by flow | Hidden |
| SSLCommerz | Sandbox and all method gates pass | Visible; Test mode | Visible with buyer-facing test-mode disclosure |
| SSLCommerz | Live and all method gates pass | Visible; Live mode | Visible |
| Polar | Token, webhook secret, or product ID missing | Needs setup with missing-field reason | Hidden |
| Polar | Obvious placeholder token/secret/product ID | Needs setup with placeholder reason; no provider call | Hidden |
| Polar | Configured, provider off | Provider off; setup retained | Hidden |
| Polar | Configured/provider on, not selected or flow-excluded | Ready, hidden or Hidden by flow | Hidden |
| Polar | Sandbox and all method gates pass | Visible; Test mode | Visible with buyer-facing test-mode disclosure |
| Polar | Live and all method gates pass | Visible; Live mode | Visible |
| Any online provider | Credential decryption or readiness read fails | Blocked/unavailable; dependent saves lock or fail | Hidden; public checkout fails closed |
| Any method | Method passes but shipping/location/auth readiness fails | Method card can remain ready; checkout overview names the separate blocker | Public config returns no gateways and unavailable status |

## UI and save contract

- Card badges and Setup/Provider/Checkout rows come from one outcome function,
  so placeholder, disabled, unselected, flow-hidden, and visible states cannot
  drift between several rendering branches.
- Card toggles edit a local draft. **Saved/Unsaved** and the copy above the
  default method make that boundary explicit; **Reset** restores the last
  server response.
- The default selector contains only ready, selected methods allowed by the
  current checkout flow. Saving is disabled when no such method exists.
- A successful save refreshes authoritative status without replacing the whole
  workspace with an initial-loading screen. If a post-write refresh fails, the
  saved preference snapshot and last loaded workspace stay visible, a warning
  says status is stale, and dependent saves stay locked until retry succeeds.
- Payment-method saves also stay locked while the saved checkout-flow read is
  pending or unavailable. Cards say the flow result is unavailable instead of
  guessing the permissive Standard flow.
- Gateway credentials remain lazy-loaded and masked. Environment is shown only
  after setup is opened; the collapsed state says **Open setup** instead of
  guessing.

## Focused evidence

- Admin matrix: `payment-method-outcome.test.ts`
- Admin loading/interaction contract: `checkout-readiness-ui.test.ts`
- Placeholder, decryption, and Stripe environment authority:
  `packages/core/src/modules/payments/gateway-settings.test.ts`
- Admin read/write rejection and flow filtering:
  `apps/api/src/routes/admin/settings/payments.test.ts`
- Public fail-closed projection:
  `packages/core/src/modules/settings/checkout-config.service.test.ts`

## Remaining release gaps

- Add read-only provider connection tests and verified webhook/event health;
  until then **Not checked** is the only truthful status.
- Add coordinated credential rotation/cutover with historical refund support.
- Execute and record the sandbox success/failure/duplicate/webhook/refund matrix
  in `COMMERCE-SETTINGS-BENCHMARK.md` for every provider before release.
- Replace local Checkout Settings tabs with addressable authority-owned routes
  and a dirty-navigation guard. This slice does not pretend the current mounted
  tab strip solves that architecture gap.
