# Warranty Module

Warranty and guarantee policies, per-line warranty records and claims (design: `audit/rewrite-2026-09-23/WAVE-B-DESIGN.md` §5). Owner slice: **B5**. B0 landed the stubs below; they do no I/O and return empty or zero, so nothing is buyer-visible until B5.

Public entries: `index.ts` (server) and `browser.ts` (providers, duration units, claim statuses/resolutions/openers, limits, `LineWarrantyExtra`).

## Will own

Policy CRUD with immutable revisions, the product warranty projection, the per-line extras reader, buyer warranty lists, and claims (open and update) as records backed by a `warranty_claim` conversation thread.

## Seams already mounted (B0)

- Stubs: `listLineWarranties`, `countActiveBuyerWarranties` (`extras.ts`).
- Routers: `apps/api/src/routes/admin/warranty-policies.ts`, `routes/admin/warranty-claims.ts`, `routes/admin/orders/warranty-claims.ts` (staff opens a claim from an order), `routes/customer-auth/warranties.ts`, `routes/storefront-orders/warranties.ts`.
- Permissions (`PRODUCTS_EDIT` for policies, `ORDERS_EDIT` for claims) in `route-permissions/warranty.ts`; operations in `operation-registry/{dashboard,storefront}-warranty.ts`.

## Planned edges

`warranty → conversations` (claim threads), `orders` (line and fulfilment reads), `products` (the product's policy). No domain in the existing cycle group may import `warranty`.

## Invariants (design §5.4)

- Exactly one warranty record per fulfilment line that has a revision (DB trigger), voided with its fulfilment. Revisions are immutable; the line's revision is frozen at commit.
- Buyer claims only on active warranties; at most one open claim per warranty; the thread is created in the same batch.
- Claims never mutate money, stock or order status.
