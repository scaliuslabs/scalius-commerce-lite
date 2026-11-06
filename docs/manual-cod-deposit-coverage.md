# Manual COD deposit change coverage matrix

Scope: tracked working-tree diff against `master`, including pre-existing feature commits. Each row identifies a changed file and evidence for its changed behavior. This is a traceable file/unit-group inventory, not a claim of measured branch or line coverage. Tests use the production services and a fully migrated SQLite database through the production D1 adapter unless noted. Generated artifacts and pure type/copy declarations are distinguished from executable units.

## Test discovery

The checkout initially contained only eight actual source `.test.ts`/`.test.mjs` files outside ignored agent snapshots. The 103 tracked paths matching `*test*` also include fixtures, helpers, templates and docs. Root Vitest is not restricted to eight files. Its three configured serial test paths are absent, hence the serial pass reports no tests. `--passWithNoTests` belongs to the repository runner. New integration files are discovered normally. Do not present the old 190 assertions as coverage of absent historical test suites.

## New behavioral evidence

- `packages/core/src/modules/payments/manual-cod-deposit.integration.test.ts`: exact deposit persisted in plan/ledger/order, invalid amounts produce no changes, idempotency, two concurrent request keys, cancellation racing the guarded batch, real order status entry point blocks pending/cancelled plans, paid/completed guard acceptance.
- `apps/api/src/manual-cod-persistence.integration.test.ts`: actual checkout prepare+commit persists manual plan/snapshots; failed commit does not persist order/plan; real single and bulk fulfillment entry points reject unpaid/refunded plans without inventory changes; production scheduled drain restores reserved stock exactly once across concurrent/repeated invocations.
- `packages/core/src/modules/checkout/manual-cod-settings.integration.test.ts`: independent manual validation, fixed/percentage boundaries, omitted-field preservation and incompatible flow changes through the production settings writer.

## Inventory

| Changed file / unit group | Status | Traceable evidence |
|---|---|---|
| `apps/admin-v2/src/components/admin/orderview/OrderStatusCard.tsx` | Gap | No direct behavioral test of the changed unit established in this audit |
| `apps/admin-v2/src/components/admin/orderview/PaymentCard.tsx` | Gap | No direct behavioral test of the changed unit established in this audit |
| `apps/admin-v2/src/components/admin/orderview/RecordPaymentDialog.tsx` | Gap | No direct behavioral test of the changed unit established in this audit |
| `apps/admin-v2/src/components/admin/orderview/types.ts` | Declaration/copy | Typecheck/build and corresponding consumer integration; no standalone executable unit |
| `apps/admin-v2/src/components/admin/settings/PaymentsSettings.tsx` | Gap | No direct behavioral test of the changed unit established in this audit |
| `apps/admin-v2/src/components/admin/settings/checkout-flow-policy.ts` | Gap | No direct behavioral test of the changed unit established in this audit |
| `apps/admin-v2/src/i18n/order-detail.ts` | Declaration/copy | Typecheck/build and corresponding consumer integration; no standalone executable unit |
| `apps/admin-v2/src/i18n/order-payment-dialogs.ts` | Declaration/copy | Typecheck/build and corresponding consumer integration; no standalone executable unit |
| `apps/admin-v2/src/i18n/settings-payments.ts` | Declaration/copy | Typecheck/build and corresponding consumer integration; no standalone executable unit |
| `apps/admin-v2/src/lib/admin-order-status-policy.ts` | Gap | No direct behavioral test of the changed unit established in this audit |
| `apps/api/src/generated/agent-operations.gen.txt` | Generated | SDK regeneration / migration consistency gate; not an executable unit |
| `apps/api/src/generated/openapi-contract.gen.ts` | Generated | SDK regeneration / migration consistency gate; not an executable unit |
| `apps/api/src/generated/openapi-contract.gen.txt` | Generated | SDK regeneration / migration consistency gate; not an executable unit |
| `apps/api/src/routes/admin/orders-refund.ts` | Worker verification pending | refund-service.test.ts and refund-deposit.integration.test.ts (refund worker owns exact coverage) |
| `apps/api/src/routes/admin/resources.ts` | Gap | No direct behavioral test of the changed unit established in this audit |
| `apps/api/src/routes/admin/settings/payments.ts` | Covered | `apps/api/src/routes/admin/settings/payments.test.ts`: GET /payment-methods returns config and includes COD + net_terms gateway status |
| `apps/api/src/routes/admin/settings/system.ts` | Covered | `apps/api/src/routes/admin/settings/system.test.ts`: GET /checkout-readiness, GET /checkout-flow, PUT /checkout-flow rejects mismatched revision with 409 |
| `apps/api/src/routes/checkout.ts` | Covered | `apps/api/src/routes/checkout.test.ts`: GET /api/v1/checkout/config returns checkout configuration |
| `apps/api/src/routes/customer-auth/orders.ts` | Worker verification pending | buyer response/presentation tests (buyer worker owns exact coverage) |
| `apps/api/src/routes/payment/payment-method-allowlist.ts` | Covered | `apps/api/src/routes/payment/payment-method-allowlist.test.ts`: rejects disabled gateway, allows COD when enabled, fails closed on missing gateway settings |
| `apps/api/src/routes/storefront-orders/checkout.ts` | Covered | `apps/api/src/routes/storefront-orders/checkout.test.ts`: POST / rejects missing fields, invalid checkout request id, invalid quote fingerprint |
| `apps/api/src/routes/storefront-orders/receipt.ts` | Worker verification pending | buyer response/presentation tests (buyer worker owns exact coverage) |
| `apps/api/src/scheduled-maintenance.ts` | Covered | manual-cod-persistence.integration.test.ts: actual BACKGROUND_DRAINS entry under concurrent retries; manual-cod-deposit.integration.test.ts: production order status transition |
| `apps/storefront/src/lib/account-order-detail.ts` | Worker verification pending | buyer response/presentation tests (buyer worker owns exact coverage) |
| `apps/storefront/src/lib/api/checkout.ts` | Gap | No direct behavioral test of the changed unit established in this audit |
| `apps/storefront/src/lib/api/customer-auth.ts` | Gap | No direct behavioral test of the changed unit established in this audit |
| `apps/storefront/src/lib/api/types.ts` | Declaration/copy | Typecheck/build and corresponding consumer integration; no standalone executable unit |
| `apps/storefront/src/lib/checkout/index.ts` | Gap | No direct behavioral test of the changed unit established in this audit |
| `apps/storefront/src/lib/checkout/payment-mode.test.ts` | Test code | Executed by root Vitest suite; assertions reviewed separately |
| `apps/storefront/src/lib/checkout/payment-mode.ts` | Covered | apps/storefront/src/lib/checkout/payment-mode.test.ts |
| `apps/storefront/src/lib/checkout/types.ts` | Declaration/copy | Typecheck/build and corresponding consumer integration; no standalone executable unit |
| `apps/storefront/src/pages/order-success.astro` | Worker verification pending | buyer response/presentation tests (buyer worker owns exact coverage) |
| `packages/api-client/openapi.json` | Generated | SDK regeneration / migration consistency gate; not an executable unit |
| `packages/api-client/src/generated/sdk.gen.ts` | Generated | SDK regeneration / migration consistency gate; not an executable unit |
| `packages/api-client/src/generated/types.gen.ts` | Generated | SDK regeneration / migration consistency gate; not an executable unit |
| `packages/core/src/modules/agent-storefront/buyer-workflow.ts` | Gap | No direct behavioral test of the changed unit established in this audit |
| `packages/core/src/modules/checkout/authority.ts` | Covered | prepare.test.ts; manual-cod-persistence.integration.test.ts: production prepare/commit, snapshots and failed commit |
| `packages/core/src/modules/checkout/cart-validation.ts` | Gap | No direct behavioral test of the changed unit established in this audit |
| `packages/core/src/modules/checkout/commit.ts` | Covered | prepare.test.ts; manual-cod-persistence.integration.test.ts: production prepare/commit, snapshots and failed commit |
| `packages/core/src/modules/checkout/config.ts` | Gap | No direct behavioral test of the changed unit established in this audit |
| `packages/core/src/modules/checkout/flow-settings.ts` | Covered | manual-cod-settings.integration.test.ts: configuration validation, omitted-field preservation and incompatible flow |
| `packages/core/src/modules/checkout/flow.ts` | Covered | manual-cod-settings.integration.test.ts: configuration validation, omitted-field preservation and incompatible flow |
| `packages/core/src/modules/checkout/policy.ts` | Gap | No direct behavioral test of the changed unit established in this audit |
| `packages/core/src/modules/checkout/prepare.test.ts` | Test code | Executed by root Vitest suite; assertions reviewed separately |
| `packages/core/src/modules/checkout/prepare.ts` | Covered | prepare.test.ts; manual-cod-persistence.integration.test.ts: production prepare/commit, snapshots and failed commit |
| `packages/core/src/modules/delivery/tracking.ts` | Gap | No direct behavioral test of the changed unit established in this audit |
| `packages/core/src/modules/fulfilment/bulk.ts` | Partial | manual-cod-persistence.integration.test.ts covers single recordOrderFulfilment and bulkFulfillOrders; bulkShipOrders provider booking remains untested |
| `packages/core/src/modules/fulfilment/delivery-outcomes.ts` | Gap | No direct behavioral test of the changed unit established in this audit |
| `packages/core/src/modules/fulfilment/ledger.ts` | Partial | manual-cod-persistence.integration.test.ts covers single recordOrderFulfilment and bulkFulfillOrders; bulkShipOrders provider booking remains untested |
| `packages/core/src/modules/fulfilment/reconcile.ts` | Gap | No direct behavioral test of the changed unit established in this audit |
| `packages/core/src/modules/orders/account-orders.ts` | Worker verification pending | buyer response/presentation tests (buyer worker owns exact coverage) |
| `packages/core/src/modules/orders/browser.ts` | Declaration/copy | Typecheck/build and corresponding consumer integration; no standalone executable unit |
| `packages/core/src/modules/orders/status/lifecycle.test.ts` | Test code | Executed by root Vitest suite; assertions reviewed separately |
| `packages/core/src/modules/orders/status/lifecycle.ts` | Covered | manual-cod-persistence.integration.test.ts: actual BACKGROUND_DRAINS entry under concurrent retries; manual-cod-deposit.integration.test.ts: production order status transition |
| `packages/core/src/modules/orders/types.ts` | Declaration/copy | Typecheck/build and corresponding consumer integration; no standalone executable unit |
| `packages/core/src/modules/payments/gateways/identity.test.ts` | Test code | Executed by root Vitest suite; assertions reviewed separately |
| `packages/core/src/modules/payments/index.ts` | Declaration/copy | Typecheck/build and corresponding consumer integration; no standalone executable unit |
| `packages/core/src/modules/payments/manual-cod-deposit.ts` | Covered | manual-cod-deposit.integration.test.ts: persisted ledger, wrong amounts, replay, concurrent keys, plan CAS race; manual-cod-persistence.integration.test.ts: fulfillment callers |
| `packages/core/src/modules/payments/recorded-payment.ts` | Covered | manual-cod-deposit.integration.test.ts: persisted ledger, wrong amounts, replay, concurrent keys, plan CAS race; manual-cod-persistence.integration.test.ts: fulfillment callers |
| `packages/core/src/modules/payments/refund-reconciliation.ts` | Worker verification pending | refund-service.test.ts and refund-deposit.integration.test.ts (refund worker owns exact coverage) |
| `packages/core/src/modules/payments/refund-service.test.ts` | Test code | Executed by root Vitest suite; assertions reviewed separately |
| `packages/core/src/modules/payments/refund-service.ts` | Worker verification pending | refund-service.test.ts and refund-deposit.integration.test.ts (refund worker owns exact coverage) |
| `packages/core/src/modules/settings/documents.ts` | Gap | No direct behavioral test of the changed unit established in this audit |
| `packages/core/src/modules/tax/tax.service.ts` | Gap | No direct behavioral test of the changed unit established in this audit |
| `packages/core/src/testing/gift-card-checkout.ts` | Covered | prepare.test.ts; manual-cod-persistence.integration.test.ts: production prepare/commit, snapshots and failed commit |
| `packages/database/migrations/0189_magical_lucky_pierre.sql` | Covered | packages/database/src/migrations/0189_magical_lucky_pierre.test.ts; database migration preflight |
| `packages/database/migrations/meta/0189_snapshot.json` | Generated | SDK regeneration / migration consistency gate; not an executable unit |
| `packages/database/migrations/meta/_journal.json` | Generated | SDK regeneration / migration consistency gate; not an executable unit |
| `packages/database/src/migrations/0189_magical_lucky_pierre.test.ts` | Test code | Executed by root Vitest suite; assertions reviewed separately |
| `packages/database/src/schema-contract.ts` | Covered | packages/database/src/migrations/0189_magical_lucky_pierre.test.ts; database migration preflight |
| `packages/database/src/schema/orders.ts` | Covered | packages/database/src/migrations/0189_magical_lucky_pierre.test.ts; database migration preflight |
| `packages/shared/src/checkout-language.ts` | Gap | No direct behavioral test of the changed unit established in this audit |
| `packages/shared/src/runtime-secrets.ts` | Covered | `packages/shared/src/runtime-secrets.test.ts` covers `deriveRuntimeSecret`, `deriveRuntimeSecrets`, `deriveRuntimeSecretsFromEnv`, `readMasterSecret`, `RUNTIME_SECRET_PURPOSES` domain prefixes |
| `scripts/dev-admin.test.mjs` | Test code | Executed by root Vitest suite; assertions reviewed separately |
| `scripts/repository-hygiene.mjs` | Gap | No direct behavioral test of the changed unit established in this audit |

## Remaining evidence required

`Gap`, `Partial`, and worker-pending rows are not zero-coverage certification. In particular: provider booking/reconciliation/delivery outcome alternate entry points; admin record-payment and settings route authorization; dashboard payment form and settings interactions; config/readiness projections; agent checkout caller; and end-to-end buyer authorized endpoint tests need direct evidence or explicit reviewer exclusion as non-executable changes. A static import or matching string is not accepted as runtime coverage. The independent coverage reviewer must reconcile the final matrix against the final diff and tests before reporting a count of zero untested changed units.
