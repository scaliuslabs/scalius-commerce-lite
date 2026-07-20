# Invoice authority

Last reviewed: 2026-07-12

Issued invoices are immutable commerce evidence. A page view must never allocate
an invoice number or capture merchant authority.

## Read and issue contract

- `GET /api/v1/admin/orders/{id}/invoice` is read-only. Before issuance it
  returns a live, unnumbered `draft`; after issuance it returns only the saved
  immutable snapshot.
- `POST /api/v1/admin/orders/{id}/invoice` is the only issuance command. It
  requires `orders.issue_invoice`, a client `operationKey`, and the order's
  `expectedOrderVersion`.
- The client retains the operation key while intent is unchanged. Exact replay
  returns the original immutable invoice. Reusing the key with another order or
  version is a conflict.
- Drafts cannot be printed or downloaded as invoices. The invoice page shows a
  compact issue state and keeps failures on the same recoverable URL.

## Atomic numbering

`invoice_sequences.default`, the immutable `order_invoices` row, the
`invoice_issue_commands` evidence, and the order-version CAS advance in one D1
batch. Invoice insertion is gated on both the pre-read sequence value and the
expected order version. A lost race creates no invoice, command, order update,
or sequence advance; the command retries from the new sequence authority.

The migration intentionally clears legacy `orders.invoice_number` values. They
were created by a read side effect and have no reproducible historical
snapshot. The deprecated column is not an invoice authority.

## Immutable snapshot

An issued invoice stores and hashes the complete `invoice-v1` render input:

- numeric and formatted invoice identity, exact prefix, issuance time, issuer,
  render version, and SHA-256 content hash;
- company/legal identity, address, contact details, saved tax identifier,
  invoice footer, and logo URL;
- customer and delivery facts, order/payment/fulfillment state, item and variant
  labels, quantities, order currency, saved minor-unit line allocations,
  discounts, tax labels/amounts, and totals.

The invoice projection reads the product and variant labels persisted on each
order item. It never joins the live catalog, so later product renames or option
changes cannot rewrite either a draft's order-time facts or an issued invoice.
It also avoids the broader order-detail shipment/refund/support projection.

The database rejects update/delete of invoice and issuance-command rows. Order
item replacement and permanent deletion are blocked after issuance. The
snapshot does not invent tax, provider, payment, or merchant facts: missing tax
facts remain absent, and issuance fails until a company or legal name exists.

## Verification

Focused tests cover read purity, atomic batch composition, allocation-race
retry, exact replay, changed-payload conflict, merchant-identity readiness,
immutable prefix/business rendering, migration triggers, route method/RBAC
separation, stable client operation keys, and recoverable invoice-page errors.
