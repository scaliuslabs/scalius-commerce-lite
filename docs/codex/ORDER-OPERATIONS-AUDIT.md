# Order Operations Audit

Last reviewed: 2026-07-12

Status: code-backed audit and implementation contract. This file does not claim that a workflow is production-proven merely because a component or endpoint exists.

## Scope and evidence labels

This audit covers the order list, manual creation, full edit, detail workspace, invoices, trash/restore/permanent deletion, bulk actions, order/COD/payment/fulfillment states, payment recovery, refunds, returns, shipments and reconciliation, notifications, support requests, RBAC, responsive/accessibility behavior, failure states, API contracts, domain persistence, and focused tests.

Evidence labels used below:

- **Implemented**: a current code path exists.
- **Proven**: a focused behavioral test enforces the important invariant; a source-string boundary test alone is not strong proof.
- **Gap**: behavior is missing, unsafe, misleading, or insufficiently tested.
- **Active redesign**: another implementation slice owns the area. Do not create a parallel model.

Primary evidence:

- [admin order routes](../../apps/api/src/routes/admin/orders.ts), [status/COD/fulfillment routes](../../apps/api/src/routes/admin/orders-status.ts), [refund/return routes](../../apps/api/src/routes/admin/orders-refund.ts), [invoice route](../../apps/api/src/routes/admin/orders-invoice.ts), and [support-request route](../../apps/api/src/routes/admin/orders-support-requests.ts)
- [admin order service](../../packages/core/src/modules/orders/orders.admin.ts), [fulfillment service](../../packages/core/src/modules/orders/orders.fulfillment.ts), [state machine](../../packages/shared/src/order-state.ts), [refund service](../../packages/core/src/modules/payments/refund-service.ts), and [invoice service](../../packages/core/src/modules/orders/invoice.service.ts)
- [order schema](../../packages/database/src/schema/orders.ts) and [delivery schema](../../packages/database/src/schema/delivery.ts)
- [order list](../../apps/admin-v2/src/routes/admin/orders/index.tsx), [manual order form](../../apps/admin-v2/src/components/admin/OrderForm.tsx), [detail workspace](../../apps/admin-v2/src/components/admin/OrderView.tsx), and [invoice page](../../apps/admin-v2/src/routes/invoice.$orderId.tsx)
- focused tests listed in the testing section of this document

## Executive decision

The current order system has several strong recovery mechanisms, but it is not ready to be called operationally complete. Refund single-flight/reconciliation, shipment claims, notification outbox behavior, SKU validation, state-machine validation, and payment-recovery proof handling are materially stronger than the surrounding admin workflows. The largest risk is that generic CRUD and status controls can bypass those stronger workflows.

The release path should immediately narrow generic mutation authority. Financial outcomes, returns, and post-shipment corrections must be commands with their own evidence and reconciliation, not values in one mutable status dropdown. Full order editing must become a versioned amendment workflow with explicit locks after payment, fulfillment, invoice issuance, or return activity.

## Release blockers

### P0-1 — Generic order status can bypass workflow-owned facts

**Implemented:** the shared transition map exposes `returned`, `refunded`, and `partially_refunded`, and also allows `shipped -> confirmed` and `shipped -> cancelled`. The detail dropdown uses that map. The full edit form exposes every `OrderStatus`. Both the generic status endpoint and full update service accept these values.

**Gap:** a merchant can select a financial or return outcome without creating the refund allocation/provider attempt, return request/receipt/disposition, reason, actor evidence, or item-level quantity facts that should make the state true. A post-shipment backward transition can restore or re-reserve inventory despite shipment evidence. The full edit endpoint is protected by `orders.edit`, so it also bypasses the dedicated `orders.change_status` RBAC permission.

**Decision:**

1. Add a generic-admin-status allowlist immediately. At minimum, exclude `returned`, `refunded`, and `partially_refunded`; exclude post-shipment reversal/cancellation from generic controls.
2. Keep internal service transitions available to return, refund, COD, shipment, and reconciliation commands.
3. Remove the status field from the generic full-edit contract, or enforce `orders.change_status` separately and use the same restricted command policy.
4. Model post-shipment correction as an explicit reconciliation command with shipment evidence, item quantities, actor, reason, idempotency key, and inventory outcome.
5. Longer term, narrow `orders.status` to the commercial/order lifecycle and derive payment, fulfillment, return, and recovery summaries from their owning records. One dropdown must not pretend these dimensions are interchangeable.

### P0-2 — Full edit can overwrite a newer edit and rewrite settled commerce facts

**Implemented:** `orders.version` and internal CAS guards protect a single request from a concurrent mutation that lands after that request reads the row.

**Gap:** the edit response and update request do not carry `expectedVersion`. A stale browser tab therefore reads the latest version at submit time and can overwrite a change committed after the form originally loaded. Full edit is also available for paid, shipped, delivered, completed, and invoiced orders when no active recovery claim exists. It replaces all line items, may change prices/quantities/customer/address/total, and can do so after payment or shipment evidence exists.

More seriously, full edit writes `taxAmountMinor: 0`, `taxLabel: null`, and `pricesIncludeTax: false`. It does not rebuild the immutable order tax snapshot. Editing a taxed storefront order can therefore leave row-level money, the persisted tax snapshot, invoice presentation, and payment amount describing different transactions.

**Decision:**

- Add required `expectedVersion` to form data and every full-edit request; return a typed `409` with reload/compare guidance.
- Lock line, quantity, price, discount, tax, currency, and address mutations after payment capture, fulfillment, invoice finalization, return activity, or refund activity. Use explicit amendments, adjustments, or replacement orders where policy permits.
- Never zero tax facts as a side effect of editing. Manual orders must use the same authoritative tax engine and immutable money snapshots as checkout orders.
- Preserve stable order-line identity. Fulfillment, return, refund, tax, and shipment references must survive amendments; replacing every row is not a viable settled-order model.
- Add focused tests for two stale editors, paid-order edits, shipped-line edits, taxed-order edits, and invoice-issued edits.

### P0-3 — Manual order creation is not idempotent

**Implemented:** inventory reservation and the order/customer/item batch use defensive compensation. The inventory claim key is unique to the newly generated order ID.

**Gap:** the create contract has no merchant request key. If the response is lost after commit, a retry generates a new order ID, a new claim key, another order, and another stock deduction. The same risk exists for keyboard retry, reverse-proxy retry, and impatient double submission outside the single mounted form state.

**Decision:** require a client-generated `requestKey` and canonical request hash, persist an admin-create attempt record with a unique key, and return the original result on a matching replay. Reject a reused key with a different payload. Keep the key through API, core, inventory, notification, and audit events. Test response-loss replay and concurrent same-key calls.

The current post-commit deduction failure is fail-safe for overselling because stock remains reserved, but the endpoint still returns success after logging the error. Persist and show a reconciliation state instead of leaving the merchant unaware.

### P0-4 — Permanent deletion destroys regulated and operational evidence

**Implemented:** individual permanent delete requires a soft-deleted order and blocks active shipment, refund, and payment-session claims.

**Gap:** deleting the order cascades away receipts, recovery challenges, tax snapshots, payments, refund attempts, support requests/events, payment plans, COD tracking, notification outbox/receipts, and delivery shipments. The inventory ledger may retain an orphaned textual order ID, but that is not a usable order audit record.

Bulk permanent delete is worse: the service does not require `deletedAt`, so a direct API call can permanently delete active orders. It also accepts an unbounded ID array, performs inventory transitions sequentially before the final delete batch, and can leave a partially processed set if an intermediate transition fails.

**Decision:** remove hard deletion of commerce orders from normal product UI and API. Retain immutable order/payment/refund/inventory/shipment/tax evidence and support PII redaction/anonymization under an explicit retention policy. If a demo-only purge is still required, isolate it behind environment gating, super-admin step-up, a separate maintenance command, and a typed dry-run report. Never use the ordinary `orders.delete` permission for evidence destruction.

### P0-5 — Invoice allocation and historical invoices are not immutable

**Implemented:** an invoice number is lazily assigned on the first invoice GET. A settings counter uses CAS and the numeric value is cached on the order.

**Gap:** counter increment and order assignment are separate writes. Concurrent requests for the same order can consume multiple numbers and overwrite the order's first assignment; a failure after counter increment creates a gap. First-row insertion has a unique-race path that is not handled by the retry. The order update is not guarded by `invoiceNumber IS NULL`.

The invoice GET mutates state while requiring only `orders.view`. Browser prefetching or a read-only user can therefore issue an invoice number. Only the numeric suffix is stored; formatting uses the current business prefix, so changing the prefix changes how an old invoice is displayed. Business identity, address, logo, and footer are also read live, not snapshotted at finalization.

**Decision:** make invoice finalization an explicit idempotent command with a dedicated permission. Atomically claim one number and persist the complete immutable invoice identity/snapshot. GET must be read-only. Decide whether preview invoices are unnumbered. Add concurrency, failure-injection, prefix-change, business-info-change, authorization, and repeat-read tests.

### P0-6 — Returns and COD return-to-sender restore stock before receipt

**Implemented:** the current whole-order return and COD returned commands restore inventory and may initiate a refund.

**Gap:** returned goods are not sellable merely because the customer or courier reports a return. The system has no item/quantity request, approval, in-transit, warehouse-received, inspection, disposition, restock, damaged/write-off, or refund-allocation lifecycle. Generic returned status can bypass even the current reason/refund path.

**Active redesign:** item-level return/inventory work is already owned by the active return slice. Do not create a parallel schema. The accepted invariant is: availability changes only after an idempotent warehouse receipt/disposition command, and only for the approved/restockable quantities. See [Inventory and Orders Competitive Audit](./INVENTORY-ORDERS-COMPETITIVE-AUDIT.md).

## Workflow audit

### 1. Order list

**Implemented**

- Server pagination, URL-backed search/filter/sort, active/trash views, date range, order/payment/payment-method/fulfillment/recovery filters, mobile cards, and 60-second visibility-aware auto-refresh.
- Row status controls use the shared transition map; refund/shipment recovery locks are surfaced.
- Payment-recovery export is server-backed and capped at 5,000 rows with truthful cap headers.
- Bulk shipment returns per-order results; failed rows remain selected.

**Proven**

- Route/filter wiring, auto-refresh boundaries, recovery export headers, bulk busy states, and desktop/mobile fulfillment badges have focused admin/API boundary tests.
- RBAC middleware fails closed for unmapped admin routes and has focused route-permission tests.

**Gaps**

- Normal “Export CSV” exports only the currently loaded table page, not all filtered results. Label it “Export current page” immediately or add a server-backed bounded export with row count/cap metadata.
- Row action buttons on desktop and mobile are icon-only without accessible names for edit, restore, permanent delete, and delete. Tooltips are not a substitute for an accessible name.
- Recovery and payment labels use text as small as 10px in several places. Operational states must remain legible at browser zoom and under common low-vision settings.
- Bulk delete/ship schemas accept empty, duplicate, and unbounded arrays. Normalize unique IDs and cap chunks below D1's 100-bound-parameter limit; return per-ID results instead of one opaque failure for deletion.
- List refreshes can move rows while the user is selecting or editing filters. Preserve selection only for still-visible IDs, announce refresh changes, and avoid auto-refresh while a destructive dialog is open.
- No saved views, column selection, or queue presets. These are P2 productivity features after correctness work.

### 2. Manual order creation

**Implemented**

- Customer/contact/address fields, Bangladesh city/zone/area selection, line creation, lazy variant loading, quantity/price editing, shipping, additional discount, keyboard submit, unsaved-change guard, and a sticky action bar.
- Server validates active product/SKU ownership, rejects missing/deleted/mismatched SKUs, performs currency-aware rounding, prevents a discount above subtotal plus shipping, reserves inventory, commits order/items/customer changes in a batch, and converts the reservation to a deduction.

**Proven**

- SKU validation, tracked/untracked item behavior, reservation failure, compensation, quantity boundaries, and a number of inventory-claim paths have focused core tests.

**Gaps**

- No idempotency key (P0-3).
- The picker loads only the first 100 products and then searches locally. Products outside that window cannot be ordered. Loading failure is swallowed and shown as an empty catalog. Use a debounced server picker with explicit loading, retry, empty, and unavailable states.
- The API schema permits an empty item array. Decide whether this is a draft/quote feature; otherwise require at least one sellable line on the server.
- Manual creation silently defaults to COD/unpaid because payment method/status/terms are not in the form contract. The merchant is not told that every manual order becomes COD.
- The order is saved as `pending` while tracked inventory is immediately converted from reserved to deducted by invoking shipped inventory semantics. This is an invisible lifecycle policy. Let the merchant choose a truthful draft/reserve/confirmed workflow, or clearly define that a manual order is confirmed on creation and represent it consistently.
- Manual orders do not use the configured tax engine: tax is persisted as zero with no tax label or immutable tax snapshot. This makes totals and invoices unsuitable for taxed stores.
- Submitted line prices are trusted staff overrides, but the UI does not distinguish catalog price from override or require a reason. Make override explicit, show original price, require the appropriate permission, and record actor/reason/before/after.
- Admin-created item rows do not persist the same complete product/variant/money snapshot expected of an immutable order. Renames and product deletion can weaken historical display.
- Customer aggregate statistics are precomputed outside the order batch. Concurrent manual creates can overwrite each other's counters; trash/restore semantics are also not clearly represented. Prefer ledger/query-derived stats or atomic deltas with reconciliation.
- UI calculation uses floating-point/two-decimal presentation while the server uses the saved currency precision. Expose a server quote/preview using the same minor-unit calculator and return field-level differences before commit.

### 3. Full edit

**Implemented**

- The form reloads customer/address/items/shipping/discount/status and performs inventory compensation and a server-side CAS during the request.
- Active refund, hosted-payment setup, and shipment creation claims block edits.

**Proven**

- SKU validation and several inventory compensation branches are covered. There is no end-to-end proof for the stale-form, settled-order, tax, or shipment-line boundaries.

**Gaps**

- Missing client `expectedVersion` and settled-order amendment boundaries (P0-2).
- Status in full edit bypasses dedicated status permission and exposes every enum value (P0-1).
- Form-data loads every active product and then queries all variants with one `IN (...)`. This is unbounded, violates D1's 100-parameter constraint for larger catalogs, and makes edit latency grow with the entire catalog. Existing deleted/retired lines can also become impossible to represent in the picker.
- The edit loader redirects to the list for every error, so not-found, permission failure, timeout, and service outage are indistinguishable. Use a truthful route error with retry/back.
- Replacing all item rows destroys stable line identity and cascades item tax snapshots. Use line-level add/change/remove commands or versioned amendments.
- A committed write can be followed by an inventory-action update outside the main batch. If that final update fails, the order and inventory facts require reconciliation. Persist a visible recovery state and repair command.

### 4. Detail workspace

**Implemented**

- Customer/contact/address, total/payment/fulfillment summaries, items, status actions, support requests, payment history/recovery/refunds/COD, notification delivery, shipments/reconciliation, and notes.
- Primary detail has an explicit error view with retry/back. Optional panels are lazy/polled so payment or notification failures do not replace the whole workspace.

**Proven**

- Navigation/prefetch behavior, payment and notification mutation invalidation, permission projection, notification display grouping, and recovery summaries have focused tests.

**Gaps**

- Shipment and provider query errors are converted to empty arrays, making an outage look like “no shipments” or “no providers.” COD query errors similarly look like no COD record. Every operational panel needs explicit loading/error/empty distinctions and retry.
- There is no unified actor-attributed chronology. Evidence is fragmented across cards and some mutations have no actor/reason event at all. Add a single append-only order activity stream referencing the owning payment/shipment/refund/return/notification/support facts.
- The layout is readable but not optimized for high-throughput operations: large icon/info blocks and two independent status controls consume space, while recovery facts are scattered. Use a compact sticky summary rail and one chronological workspace after domain correctness is fixed.
- Fulfillment aggregate can be manually changed independently of item and shipment rows. The UI can show `complete` while every line is pending and no shipment exists. Derive it from fulfillment quantities, or represent an explicit audited override that does not masquerade as derived truth.
- The order has no visible revision, last actor, amendment history, or conflict banner.

### 5. Invoice

**Implemented**

- Authenticated print/PDF page, business information, bill-to data, line items, saved minor-unit/tax-aware display when those snapshots exist, and A4 print styles.

**Proven**

- No focused invoice allocation, authorization, snapshot, print, or PDF regression tests were found.

**Gaps**

- Allocation and snapshot failures in P0-5.
- Loader catches every error and redirects to orders, hiding not-found, permission, counter conflict, and service failure.
- PDF generation failure only logs in development; production users receive no error or retry guidance.
- Client HTML-to-canvas PDF is useful convenience, not authoritative document generation. Once invoices are finalized, produce a deterministic server-side document or immutable invoice payload with a reproducible render version and content hash.
- Historical invoice identity must not change after business settings, currency presentation, catalog names, or order lines change.

### 6. Trash, restore, and permanent delete

**Implemented**

- Soft delete restores reserved/deducted inventory and marks `deletedAt`; restore conditionally re-reserves stock and uses a version CAS. Active refund/payment/shipment claims block these actions.

**Proven**

- There are focused tests around many underlying inventory transitions, but no focused behavioral suite proving individual/bulk soft delete, restore compensation, insufficient-stock restore, permanent-delete preservation, and concurrent trash/restore.

**Gaps**

- Permanent evidence destruction and bulk bypass (P0-4).
- “Restore” can fail when stock cannot be re-reserved; the UI needs a specific conflict explanation and a deliberate resolution path, not a generic toast.
- Soft-delete, cancellation, refund, return, and customer privacy are different concepts. Trash should be an admin visibility/archive state, not a financial or fulfillment action. Do not silently use trash to perform an unrecorded cancellation.
- Destructive commands need actor, reason, expected version, request key, dry-run impact summary, and retained activity evidence.

### 7. Bulk actions

**Implemented**

- Bulk ship returns success/failure per order and enqueues shipped notifications only for newly shipped results. UI keeps failures selected. Bulk soft/permanent delete is available according to permissions.

**Proven**

- UI busy/partial-failure behavior and shipment notification boundaries have focused tests. Deletion atomicity and history preservation do not.

**Gaps**

- Bulk permanent delete is unsafe (P0-4).
- Bulk ship is sequential and has no operation-level idempotency key or resumable job record. Retrying an unknown response relies on downstream claims but offers no merchant-visible batch reconciliation.
- Bulk commands need a durable operation with snapshot count, actor, provider/options, per-order state, retryability, and downloadable result. Keep provider calls bounded and never hold D1 connections across network work.
- “Select all” means the current page. Do not imply all filtered orders unless a server-side selection token is implemented.

### 8. Order status and COD

**Implemented**

- Shared state-machine validation, version CAS during status mutation, refund/payment/shipment locks, inventory reconciliation, status notification outbox integration, COD collect/fail/return actions, amount validation, and recorded COD evidence.

**Proven**

- State-machine rules, COD side-effect ordering, status inventory reconciliation, active-claim locks, and notification behavior have substantial core/API coverage.

**Gaps**

- Generic workflow bypass (P0-1) and COD premature restock (P0-6).
- `orders.status` mixes commercial, fulfillment, return, and financial dimensions even though separate payment and fulfillment records exist. Adopt command-specific transitions and derived summaries.
- COD failure records an attempt but the operator flow lacks a clear retry/reschedule/address-correction sequence.
- COD query failure is not surfaced in the detail UI.
- Direct fulfillment aggregate editing is not synchronized with line quantities or shipment evidence.

### 9. Payments and hosted-payment recovery

**Implemented**

- Payment records and plans, payment-session attempts, masked webhook issues, polling while a payment setup/recovery is active, buyer-verified recovery URLs without receipt proof, and a bounded recovery queue/export.
- Recovery links are limited to eligible incomplete SSLCommerz/Polar orders and are blocked by active/unsafe payment evidence.

**Proven**

- Recovery-link safety, OTP/recovery proof boundaries, payment session attempt visibility, route permission enforcement, and several webhook/recovery cases have focused tests.

**Gaps**

- Recovery-link issuance uses broad `orders.edit`; COD update, notification retry, and support resolution also share broad edit authority. Introduce least-privilege order-payment, COD, notification, and support permissions where merchant teams need separation of duties.
- There is no first-class admin action for recording an offline/manual non-COD payment with reference, actor, received date, amount, currency, and immutable evidence.
- Payment and order totals can diverge after unrestricted full edit. Settled orders need adjustment/credit/debit workflows, not total replacement.
- A unified activity stream should link payment session, webhook, recovery, payment, refund, and order transitions without exposing provider secrets or bearer proofs.

### 10. Refunds

**Implemented**

- Partial/full amount entry, reason, allocation across captured payments, provider idempotency references, persisted attempts, single-flight locks, unknown/reconcile-required states, manual reconciliation, payment/order state updates, and notifications.

**Proven**

- Refund allocation, provider money, settings, visibility, recovery, route permission, and notification behavior have strong focused coverage in core/API tests.

**Gaps**

- Generic status can mark refunded/partially refunded without this workflow (P0-1).
- Refunds are amount-based, not line/quantity/tax/shipping allocation based. The active return redesign must define how item disposition and refund allocation relate without making one depend unsafely on the other.
- There is no merchant-facing credit-note document or immutable refund adjustment document.
- Refund reason is a short fixed list with no optional merchant note/evidence in the dialog. Preserve structured reason plus bounded internal note.

### 11. Returns

**Implemented:** whole-order return with reason and optional auto-refund; support requests can record return intent.

**Gap / active redesign:** see P0-6. The support-request status explicitly does not execute inventory/refund/order work, which is correct separation, but the operator lacks a guided action that converts an approved request into a return case. Integrate the existing support request with the active item-level return workflow by reference, not by duplicating state.

### 12. Fulfillment, shipments, and reconciliation

**Implemented**

- Provider readiness, shipment creation claims, insert-first provider workflow, explicit `reconcile_required` repair, provider refresh, bulk ship, own-courier fulfillment, item selection, tracking metadata, final/partial aggregate state, recovery locks, and notifications.

**Proven**

- Claim failure, foreign/duplicate/empty item IDs, failed shipment batch cleanup, final-shipment retry, reconciliation, provider status sync, active refund locks, and notification conditions have focused tests.

**Gaps**

- Manual fulfillment selects whole line IDs, not quantities. A line of quantity five cannot ship two now and three later. Fulfillment must be quantity-ledger based.
- Partial fulfillment can mark selected lines shipped while inventory conversion remains a whole-order/final action. Define and prove per-quantity reservation/deduction truth with the active inventory work.
- Direct aggregate fulfillment editing can contradict line and shipment facts.
- Post-shipment cancellation/backward status needs explicit reconciliation, not a generic status change.
- Shipment history is not part of one actor-attributed order timeline, and manual fulfillment lacks a request key exposed by the client.
- Provider and shipment secondary-read failures appear empty in the detail workspace.

### 13. Notifications

**Implemented**

- Durable outbox, dedupe keys, per-channel delivery receipts, masked recipients/errors, provider health, retries, manual resend with a request ID, polling, and explicit loading/error/empty UI.

**Proven**

- Outbox retry/resend, delivery grouping, status notification policies, manual fulfillment notification conditions, and provider-readiness settings have focused tests.

**Gaps**

- Retry/resend uses broad `orders.edit` rather than a dedicated permission.
- The detail view lacks an activity-level link between the command that caused a notification and the outbox/receipt that delivered it.
- “Send again” should require a bounded reason for sensitive/high-volume channels and show the exact masked destinations/channels before confirmation.

### 14. Support requests

**Implemented**

- Customer/guest cancellation, return, and refund requests; eligibility; one active request constraint; admin transitions; actor-attributed request events; notes; and status notifications.

**Proven**

- Eligibility, transition, active-key, actor/event, and notification behavior have focused core/API tests.

**Gaps**

- Resolution uses broad `orders.edit` rather than a support-specific permission.
- Request events are not exposed as a complete timeline in the admin card; only the current request state is prominent.
- Approved requests do not launch/link the required cancellation, return, or refund command. Keep approval separate, but offer the next truthful action and record its resulting entity ID.

## RBAC and authority audit

**Strong current behavior**

- API middleware uses explicit route-permission mapping and fails closed for unmapped routes.
- Dedicated permissions exist for view, create, edit, delete, restore, change status, manage shipments, and refund.
- Return auto-refund performs a second refund-permission check.
- UI hides/disables many actions using the same permission projection; API remains authoritative.

**Required corrections**

- Full update under `orders.edit` must not change status and bypass `orders.change_status`.
- Invoice GET under `orders.view` must not allocate a number.
- Permanent evidence destruction must not share ordinary delete permission.
- Consider dedicated permissions for payment recovery/manual payment/COD, support resolution, and notification retry/resend.
- Every sensitive command needs server-derived actor ID, expected revision, request key, reason where appropriate, and an append-only event.
- Add a permission matrix test that invokes every order route with the nearest lower-privilege role, not only source mapping assertions.

## Loading, empty, error, and conflict contract

Every order surface must distinguish these states:

1. no matching data;
2. no data exists;
3. secondary subsystem unavailable;
4. permission denied;
5. resource not found or archived;
6. stale revision/conflict;
7. active operation lock;
8. provider outcome unknown/reconciliation required;
9. mutation succeeded but cache/notification follow-up failed;
10. bounded result/export was truncated.

Current good examples are the list error/retry state, notification panel error/retry, payment recovery banners, refund/shipment locks, and recovery export cap metadata. Current failures are the new-order loader's empty-catalog fallback, edit/invoice catch-all redirects, shipment/provider/COD empty fallbacks, and generic mutation toasts that do not identify a stale revision or a committed-but-reconciliation-required outcome.

Use typed error codes and structured conflict details. Do not parse message strings to decide recovery. After a `409`, retain unsaved form input, show the server revision/change summary, and let the merchant reload or deliberately reapply allowed fields.

## Calculation and persistence invariants

The following must become executable tests and database/service invariants:

- Money is stored and calculated in saved currency minor units with a saved decimal precision; floating-point values are compatibility projections, not authority.
- `total = subtotal + shipping + tax - discounts`, with explicit inclusive/exclusive tax policy and deterministic line/tax/discount allocation.
- A manual order and a storefront order use the same tax, discount, currency, and line-snapshot engine.
- Captured payments, refunds, balance due, invoice totals, and credit notes reconcile exactly in the order currency.
- Order-line identity is stable. Ordered, reserved, fulfilled, cancelled, returned, restocked, written-off, and refunded quantities reconcile per line and never become negative or exceed ordered quantity.
- Fulfillment/payment/return aggregate summaries are derived from owning rows or updated atomically with them; a standalone dropdown cannot create contradictory aggregates.
- Inventory changes use idempotent ledger-v2 edges in the same atomic unit as stock-version CAS, per root `AGENTS.md`.
- Invoice identity and finalized invoice facts are immutable.
- Commerce evidence is retained; privacy removal redacts PII without erasing transaction history.
- Every externally retryable command has a stable request key and request hash.

## Architecture target

Use command-specific boundaries instead of expanding generic CRUD:

```text
Order commercial lifecycle
  ├─ line/money/tax snapshot + versioned amendments
  ├─ payment ledger → payment summary
  ├─ fulfillment quantity ledger → fulfillment summary
  ├─ shipment attempts/claims → shipment recovery summary
  ├─ return case + receipt/disposition → return summary
  ├─ refund allocations/attempts → refund recovery summary
  ├─ notification outbox/receipts
  └─ append-only actor activity stream referencing every owning fact
```

Representative commands: create manual order, amend draft, confirm, cancel pre-shipment, create fulfillment, reconcile shipment, record COD attempt/collection, open return, approve return, receive/inspect return, restock/write off, issue refund, reconcile refund, finalize invoice, archive, redact PII. Each command owns validation, RBAC, expected version, idempotency, evidence, side-effect ordering, and recovery semantics.

## Test coverage assessment

**Materially proven areas**

- state-machine validation: [order-state-machine.test.ts](../../packages/core/src/modules/orders/order-state-machine.test.ts)
- storefront checkout/ingest idempotency and inventory: [checkout-attempts.test.ts](../../packages/core/src/modules/orders/checkout-attempts.test.ts), [orders.ingest.test.ts](../../packages/core/src/modules/orders/orders.ingest.test.ts)
- admin SKU validation and inventory compensation: [orders.admin-sku-validation.test.ts](../../packages/core/src/modules/orders/orders.admin-sku-validation.test.ts)
- fulfillment claims, reconciliation, and COD: [orders.fulfillment.test.ts](../../packages/core/src/modules/orders/orders.fulfillment.test.ts)
- payment recovery: [order-payment-recovery.test.ts](../../packages/core/src/modules/orders/order-payment-recovery.test.ts), [order-payment-recovery-link.test.ts](../../packages/core/src/modules/orders/order-payment-recovery-link.test.ts), [orders-payment-recovery-link.test.ts](../../apps/api/src/routes/admin/orders-payment-recovery-link.test.ts)
- support requests: [order-support-requests.test.ts](../../packages/core/src/modules/orders/order-support-requests.test.ts)
- admin route/RBAC/OpenAPI boundaries: [admin-auth.test.ts](../../apps/api/src/middleware/admin-auth.test.ts), [orders-openapi-contract.test.ts](../../apps/api/src/routes/admin/orders-openapi-contract.test.ts)
- notification and shipment route behavior: [orders-notifications.test.ts](../../apps/api/src/routes/admin/orders-notifications.test.ts), [orders-manual-fulfillment-notifications.test.ts](../../apps/api/src/routes/admin/orders-manual-fulfillment-notifications.test.ts), [shipment-status-sync.test.ts](../../apps/api/src/routes/admin/shipment-status-sync.test.ts)
- admin list/detail/mutation presentation boundaries: [order list tests](../../apps/admin-v2/src/routes/admin/orders/-order-list-interactions.test.ts), [detail prefetch tests](../../apps/admin-v2/src/routes/admin/orders/-order-detail-prefetch.test.ts), [order mutation tests](../../apps/admin-v2/src/lib/api-mutations/orders.test.ts)

**Missing focused proof**

- manual-create idempotency and unknown-response replay;
- stale full-edit rejection and settled-order amendment locks;
- tax-preserving manual create/edit and immutable order-line snapshots;
- individual/bulk trash, restore, insufficient-stock restore, concurrent restore, and history-preserving privacy/purge behavior;
- invoice allocation concurrency, atomicity, immutable prefix/business snapshot, authorization, deterministic rendering, and PDF failure UI;
- generic status allowlist and proof that workflow-owned states cannot be reached through CRUD;
- per-quantity partial fulfillment and the return receipt/disposition lifecycle;
- server-backed normal CSV export and D1-safe bulk size limits;
- secondary-panel error truthfulness;
- automated keyboard/screen-reader/mobile action coverage;
- full API permission matrix and actor/activity-event completeness.

Source-string boundary tests are useful wiring alarms but do not replace service tests with concurrent calls, failure injection, and persisted-state assertions.

## Maintainable implementation sequence

### Phase 0 — close bypasses before adding UI

1. Add failing tests for generic status bypass, `orders.edit` status bypass, active bulk permanent delete, invoice same-order concurrency, stale edit, and manual-create replay.
2. Restrict generic status mutations and remove workflow-owned states/post-shipment reversal from generic UI/API.
3. Disable ordinary hard delete; retain soft archive and design PII redaction/demo purge separately.
4. Add manual-create idempotency.
5. Make invoice reads non-mutating; implement atomic explicit finalization and immutable snapshots.

### Phase 1 — versioned, truthful order mutation

1. Add `expectedVersion` to detail/form/update and typed conflict UI.
2. Split draft amendment from settled-order adjustments; lock destructive line/money/tax edits after settlement evidence.
3. Route manual order calculations through the checkout money/tax snapshot engine.
4. Replace unbounded create/edit catalog loading with a D1-safe server picker.
5. Persist visible reconciliation state for post-commit inventory follow-up failures.

### Phase 2 — integrate the active return/inventory work

1. Use the single owned item/quantity return model; do not fork it.
2. Make warehouse receipt/disposition the only restock authority for returns and COD return-to-sender.
3. Introduce quantity-based fulfillment facts compatible with the same line ledger.
4. Derive aggregate fulfillment/return summaries and remove standalone contradictory controls.

### Phase 3 — operational workspace and governance

1. Add the actor-attributed activity stream and link support approvals to their executed commands.
2. Add least-privilege payment/COD/support/notification/invoice permissions.
3. Add server-backed normal export, durable bulk-operation results, and saved operational views.
4. Make every secondary panel truthfully distinguish loading/error/empty/recovery.

### Phase 4 — compact UX, accessibility, and performance

1. Replace icon-only unlabeled actions; meet keyboard, focus, contrast, zoom, and screen-reader requirements.
2. Consolidate duplicate status controls and create a dense sticky summary plus chronology.
3. Keep minimum operational text legible; reserve 10px text for nonessential decoration only.
4. Run browser/mobile/slow-network/conflict/provider-failure scenarios, then deploy and smoke the complete workflows.

## Definition of done

Order operations are not complete until:

- every state-changing command is idempotent, version-aware, actor-attributed, permission-checked, and recoverable;
- no generic API can create a refund, return, fulfillment, shipment, invoice, payment, or inventory fact without its owning evidence;
- paid/fulfilled/invoiced history cannot be silently rewritten or deleted;
- manual and storefront order calculations use the same saved currency/tax/discount rules;
- item quantities reconcile across order, inventory, fulfillment, return, disposition, and refund;
- the admin distinguishes empty, unavailable, locked, stale, unknown-provider, partially successful, and fully successful states;
- focused concurrent/failure-injection tests prove the invariants, and production deployment is followed by authenticated API/browser smokes.
