# Warranty

Warranty and guarantee policies with immutable revisions, per-fulfilment-line warranty records, and claims backed by conversation threads. Audience: contributors and coding agents.

## Entries

`index.ts` is the server entry. `browser.ts` is the closed entry (the `WARRANTY_*` constants and `LineWarrantyExtra`).

Main files:

- `policies.ts`: create, edit as a new revision, archive, restore.
- `claims.ts`: open a claim, update its status, stage claim photos, staff list and detail.
- `extras.ts`: the per-line `warranty` extra and the account Warranties list (at most 100). `buyer-thread.ts`: a buyer's view of one claim and its thread.
- `shared.ts`: ids, claim id derivation, error codes.
- `coverage.ts`: an app's coverage (`warranties.issue`, `warranties.void`): one record per unit under the app's own plan, and the sealed `warranty` representation.

## Layer and imports

- Layer L10. Imports `conversations` (claim threads) and `media-references` (product image keys in the extras read).
- Nothing imports `warranty`. An edge back from a lower domain would close a cycle, which the domain graph check rejects.

## Tables

| Table | Role and constraints |
|-------|----------------------|
| `warranty_policies` | The editable policy. `provider` is `brand` or `store`. Duration is 1 to 120 `days`, `months` or `years`, or `lifetime = 1` (0215; the duration columns then hold 120 years, pinned by a CHECK). `app_id` and `app_key` mark an app's coverage plan, never listed, edited or given to a product. Replacement is 0 to 90 days or NULL. Terms are at most 4,000 characters. `current_revision_id` is the revision checkout freezes. `archived_at` hides it. `version` is the CAS token. |
| `warranty_policy_revisions` | Immutable buyer-facing copy of a policy. Unique `(policy_id, revision)`. Triggers refuse update and delete. |
| `order_item_warranties` | One record per fulfilment line. Id `wty_<fulfilment line id>`. Holds `starts_at`, `expires_at`, `replacement_until` and `voided_at`. |
| `warranty_claims` | A claim record. `status` is `open`, `in_progress`, `resolved` or `rejected`. `resolved` needs a `resolution` (`repair`, `replacement`, `refund`, `other`). Unique `conversation_id`. At most one claim in `open` or `in_progress` per warranty. |

Related columns:

| Column | Role |
|--------|------|
| `products.warranty_policy_id` | The product's policy, or NULL. `SET NULL` on delete. |
| `product_variants.warranty_mode` | `inherit` (default: the product's policy), `policy` (the SKU's own) or `none` (0189). |
| `product_variants.warranty_policy_id` | The SKU's own policy. A CHECK sets it exactly in `policy` mode. `RESTRICT` on delete. Partial index. |
| `order_items.warranty_revision_id` | The revision frozen at commit. A trigger makes it immutable. |

The SKU fields are written by the product editor's writes in `product-admin` (option matrix, single-SKU routes, duplicate) and validated by `products/sku-warranty.ts` and `product-admin/warranty.ts`. They are not part of the app API, webhooks or events.

## Rules

- A policy edit that changes a buyer-facing field inserts the next revision and points the policy at it in one batch, guarded by the `version` the editor loaded.
- A SKU's effective warranty is its own live policy (`policy`), nothing (`none`), or its product's live policy (`inherit`).
- Checkout freezes the effective policy's current revision onto the order line (`order_items.warranty_revision_id`), inside the commit batch, binding only the SKU id. An archived own policy freezes none: it never falls back to the product's. Staff orders, lines an order amendment adds, and an expanded bundle's component lines (each its own SKU) take the same path; a line an amendment keeps keeps its revision. A trigger blocks any later change, so an edit never changes what a buyer bought.
- A trigger on `order_fulfillment_lines` creates one warranty record per fulfilment line of a line with a frozen revision. It starts at the fulfilment's creation time and expires by the revision's duration; a lifetime revision's record (its own trigger) never expires. A trigger voids the record when its fulfilment is voided.
- An app covers units of a line with `issueAppWarranties` and ends them with `voidAppWarranties`, both by target (the line holds `quantity` of the app's records, voided ones counted; at least `quantity` are void), so a repeat changes nothing. Its records are claimed and shown like any other; `warranty.issued` and `warranty.voided` come from the table's triggers.
- A product may point only at a live (not archived) policy. A SKU may be given only a live policy it does not already name; a SKU keeps a policy archived after it was chosen, so re-saving the matrix never fails on it. Archiving hides the policy from buyers and from new products. Revisions are never deleted.
- A copied product keeps live policies. A SKU whose own policy is archived is copied as `none`.
- Only an option SKU of a product that is not a gift card has a warranty of its own, as in the editor. A product's one SKU only inherits (other modes are refused). A gift card has no warranty at all: the save that creates one, makes a product one or edits one clears the product's policy. A gift card's SKUs only inherit: a save that makes a product a gift card, or a matrix save of one, puts every SKU on `inherit` whatever the rows send; creating a gift card or a single-SKU write that names another mode is refused.
- `planMatrixSkuWarranties` is the matrix save's one authority. A new option row (an added or removed axis) takes its source rows' warranty; one that names an archived policy (copied from its source) is saved as `none`, which is what its source sells with. An editor row that restores a combination starts at `inherit` unless it names its warranty; the app API's `variants.restore` and `variants.create` (reviving a retired combination) bring the SKU back with its own warranty (`restoredRowsKeepWarranty`), an archived own policy as `none`. An unknown policy, or an archived one newly given to a saved SKU, is refused.
- The policy list's product count counts each live product once, whether it names the policy or a live SKU does.
- The product page carries `product.warranties` (each effective live policy once, with its id) and each variant's `warrantyId` (null: no warranty). The buy box draws one row per warranty and shows the opening SKU's; `product-controller.ts` shows the chosen SKU's row by `data-sx-warranty-by-variant` (with no exact SKU, the one every matching SKU shares, else none), and a `?variant=` link holds the rows back until it runs.
- Buyers claim only an active warranty: not voided, not expired, checked again inside the batch. A buyer is the account that owns the order or a guest holding the receipt proof. Staff may open a goodwill claim on an expired warranty, never on a voided one.
- Opening a claim is one batch. It writes the thread (if not reserved yet), the claim row, the opening event line, the description as the first public message with its staged photos (at most 3), and its notification outbox row.
- The claim id derives from the warranty and a client key from the form (`claimIdFor`), so a double submit lands on the same claim and thread.
- Claims are records. They never change money, stock, fulfilment or order status. A replacement goes through a manual order or return. A refund goes through the refund dialog. Staff start both from the order.
- Staff move a claim with the `version` they loaded. A status change writes a public event line in the claim thread. Reopening needs the warranty's open-claim slot to be free.

## DVC

`order_item_warranties` and `warranty_claims` are private in the registry. `warranty_policy_revisions` is frozen at checkout and no public route reads it. `warranty_policies` is registered: a policy edit advances `p:<id>` of every product that points at it, and of every product with a SKU that names it (`sku_upd`, 0189). `product_variants.warranty_mode` and `warranty_policy_id` are visible columns: a change advances the SKU's product.

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
| `GET /api/v1/admin/resources/warranties`, `GET /{id}` (`warranties.list`, `.get`) | `orders.view` |
| `POST /api/v1/admin/resources/warranties/issue`, `/void` (an app only) | `orders.manage_warranties` |
| `GET /api/v1/orders/receipt/{id}/warranty-claims/{claimId}`, plus `/messages`, `/read`, `/attachments` | receipt proof |
