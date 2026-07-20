# Order Operations Audit

Last reviewed: 2026-07-20

Status: code-backed audit and implementation contract. This file does not claim that a workflow is production-proven merely because a component or endpoint exists.

## Scope and evidence labels

This audit covers the order list, manual creation, full edit, detail workspace, invoices, archive/restore/evidence retention, bulk actions, order/COD/payment/fulfillment states, payment recovery, refunds, returns, shipments and reconciliation, notifications, support requests, RBAC, responsive/accessibility behavior, failure states, API contracts, domain persistence, and focused tests.

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

The current order system has several strong recovery mechanisms, but it is not ready to be called operationally complete. Refund single-flight/reconciliation, shipment claims, notification outbox behavior, SKU validation, state-machine validation, payment-recovery proof handling, item-level returns, invoice issuance, safe full-edit locking, authoritative manual-order quoting/commit, bounded catalog picking, and evidence-preserving archival now have explicit authorities. Remaining high-risk work is concentrated in a durable draft/amendment model, explicit price-override evidence, concurrent customer aggregates, and complete permission/activity proof.

The release path should immediately narrow generic mutation authority. Financial outcomes, returns, and post-shipment corrections must be commands with their own evidence and reconciliation, not values in one mutable status dropdown. Full order editing must become a versioned amendment workflow with explicit locks after payment, fulfillment, invoice issuance, or return activity.

## Release blockers

### P0-1 — Generic order status can bypass workflow-owned facts

**Resolved for generic admin controls:** list, detail, and full-edit status controls now use the same narrow admin policy. Financial and return outcomes (`returned`, `refunded`, `partially_refunded`) are excluded, and shipped orders cannot be generically reversed or cancelled. Owning refund, return, COD, shipment, and reconciliation commands retain their internal transition authority. Route and component boundary tests protect the separation.

**Longer-term decision:** narrow `orders.status` to the commercial lifecycle and derive payment, fulfillment, return, and recovery summaries from their owning records. One dropdown must not pretend these dimensions are interchangeable.

### P0-2 — Full edit can overwrite a newer edit and rewrite settled commerce facts

**Resolved for the current full editor:** form data now carries `orders.version`, every full-edit request requires `expectedVersion`, and a stale form receives a typed `409` before location, inventory, customer, or order writes begin. The final order mutation and compensating inventory claim keys use that browser-loaded version.

Full edit has one server-derived readiness projection used by list, detail, form-data, and the write service. It is limited to unpaid, unfulfilled `pending | processing | confirmed` orders with no tax snapshot, payment, shipment, refund, return, or invoice evidence and no active shipment claim. Protected orders show a compact reason and point back to their dedicated workflow. The full form no longer changes order status.

This intentionally locks storefront checkout orders and newly confirmed manual orders because they own immutable tax and line snapshots that the current generic editor cannot recalculate without destroying historical evidence. It remains available only for legacy unsettled manual orders without such evidence. The policy is stricter than Shopify's recalculating editor and simpler than Medusa's requested/confirmed edit object or Vendure's modification preview; Scalius should relax it only after it has a durable amendment record, authoritative tax re-quote, payment delta, stable line identity, and explicit confirmation/reconciliation.

Primary benchmark evidence reviewed on 2026-07-17:

- [Shopify order-edit considerations](https://help.shopify.com/en/manual/fulfillment/managing-orders/editing-orders/considerations) separates unfulfilled-line edits from fulfilled evidence and requires the merchant to resolve any resulting payment/refund delta.
- [Medusa order edits](https://docs.medusajs.com/user-guide/orders/edit) stage changes as a request that is confirmed or rejected instead of mutating the settled order immediately.
- [Vendure order modification](https://docs.vendure.io/current/core/user-guide/orders/orders#modifying-an-order) previews the price difference and routes it into additional-payment or refund handling.

**Decision:**

- Keep `expectedVersion` required in form data and every full-edit request; never replace it with a version reread at submit time.
- Lock line, quantity, price, discount, tax, currency, and address mutations after payment capture, fulfillment, invoice finalization, return activity, or refund activity. Use explicit amendments, adjustments, or replacement orders where policy permits.
- Never zero tax facts as a side effect of editing. Manual orders must use the same authoritative tax engine and immutable money snapshots as checkout orders.
- Preserve stable order-line identity. Fulfillment, return, refund, tax, and shipment references must survive amendments; replacing every row is not a viable settled-order model.
- Current focused tests cover the version contract and pure readiness matrix. Add a D1 integration test for two stale editors when the full-edit fixture is available.

**Live release proof — 2026-07-17:** API version
`172513a3-992c-41c8-958f-7729813b238f` and admin version
`788b3fcd-30ae-43c3-8bfa-3107082b88ea` were deployed and exercised through
the authenticated dashboard. A new pending, unpaid manual order (`VHS0T4`) was
created through the form and remained editable. Two browser editors then loaded
the same version: the first saved the note `Manual order edit CAS verified
2026-07-17`; the second attempted `STALE WRITE MUST NOT LAND`; a fresh server
load retained only the first value. A checkout order with a tax snapshot showed
the protected-order state on desktop and at 390 x 844 with no horizontal
overflow. The follow-up list-link correction was deployed as admin version
`f9f07953-60a6-4c57-9068-aa68d42c8801`; protected customer names now open the
read-only order workspace while editable manual orders still open the editor.

### P0-3 — Manual order creation idempotency is resolved

**Implemented:** the create contract requires a client UUID `requestKey`. The
browser persists only a submitted opaque key in tab-local storage for 24-hour
lost-response recovery; untouched drafts do not write anything, successful
creation and explicit discard clear the key, and no customer/order facts enter
browser storage.

Core hashes the request key with the authenticated actor and hashes a canonical
request projection. `admin_order_create_attempts` owns one stable order ID,
lease, status, and replay response. A matching committed retry returns the
original response before mutable catalog, delivery, customer, or inventory
validation. A changed payload conflicts; active work returns retry guidance;
failed/stale work reclaims the same order and reservation identity. The attempt
guard, order/customer/items, and committed replay response share one D1 batch.
If a lease was reclaimed, the expired worker fails before releasing the new
owner's shared reservation.

Focused tests cover actor scoping, canonical equivalence, committed replay,
active contention, failed reclaim, changed-payload rejection, browser recovery
expiry/clear behavior, SKU/inventory compensation, and the atomic wiring
boundary.

**Live release proof — 2026-07-17:** migration `0031_rich_calypso.sql` and API
version `76d9a874-5b5a-4e7e-be6f-909c65087686` were deployed. Admin version
`a406c31e-2f09-4522-9fbf-15c2e0831123` created order `EYCHVY` through the
authenticated form. A read-only remote D1 query proved its attempt was
`committed`, had one attempt, retained a replay response, and released the
claim. The same live run proved the lazy-selected `Color: Black` SKU appears
immediately in the unsaved line instead of the former em dash.

The current post-commit deduction failure is fail-safe for overselling because stock remains reserved, but the endpoint still returns success after logging the error. Persist and show a reconciliation state instead of leaving the merchant unaware.

### P0-4 — Permanent deletion destroys regulated and operational evidence

**Resolved in the archive-authority slice:** ordinary hard-delete routes, services,
bulk contracts, and UI actions were removed. Merchant archive is now a reversible,
versioned visibility command backed by dedicated `orders.archivedAt`; it never
changes status, payment, fulfillment, inventory, items, customer history,
invoices, returns, refunds, support records, or buyer receipt/account access.
Only `cancelled | completed | returned | refunded` orders can be archived, and
active shipment, refund, return-receipt, or hosted-payment setup work blocks the
command. The active and archived list views use `/admin/orders` URL state
`?archived=true`, while legacy `deletedAt` remains isolated to stale incomplete
checkout cleanup.

The archive request requires each order's current `version`, rejects duplicates,
and caps a batch at 90 before its guarded D1 batch. Focused policy, validation,
RBAC, OpenAPI, admin-interaction, generated-client, and source-boundary tests
prove that normal order APIs expose no DELETE or permanent endpoint and that
archive cannot call inventory transitions or delete evidence.

Production proof on 2026-07-17 applied migration `0032_tricky_diamondback`,
deployed API version `9efe08ed-f624-41b7-822e-7eb754a950f7` and admin version
`cef08865-a42f-4a8e-9592-4b7c75e2e0bf`, then cancelled, archived, and restored
demo order `FWW6XI`. D1 inspection proved archive/restore advanced only the
order version and `archivedAt`: status, `inventoryAction`, on-hand, reserved,
and SKU stock version remained unchanged. The archived URL view, restore UI,
accessible row action, API health/readiness, admin auth gate, storefront home,
search, discovery XML/feed, UCP catalog, and a Product JSON-LD route all passed.
The full HTTP release smoke reports 294 OpenAPI paths; its deployment-history
subprocess was skipped only after the identical Wrangler deployment-list
command and authenticated Worker versions were proved separately.

PII redaction/anonymization still requires an explicit retention policy and an
auditable command. If a demo-only purge is ever required, isolate it behind
environment gating, super-admin step-up, a maintenance command, and a typed
dry-run report; ordinary `orders.delete` must never mean evidence destruction.

### P0-5 — Invoice allocation and historical invoices are not immutable

**Resolved in the invoice-authority slice:** invoice GET is read-only and
returns an unnumbered draft until an authorized explicit POST issues the
invoice. Issuance uses a stable client operation key, order-version CAS, a
dedicated permission, and one D1 batch for the monotonic sequence, immutable
snapshot, command evidence, and version advance. Historical merchant identity,
prefix, footer/logo reference, order lines, money, and tax facts now render from
the hashed saved snapshot. Legacy lazy numbers are cleared because they have no
reproducible evidence. See [Invoice authority](./INVOICE-AUTHORITY.md).

**Previous implementation:** an invoice number was lazily assigned on the first invoice GET. A settings counter used CAS and the numeric value was cached on the order.

**Previous gap:** counter increment and order assignment were separate writes. Concurrent requests for the same order could consume multiple numbers and overwrite the order's first assignment; a failure after counter increment created a gap. First-row insertion had a unique-race path that was not handled by the retry. The order update was not guarded by `invoiceNumber IS NULL`.

The old invoice GET mutated state while requiring only `orders.view`. Browser prefetching or a read-only user could therefore issue an invoice number. Only the numeric suffix was stored; formatting used the current business prefix, so changing the prefix changed how an old invoice was displayed. Business identity, address, logo, and footer were also read live, not snapshotted at finalization.

**Implemented decision:** invoice finalization is an explicit idempotent command with a dedicated permission. It atomically claims one number and persists the complete immutable invoice identity/snapshot. GET is read-only and preview invoices are unnumbered. Focused allocation-race, replay, prefix/business snapshot, authorization, and repeat-read tests protect the boundary.

### P0-6 — Returns and COD return-to-sender restore stock before receipt

**Resolved in the item-level return slice:** requests and approvals do not change inventory. A warehouse receipt explicitly partitions received quantity into restockable and damaged units; only the restock quantity writes a ledger-v2 movement in the same durable command. Receipt commands are idempotent and recoverable, cumulative item entitlement is database-guarded, and return lines/receipts are immutable evidence. COD return-to-sender creates an approved non-restocking return instead of making unreceived stock sellable. The order becomes returned only after every fulfilled unit is physically received.

The admin order workspace supports create, approve/reject, receive/disposition, cancel, and reconcile operations with stable command keys. Customer cancellation/return/refund visibility and server eligibility share the merchant policy documented in [Customer request policy](./CUSTOMER-REQUEST-POLICY.md).

## Workflow audit

### 1. Order list

**Implemented**

- Server pagination, URL-backed search/filter/sort, active/archive views, date range, order/payment/payment-method/fulfillment/recovery filters, mobile cards, and 60-second visibility-aware auto-refresh.
- Row status controls use the shared transition map; refund/shipment recovery locks are surfaced.
- Payment-recovery export is server-backed and capped at 5,000 rows with truthful cap headers.
- Bulk shipment returns per-order results; failed rows remain selected.

**Proven**

- Route/filter wiring, auto-refresh boundaries, recovery export headers, bulk busy states, and desktop/mobile fulfillment badges have focused admin/API boundary tests.
- RBAC middleware fails closed for unmapped admin routes and has focused route-permission tests.

**Gaps**

- The ordinary export is intentionally page-bounded and now says **Export current
  page** in the toolbar and completion message. Payment-recovery export remains
  a separate server-backed bounded export with row-count/cap metadata. Do not
  regress the page export to a generic “Export CSV” label or imply that it
  contains every filtered row.
- Some desktop/mobile row actions still need a complete accessible-name audit. Tooltips are not a substitute for an accessible name.
- Recovery and payment labels use text as small as 10px in several places. Operational states must remain legible at browser zoom and under common low-vision settings.
- List refreshes can move rows while the user is selecting or editing filters. Preserve selection only for still-visible IDs, announce refresh changes, and avoid auto-refresh while a destructive dialog is open.
- No saved views, column selection, or queue presets. These are P2 productivity features after correctness work.

**Live list/directory checkpoint — 2026-07-19:** The deployed dark-mode order
list and buyer directory were exercised at 1440 px and at a real 390 x 844
device viewport with no horizontal overflow. A storefront checkout order opened
the read-only operational workspace instead of redirecting to the list. Guest
checkout profiles appeared in the same Customers directory with explicit Guest
identity, order count, paid-spend truth, last-order date, and order-history
navigation. Admin bundle `index-BBo_gS3k.js` proves the bounded order export now
renders “Export current page” on desktop and mobile; the previous ambiguous
“Export CSV” control is absent.

**Bulk-shipment input checkpoint — 2026-07-20:** API version
`82b7fb11-2880-497a-8647-1ae3a18c37c5` accepts one unique batch of 1–90
bounded order IDs and a strict provider-options object. COD amount, item count,
and item description are no longer request inputs; delivery derives them from
the current order balance and saved lines immediately before provider work.
The core service repeats the same validation so non-HTTP callers cannot bypass
it. Authenticated production requests for a duplicate order, 91-order job, and
browser-authored `codAmount` each returned 400. Order `UWXZV7` remained
`confirmed` at version 1 before and after all three checks, proving the rejected
requests did not claim or mutate it. Eighty-nine focused validation,
fulfillment, delivery, and OpenAPI tests plus sequential Core, API, API-client,
and Admin typechecks passed before deployment.

### 2. Manual order creation

**Implemented**

- Customer/contact/address fields, Bangladesh city/zone/area selection, line creation, lazy variant loading, quantity editing, server-owned catalog pricing, shipping, additional discount, keyboard submit, unsaved-change guard, and a sticky action bar.
- Manual creation is deliberately one command: **create confirmed COD order**. The compact summary states `Confirmed`, `COD · unpaid`, and `Stock reserved`; the form does not silently pretend to save a neutral draft.
- A debounced authenticated quote endpoint resolves the saved currency precision, exact active SKU and tax class, destination hierarchy, shipping, order-wide discount allocation, configured tax policy, and final total. Submit is locked until the quote matches the current form projection; the server recalculates the same quote at commit.
- Create and quote requests carry only product, exact SKU, and quantity. The
  server resolves the buyer-effective catalog unit price, including the saved
  variant-over-product discount precedence, and returns authoritative line
  prices for the desktop table and compact mobile item cards. A hidden or stale
  browser `price` value cannot create a staff price override.
- Server validation requires at least one sellable line, rejects missing/deleted/mismatched SKUs, prevents an excessive discount, and commits order/customer/items, immutable order and line tax snapshots, minor-unit allocations, idempotency evidence, and inventory reservations in one D1 batch.
- The same batch owns the initial COD tracking row. Manual admin creation and
  storefront ingestion cannot commit a COD order that the later **Mark
  Collected**, delivery-failure, or return-to-sender commands cannot operate on.
  Collection remains fail closed if legacy/corrupt data lacks this evidence;
  the UI does not silently invent payment tracking during collection.
- Tracked inventory remains reserved while fulfillment is pending. Manual creation no longer invokes shipped semantics or deducts on-hand stock before a fulfillment command owns that transition.
- Actor-scoped request idempotency replays the original committed result after a lost response and preserves one stock/order identity across retries.
- Lazy-loaded SKU projections are retained beside unsaved lines, so the exact merchant option label remains visible immediately after adding it.
- Product discovery is a debounced, paginated server query over active catalog
  products and their saved SKU/barcode identities. The route returns 10 rows by
  default, caps a page at 20, and exposes explicit loading, retry, empty, and
  load-more states instead of turning a failed preload into an empty catalog.

**Proven**

- SKU validation, required non-empty lines, product/variant tax-class precedence, configured tax-quote use, immutable snapshot wiring, confirmed/COD/unpaid state, tracked stock reservation without premature deduction, untracked item behavior, reservation failure, compensation, quantity boundaries, idempotent replay/reclaim/conflict, browser request-key recovery, bounded product/SKU/barcode search, quote RBAC/OpenAPI contracts, and inventory-claim paths have focused tests.

**Gaps**

- A merchant-authored draft must not reuse `orders.status = incomplete`: that state belongs to buyer hosted-payment recovery and scheduled cleanup. The correct future model is a separate merchant-owned, versioned draft-order record with no customer, inventory, payment, or order side effects until an explicit completion command runs the authoritative quote and order commit.
- The current command supports COD/unpaid only. Additional manual payment terms or saved gateway intents need explicit, permissioned commands and evidence; they must not be disguised as dropdown defaults on creation.
- Do not add an implicit price override to this confirmed-order command. A
  future custom-price workflow belongs to the separate merchant draft-order
  authority and must show catalog versus custom price, require a dedicated
  permission and reason, and persist actor/reason/before/after evidence before
  an explicit completion command reserves stock or creates an order.
- Admin-created item rows do not persist the same complete product/variant/money snapshot expected of an immutable order. Renames and product deletion can weaken historical display.
- Customer aggregate statistics are precomputed outside the order batch. Concurrent manual creates can overwrite each other's counters. Archive no longer changes these facts; prefer ledger/query-derived stats or atomic deltas with reconciliation.

**Live authoritative-create proof — 2026-07-20:** API version
`c584ba93-5ed2-4513-9d79-09ee52793403` and admin version
`d76eacaa-fc73-405b-92a1-369ed5cf8085` were deployed. The authenticated
dashboard created order `UWXZV7` from a one-SKU quote with shipping and an
additional discount, then navigated directly to its exact detail workspace. A
fresh page load showed confirmed/COD/unpaid/pending state and no console warning
or error. A read-only remote D1 query proved BDT minor-unit amounts of 551080
subtotal, 12000 shipping, 10000 discount, 0 configured tax, and 553080 total;
one order tax snapshot and one line tax snapshot use `tax-v1`; the SKU retained
24 on hand with exactly 1 reserved. The run therefore proves creation did not
masquerade as shipment or deduct on-hand inventory.

**Server-owned line-price proof — 2026-07-20:** API version
`dfeab18e-fa9f-4209-bbf6-30cec56b6856` and admin version
`e869ef18-3d4b-47e6-825a-84f614ee0403` were deployed after removing `price`
from the manual create/quote request contract. The authenticated dashboard
selected `Dock 7-in-1 USB-C Hub`, requested quantity 2, and displayed the
server-quoted `৳5,510.80` unit price, `৳11,021.60` subtotal, `৳120.00`
shipping, and `৳11,141.60` total before submit. It created confirmed COD order
`L81PGQ` and navigated to its exact detail route without a console warning or
error. A read-only remote D1 query proved `unit_price_minor = 551080`,
`line_subtotal_minor = 1102160`, `total_amount_minor = 1114160`, pending
fulfillment, 24 on hand, and 3 total reservations across the SKU's open
orders. Focused validation proves a browser-supplied legacy `price` key is
stripped and cannot alter the quote or persisted line.

**Atomic COD-tracking repair and live replay — 2026-07-20:** The live run above
found that `L81PGQ` had committed as a valid-looking COD order without its
required `cod_tracking` row. **Mark Collected** correctly refused to synthesize
that evidence and reported `COD tracking record is missing for this order`.
The root cause was two order-creation boundaries: manual creation omitted the
row, while storefront ingestion added it only as a post-commit best-effort
side effect. API version `f99f5d54-cc21-4304-afde-21fb451cd5c6` now puts the
canonical pending tracking insert in both authoritative D1 batches; admin
version `4752cb47-e0e2-4ecd-aaf7-53718314f2fb` also adds accessible,
operator-specific descriptions to the COD collection/failure dialogs. Sixty
focused core tests, four admin operational-boundary tests, sequential core and
admin typechecks, and changed-file lint passed before deployment.

The exact legacy demo order was repaired once with an explicit pending
tracking row, then the live UI recorded `৳11,141.60` collected by **Own courier
lifecycle smoke**. The order became Delivered/Paid with balance zero, one
successful COD transaction, collected tracking evidence, and one delivery
attempt. A completely fresh post-deploy admin order `VHQK8M` then proved the
real creation path without repair: the browser submitted one exact Dock SKU,
navigated to its detail route, and a read-only remote D1 query immediately
found the order, one reserved unit, and pending `cod_tracking` row
`fdb3ef59-b998-4fc9-b2b9-80390f9e7d21` in committed state. Opening **Mark
Collected** showed the outstanding `৳5,510.80` plus the new explanation and
was initially cancelled so the same order could become the end-to-end
fulfillment proof below.

**Manual-delivery evidence repair and live replay — 2026-07-20:** API version
`bb51fdb5-9bd6-457f-a31d-743ce24033d0` and admin version
`1a7539f8-d98f-413d-8eff-26ab7a4da4d0` make own-courier evidence follow the
buyer-visible lifecycle instead of leaving a delivered order attached to a
`processing` shipment. A manual fulfillment now starts its provider-less row
at **In Transit**. COD collection and explicit delivered/completed commands
idempotently mark shipped line items and only provider-less manual shipments
Delivered; provider-owned shipment states remain carrier-owned. Manual rows
also omit the irrelevant provider polling timestamp.

The authenticated dashboard then completed `VHQK8M`: **Own Courier** created
tracking `OWN-VHQK8M-1`, moved the order to Shipped/Complete, and displayed one
**In Transit** manual shipment. **Mark Collected** recorded `৳5,510.80` from
**Lifecycle proof courier**. A clean page load showed Delivered/Paid/Complete,
COD Collected, and the shipment Delivered. A read-only remote D1 join proved
the same order, item, shipment, payment, balance, and COD facts: item
`delivered`, manual/provider-less shipment `delivered`, `paid_amount = 5510.8`,
`balance_due = 0`, and collected amount `5510.8`. The live run also caught two
last-mile UI defects: shipment data stayed stale until reload and the COD
dialog described the old semantics. Admin version
`b1af5dc9-0dea-42a8-9a7d-7f09a031bdc8` now invalidates shipment history after
COD commands and truthfully explains delivery, payment, and reservation
commit; the deployed dialog was reopened on `1NC5RO` and cancelled without
mutating that audit order.

### 3. Full edit

**Implemented**

- The form reloads customer/address/items/shipping/discount and performs inventory compensation using the browser-loaded CAS version.
- Payment, tax, fulfillment, shipment, refund, return, invoice, terminal-state, and active-claim evidence block the full editor with one server-derived reason. Status changes use their dedicated action.
- Form data resolves only the exact product and SKU identities already saved on
  the order. Missing, retired, trashed, inactive, or cross-product identities
  force the existing read-only protection state instead of loading the whole
  catalog or rendering an editable unknown line. New line discovery reuses the
  same bounded picker as manual creation.

**Proven**

- SKU validation, several inventory compensation branches, required positive update versions, and the edit-readiness evidence matrix have focused tests. API/core/admin typechecks and lint cover the generated contract.

**Gaps**

- A full amendment workflow with preview, stable lines, tax re-quote, payment delta, confirmation, history, and reconciliation remains absent. The safe lock is a release boundary, not a claim that post-checkout editing is complete.
- The edit loader has a truthful retry/back error boundary and a dedicated protected-order state.
- Replacing all item rows destroys stable line identity and cascades item tax snapshots. Use line-level add/change/remove commands or versioned amendments.
- A committed write can be followed by an inventory-action update outside the main batch. If that final update fails, the order and inventory facts require reconciliation. Persist a visible recovery state and repair command.

**Live catalog-picker proof — 2026-07-19:** API version
`0ed3aa7e-0239-4d5e-a8c6-1d101364bfdb` and admin version
`5b521dbc-946f-4e03-85af-f8bbd528afdc` were deployed. The authenticated manual
order form loaded without a catalog preload, found `Weekender Duffel 35L`
outside the first page by its exact persisted barcode
`SCALIUS:C128:SNIthWKh7HMed3pt_rBZ-`, lazily loaded the `Color: Olive` SKU,
and staged the truthful `৳6,490` line. Closing the product and SKU portals left
zero dialogs/listboxes, no `aria-hidden` ancestor on the enabled Add Item
action, and no invisible layer intercepting the form. The shared popover/select
fix removes stalled exit animations while retaining open-state motion and a
closed-state visibility/pointer fallback.

### 4. Detail workspace

**Implemented**

- Customer/contact/address, total/payment/fulfillment summaries, items, status actions, support requests, payment history/recovery/refunds/COD, notification delivery, shipments/reconciliation, and notes.
- Primary detail has an explicit error view with retry/back. Optional panels own
  their loading/error/empty states so a payment or notification failure does not
  replace the whole workspace. Route-owned panels are direct imports: internal
  `lazy()`/`Suspense` boundaries previously allowed an optional chunk to resolve
  between the server render and hydration, changing the first client tree.
- Shipment history, delivery-provider setup, and COD tracking distinguish the
  initial load, a truthful empty result, an unavailable first read, and stale
  last-known data after a failed refresh. Shipment/provider/COD writes remain
  paused unless their owning read is current; every unavailable state has a
  local retry instead of failing or blanking the full order workspace.

**Proven**

- Navigation/prefetch behavior, payment and notification mutation invalidation,
  permission projection, notification display grouping, recovery summaries,
  direct panel boundaries, payment-query hydration gating, and the operational
  read-state transition model have focused tests. Source-boundary tests keep the
  shipment/provider queries from regressing to default empty arrays and keep COD
  actions behind a current successful read.

**Live hydration checkpoint — 2026-07-19:** admin version
`d8e7914f-1768-46ae-a404-211d3a596220` was exercised on the exact production
order route `/admin/orders/SEJ5E0`. A component-stack-only React recoverable
error diagnostic traced the remaining mismatch to `PaymentCard`: an optional
payment prefetch could change from fetching on the server to idle before the
client's first render, changing a refresh button's disabled/spinner markup.
Payment history and its fetching affordances now remain behind the existing
hydration boundary, while the order snapshot renders immediately. Three
consecutive hard navigations rendered order, notification, return, and refund
facts with zero console errors or warnings. Keep optional warm-query state out
of server/first-client markup unless it is part of the route snapshot.

**Live operational-read checkpoint — 2026-07-20:** admin version
`de4f90a3-a5ff-46c9-b84d-b4dc387eb5f4` was exercised on gateway order
`SEJ5E0` and COD order `1NC5RO`. Both loaded provider configuration and a
truthful **No shipments yet** state without console errors. The COD workspace
revealed **Mark Collected** only after its tracking query resolved. The COD
workspace retained zero horizontal overflow at 390 x 844. Failure and stale
branches are covered by the focused state/boundary tests; this live checkpoint
proves the deployed current/empty paths, not a simulated production outage.

**Gaps**

- There is no unified actor-attributed chronology. Evidence is fragmented across cards and some mutations have no actor/reason event at all. Add a single append-only order activity stream referencing the owning payment/shipment/refund/return/notification/support facts.
- The layout is readable but not optimized for high-throughput operations: large icon/info blocks and two independent status controls consume space, while recovery facts are scattered. Use a compact sticky summary rail and one chronological workspace after domain correctness is fixed.
- Fulfillment aggregate can be manually changed independently of item and shipment rows. The UI can show `complete` while every line is pending and no shipment exists. Derive it from fulfillment quantities, or represent an explicit audited override that does not masquerade as derived truth.
- The order has no visible revision, last actor, amendment history, or conflict banner.

### 5. Invoice

**Implemented**

- Read-only unnumbered draft preview; explicit permissioned issuance; authenticated print/PDF actions only after issuance; immutable merchant, buyer, line, money, tax, prefix, footer, and logo-reference snapshot; saved minor-unit display; integrity hash; render version; and A4 print styles.

**Proven**

- Focused tests cover read purity, atomic sequence/invoice/command/order CAS, concurrent allocation retry, exact idempotent replay, changed-payload conflict, merchant readiness, immutable snapshot rendering, migration guards, RBAC method separation, stable client operation keys, and recoverable page errors.

**Gaps**

- PDF generation failure only logs in development; production users receive no error or retry guidance.
- Client HTML-to-canvas PDF remains a convenience renderer. The immutable hashed payload is authoritative, but a deterministic server-generated PDF artifact is still a useful future compliance/export feature.

### 6. Archive, restore, and evidence retention

**Implemented**

- Archive/restore changes only `archivedAt`, advances the order version with a CAS, and leaves every commerce and buyer-visible fact unchanged.
- Archive is limited to terminal `cancelled | completed | returned | refunded` orders and blocks active shipment, refund, return-receipt, and hosted-payment setup work.
- Individual and bulk UI use the same versioned `/archive` command; archived rows expose restore only. Normal API/RBAC mappings have no order DELETE or permanent-delete route.

**Proven**

- Focused policy, validation, RBAC, OpenAPI, source-boundary, generated-client, and desktop/mobile interaction tests cover the archive/restore contract and absence of evidence deletion.

**Gaps**

- Add a persisted order activity event for archive/restore actor and optional reason; the order CAS currently preserves conflict safety but is not a complete activity timeline.
- Design PII redaction and retention separately from archive. It must preserve financial/fulfillment evidence and provide a typed impact preview.
- Add a D1-backed concurrency test that races archive/restore with an operational command; the guarded queries fail closed, but source and policy tests are not full persistence proof.

### 7. Bulk actions

**Implemented**

- Bulk ship returns success/failure per order and enqueues shipped notifications only for newly shipped results. UI keeps failures selected. Bulk archive is a bounded, duplicate-free, versioned atomic visibility command.

**Proven**

- UI busy/partial-failure behavior, shipment notification boundaries, and archive contract/history-preservation boundaries have focused tests.

**Gaps**

- Bulk ship is sequential and has no operation-level idempotency key or resumable job record. Retrying an unknown response relies on downstream claims but offers no merchant-visible batch reconciliation.
- Bulk commands need a durable operation with snapshot count, actor, provider/options, per-order state, retryability, and downloadable result. Keep provider calls bounded and never hold D1 connections across network work.
- “Select all” means the current page. Do not imply all filtered orders unless a server-side selection token is implemented.

### 8. Order status and COD

**Implemented**

- Shared state-machine validation, version CAS during status mutation, refund/payment/shipment locks, inventory reconciliation, status notification outbox integration, COD collect/fail/return actions, amount validation, recorded COD evidence, and atomic initial tracking on every COD order-creation boundary.

**Proven**

- State-machine rules, COD side-effect ordering, status inventory reconciliation, active-claim locks, and notification behavior have substantial core/API coverage.

**Gaps**

- Generic workflow bypass (P0-1) and COD premature restock (P0-6).
- `orders.status` mixes commercial, fulfillment, return, and financial dimensions even though separate payment and fulfillment records exist. Adopt command-specific transitions and derived summaries.
- COD failure records an attempt but the operator flow lacks a clear retry/reschedule/address-correction sequence.
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
- Provider-less own-courier rows begin in transit. A delivered/completed manual
  command synchronizes shipped line evidence and manual shipment evidence,
  while provider-owned rows remain under carrier status synchronization.

**Proven**

- Claim failure, foreign/duplicate/empty item IDs, failed shipment batch cleanup, final-shipment retry, reconciliation, provider status sync, manual delivery evidence repair, active refund locks, and notification conditions have focused tests.

**Gaps**

- Manual fulfillment selects whole line IDs, not quantities. A line of quantity five cannot ship two now and three later. Fulfillment must be quantity-ledger based.
- Partial fulfillment can mark selected lines shipped while inventory conversion remains a whole-order/final action. Define and prove per-quantity reservation/deduction truth with the active inventory work.
- Direct aggregate fulfillment editing can contradict line and shipment facts.
- Post-shipment cancellation/backward status needs explicit reconciliation, not a generic status change.
- Shipment history is not part of one actor-attributed order timeline, and manual fulfillment lacks a request key exposed by the client.

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
- Archive/restore permissions govern visibility only; future PII redaction or maintenance purge must use distinct step-up authority.
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

Current good examples are the list error/retry state, notification panel
error/retry, payment recovery banners, refund/shipment locks,
shipment/provider/COD operational-read states, and recovery export cap metadata.
Remaining failures include generic mutation toasts that do not identify a stale
revision or a committed-but-reconciliation-required outcome.

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
- admin manual-create idempotency and browser recovery: [admin-order-create-attempts.test.ts](../../packages/core/src/modules/orders/admin-order-create-attempts.test.ts), [create-order-request-key.test.ts](../../apps/admin-v2/src/components/admin/order-form/create-order-request-key.test.ts)
- admin SKU validation and inventory compensation: [orders.admin-sku-validation.test.ts](../../packages/core/src/modules/orders/orders.admin-sku-validation.test.ts)
- fulfillment claims, reconciliation, and COD: [orders.fulfillment.test.ts](../../packages/core/src/modules/orders/orders.fulfillment.test.ts)
- payment recovery: [order-payment-recovery.test.ts](../../packages/core/src/modules/orders/order-payment-recovery.test.ts), [order-payment-recovery-link.test.ts](../../packages/core/src/modules/orders/order-payment-recovery-link.test.ts), [orders-payment-recovery-link.test.ts](../../apps/api/src/routes/admin/orders-payment-recovery-link.test.ts)
- support requests: [order-support-requests.test.ts](../../packages/core/src/modules/orders/order-support-requests.test.ts)
- admin route/RBAC/OpenAPI boundaries: [admin-auth.test.ts](../../apps/api/src/middleware/admin-auth.test.ts), [orders-openapi-contract.test.ts](../../apps/api/src/routes/admin/orders-openapi-contract.test.ts)
- notification and shipment route behavior: [orders-notifications.test.ts](../../apps/api/src/routes/admin/orders-notifications.test.ts), [orders-manual-fulfillment-notifications.test.ts](../../apps/api/src/routes/admin/orders-manual-fulfillment-notifications.test.ts), [shipment-status-sync.test.ts](../../apps/api/src/routes/admin/shipment-status-sync.test.ts)
- admin list/detail/mutation presentation boundaries: [order list tests](../../apps/admin-v2/src/routes/admin/orders/-order-list-interactions.test.ts), [detail prefetch tests](../../apps/admin-v2/src/routes/admin/orders/-order-detail-prefetch.test.ts), [order mutation tests](../../apps/admin-v2/src/lib/api-mutations/orders.test.ts)

**Missing focused proof**

- a D1-backed concurrent full-edit fixture beyond the authenticated production
  two-editor smoke;
- a D1 failure-injection test that proves manual order, tax snapshots, customer update, and reservation remain one atomic commit;
- D1-backed archive/restore concurrency and history-preserving privacy/redaction behavior;
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

1. Add failing tests for generic status bypass, `orders.edit` status bypass, hard-delete removal, invoice same-order concurrency, stale edit, and manual-create replay — completed for the named boundaries.
2. Restrict generic status mutations and remove workflow-owned states/post-shipment reversal from generic UI/API.
3. Disable ordinary hard delete; retain visibility-only archive and design PII redaction/demo purge separately — completed.
4. Manual-create idempotency — completed with actor-scoped durable replay.
5. Make invoice reads non-mutating; implement atomic explicit finalization and immutable snapshots.

### Phase 1 — versioned, truthful order mutation

1. Add `expectedVersion` to detail/form/update and typed conflict UI.
2. Split draft amendment from settled-order adjustments; lock destructive line/money/tax edits after settlement evidence.
3. Route manual order calculations through the checkout money/tax snapshot engine — completed for quote and confirmed COD creation; reuse this authority when a separate draft-completion command exists.
4. Replace unbounded create/edit catalog loading with a D1-safe server picker — completed with one bounded discovery route plus exact edit-line projection.
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
