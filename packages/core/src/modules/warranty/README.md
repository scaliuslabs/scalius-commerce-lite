# Warranty

Warranty and guarantee policies with immutable revisions, per-fulfilment-line warranty records, and claims backed by conversation threads. Audience: contributors and coding agents.

## Entries

`index.ts` is the server entry. `browser.ts` is the closed entry (the `WARRANTY_*` constants and `LineWarrantyExtra`).

Main files:

- `policies.ts`: create, edit as a new revision, archive, restore.
- `claims.ts`: open a claim, update its status, stage claim photos, staff list and detail.
- `extras.ts`: the per-line `warranty` extra and the account Warranties list (at most 100). `buyer-thread.ts`: a buyer's view of one claim and its thread.
- `shared.ts`: ids, claim id derivation, error codes.

## Layer and imports

- Layer L10. Imports `conversations` (claim threads) and `media-references` (product image keys in the extras read).
- Nothing imports `warranty`. An edge back from a lower domain would close a cycle, which the domain graph check rejects.

## Tables

| Table | Role and constraints |
|-------|----------------------|
| `warranty_policies` | The editable policy. `provider` is `brand` or `store`. Duration is 1 to 120 `days`, `months` or `years`. Replacement is 0 to 90 days or NULL. Terms are at most 4,000 characters. `current_revision_id` is the revision checkout freezes. `archived_at` hides it. `version` is the CAS token. |
| `warranty_policy_revisions` | Immutable buyer-facing copy of a policy. Unique `(policy_id, revision)`. Triggers refuse update and delete. |
| `order_item_warranties` | One record per fulfilment line. Id `wty_<fulfilment line id>`. Holds `starts_at`, `expires_at`, `replacement_until` and `voided_at`. |
| `warranty_claims` | A claim record. `status` is `open`, `in_progress`, `resolved` or `rejected`. `resolved` needs a `resolution` (`repair`, `replacement`, `refund`, `other`). Unique `conversation_id`. At most one claim in `open` or `in_progress` per warranty. |

Related columns: `products.warranty_policy_id` and `order_items.warranty_revision_id`.

## Rules

- A policy edit that changes a buyer-facing field inserts the next revision and points the policy at it in one batch, guarded by the `version` the editor loaded.
- Checkout freezes the policy's current revision onto the order line (`order_items.warranty_revision_id`). A trigger blocks any later change, so an edit never changes what a buyer bought.
- A trigger on `order_fulfillment_lines` creates one warranty record per fulfilment line of a line with a frozen revision. It starts at the fulfilment's creation time and expires by the revision's duration. A trigger voids the record when its fulfilment is voided.
- A product may point only at a live (not archived) policy. Archiving hides the policy from buyers and from new products. Revisions are never deleted.
- Buyers claim only an active warranty: not voided, not expired, checked again inside the batch. A buyer is the account that owns the order or a guest holding the receipt proof. Staff may open a goodwill claim on an expired warranty, never on a voided one.
- Opening a claim is one batch. It writes the thread (if not reserved yet), the claim row, the opening event line, the description as the first public message with its staged photos (at most 3), and its notification outbox row.
- The claim id derives from the warranty and a client key from the form (`claimIdFor`), so a double submit lands on the same claim and thread.
- Claims are records. They never change money, stock, fulfilment or order status. A replacement goes through a manual order or return. A refund goes through the refund dialog. Staff start both from the order.
- Staff move a claim with the `version` they loaded. A status change writes a public event line in the claim thread. Reopening needs the warranty's open-claim slot to be free.

## DVC

`order_item_warranties` and `warranty_claims` are private in the registry. `warranty_policy_revisions` is frozen at checkout and no public route reads it. `warranty_policies` is registered: a policy edit advances `p:<id>` of every product that points at it.

## Routes

Permissions are in `packages/core/src/auth/rbac/route-permissions/warranty.ts`. Route files are under `apps/api/src/routes/`: `admin/warranty-policies.ts`, `admin/warranty-claims.ts`, `admin/orders/warranty-claims.ts`, `customer-auth/warranties.ts` and `storefront-orders/warranties.ts`.

| Method and path | Permission |
|-----------------|------------|
| `GET /api/v1/admin/warranty-policies`, `GET /{id}` | `products.view` |
| `POST /api/v1/admin/warranty-policies`, `PUT /{id}`, `DELETE /{id}` (archive), `POST /{id}/restore` | `products.edit` |
| `GET /api/v1/admin/warranty-claims`, `GET /{id}` | `orders.view` |
| `PATCH /api/v1/admin/warranty-claims/{id}` | `orders.edit` and `conversations.reply` |
| `POST /api/v1/admin/orders/{id}/warranty-claims` (staff opens a claim) | `orders.edit` and `conversations.reply` |
| `GET /api/v1/customer-auth/warranties`, `POST /warranties/{id}/claim-attachments`, `POST /warranties/{id}/claims` | customer session |
| `POST /api/v1/orders/receipt/{id}/warranties/{warrantyId}/claim-attachments`, `/claims` | receipt proof |
| `GET /api/v1/orders/receipt/{id}/warranty-claims/{claimId}`, plus `/messages`, `/read`, `/attachments` | receipt proof |
