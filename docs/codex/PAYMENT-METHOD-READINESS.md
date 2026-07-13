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
| COD | Not checkout-selected | Available, hidden; setup not required; provider always available | Hidden |
| COD | Selected, but online-only or advance flow | Hidden by flow with the exact flow reason | Hidden |
| COD | Selected and COD-compatible flow | Visible | Visible if whole-checkout readiness also passes |
| Stripe | Required key/secret missing | Needs setup with missing-field reason | Hidden |
| Stripe | Obvious placeholder credential | Needs setup with placeholder reason; no provider call | Hidden |
| Stripe | Test/live key mismatch | Blocked with key-pair mismatch reason | Hidden |
| Stripe | Configured, provider off | Provider off; setup retained | Hidden |
| Stripe | Configured/provider on, not checkout-selected | Configured, hidden; connection still Not checked | Hidden |
| Stripe | Configured/provider on/selected, flow excludes it | Hidden by flow | Hidden |
| Stripe | Matching test keys and all method gates pass | Visible; Test mode | Visible with buyer-facing test-mode disclosure |
| Stripe | Matching live keys and all method gates pass | Visible; Live mode | Visible |
| SSLCommerz | Store ID or password missing | Needs setup with missing-field reason | Hidden |
| SSLCommerz | Obvious placeholder ID/password | Needs setup with placeholder reason; no provider call | Hidden |
| SSLCommerz | Configured, provider off | Provider off; setup retained | Hidden |
| SSLCommerz | Configured/provider on, not selected or flow-excluded | Configured, hidden or Hidden by flow; connection still Not checked | Hidden |
| SSLCommerz | Sandbox and all method gates pass | Visible; Test mode | Visible with buyer-facing test-mode disclosure |
| SSLCommerz | Live and all method gates pass | Visible; Live mode | Visible |
| Polar | Token, webhook secret, or product ID missing | Needs setup with missing-field reason | Hidden |
| Polar | Obvious placeholder token/secret/product ID | Needs setup with placeholder reason; no provider call | Hidden |
| Polar | Configured, provider off | Provider off; setup retained | Hidden |
| Polar | Configured/provider on, not selected or flow-excluded | Configured, hidden or Hidden by flow; connection still Not checked | Hidden |
| Polar | Sandbox and all method gates pass | Visible; Test mode | Visible with buyer-facing test-mode disclosure |
| Polar | Live and all method gates pass | Visible; Live mode | Visible |
| Any online provider | Credential decryption or readiness read fails | Blocked/unavailable; dependent saves lock or fail | Hidden; public checkout fails closed |
| Any method | Method passes but shipping/location/auth readiness fails | Method card keeps its method outcome; checkout overview names the separate blocker | Public config returns no gateways and unavailable status |

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

### Admin state hardening (2026-07-13)

- Payment-method selection and every lazy provider form now own explicit saved
  and draft snapshots. Provider forms expose Saved/Unsaved, Reset, no-op save
  locks, and the shared navigation guard. A gateway status refresh preserves an
  in-progress payment-method draft instead of replacing it with the last server
  response.
- A successful credential write immediately replaces submitted secret values
  with the standard mask in browser state. The subsequent method and credential
  reads remain authoritative; if either refresh fails, the committed write is
  reported as saved-but-stale and the workspace offers its existing retry path.
- Default-method fallback considers only selected, setup-complete,
  provider-enabled methods allowed by the saved checkout flow. It cannot choose
  a selected but unusable provider merely because that provider appears first
  in the display order.
- Invalid legacy flow combinations fail closed in the admin projection. A zero
  or non-finite online advance and COD-only plus advance hide every method with
  an exact Checkout Flow correction instead of projecting one side of a
  contradictory policy.
- Setup completeness is labelled **Complete**, not healthy. Configured but
  unselected online methods say **Configured, hidden** and retain a separate
  **Connection: Not checked** fact. COD may say **Available, hidden** because it
  has no credential setup. None of these labels claims a provider probe.
- Provider toggles, sandbox toggles, secret visibility buttons, setup accordions,
  and buyer-selection labels are keyboard reachable and named. Provider cards
  remain one column until the wider `lg` workspace breakpoint so the admin
  sidebar cannot force two cramped cards at tablet viewport widths.

The local matrix covers COD, Stripe, SSLCommerz, and Polar across missing setup,
provider off, blocked setup, selected/hidden, flow unknown/excluded, visible,
test/live/mixed environment, default eligibility, and every checkout mode with
and without an advance. This proves deterministic admin projection only. It
does not prove provider authorization, decline, timeout, delayed/duplicate
webhook, interrupted browser recovery, capture, settlement, refund,
reconciliation, secret rotation, or test-to-live cutover.

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
- Replace local Checkout Settings sections with separate authority-owned routes.
  Checkout Flow and Payment now guard dirty navigation, but the current mounted
  section strip remains an interim addressable-query workspace rather than the
  target route split.
