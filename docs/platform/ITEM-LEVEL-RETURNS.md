# Item-level returns

Last reviewed: 2026-07-19

The durable return authority is `order_returns` + `order_return_lines` +
`order_return_commands` + immutable `order_return_receipt_lines`. A return is
not a synonym for a refund and is not an instruction to restore stock.

## Lifecycle and invariants

- Request records selected fulfilled order-item quantities. Approval records an
  exact approved/rejected decision for every requested unit. Neither changes
  inventory.
- Receipt records an exact restock/damaged disposition for every received unit.
  Only `restock_quantity` creates a ledger-v2 restore for the original order
  inventory pool. The movement keeps the receiving admin id.
- Immutable receipt rows are the audit authority. Cumulative received/restock/
  damaged values on the return line are projections maintained by D1 trigger.
- D1 triggers enforce that cumulative non-cancelled requested/approved quantity
  across concurrent return cases cannot exceed the shipped/delivered order-item
  quantity.
- Partial return completion leaves the order in its fulfilled state. The order
  becomes `returned` only when received quantities across durable return cases
  exactly cover every shipped/delivered item.
- Refunds remain independent and retain their provider single-flight,
  idempotency, and reconciliation guards.
- Return, line, command, receipt, order-item, order, SKU, and inventory-movement
  evidence is deletion-restricted. Full order-item replacement and permanent
  order deletion are rejected once return history exists.

## Receipt recovery

Receipt inventory writes can span bounded ledger/CAS batches, so `receive` is
the only return command with a durable `processing` state. It stores a bounded
canonical validated input and owns the order-level return receipt claim. Each
SKU restore uses a generation-independent deterministic claim derived from the
return, command, and return line. Retrying converges exactly after any subset of
movements committed.

`POST /api/v1/admin/orders/{id}/returns/{returnId}/reconcile` resumes from that
server-owned payload; the operator does not need the lost browser body or key.
Public return reads expose only `receiptRecovery.required/startedAt`, never the
request hash, command key, or payload.

## API workflow

1. `POST /api/v1/admin/orders/{id}/returns`
2. `POST /api/v1/admin/orders/{id}/returns/{returnId}/approve`
3. One or more `POST .../{returnId}/receive`
4. Optional recovery with `POST .../{returnId}/reconcile`

Cancellation is allowed only before any receipt. COD courier return-to-sender
creates and approves the same item-level return but never receives/restocks it;
warehouse staff must record physical receipt explicitly. Approving a buyer
support return request must create or link exactly one return using the support
request id as its source identity.

The generic status editor intentionally cannot select `returned`, `refunded`,
or `partially_refunded`, and cannot move shipped work backward or cancel it.
Those states belong to their evidence-owning workflows.

## Production proof

Order `3EFMCF` exercised the full merchant workflow through the deployed admin:
request one shipped SKU, approve one, receive one, and classify that unit as
restockable. Approval left the SKU at 7 on hand / 0 committed / 7 available.
Receipt completed return `ret_sQED4QK7x32iNHVZMDAE`, moved the order to
`returned`, retained the independent unpaid COD state, and restored the exact
SKU to 8 / 0 / 8. The return command rows for create, approve, and receive are
all committed; the immutable receipt row references its inventory movement.

The run exposed invalid SQLite from wrapping a Drizzle select as
`EXISTS ((select ...))` in approval, receipt claim, and cancellation guards.
Those predicates now use Drizzle's native `exists()` expression. A real
`node:sqlite` integration suite executes all three guarded batches, including a
damaged-without-restock receipt, so future SQL-shape regressions fail before
deployment.
