# Digital Module

Digital goods: downloadable files and licence keys (design: `audit/rewrite-2026-09-23/WAVE-B-DESIGN.md` §3). Owner slice: **B3**. B0 landed the stubs below; they do no I/O, and `digitalDeliverableSql` returns `0`, so digital lines keep failing closed (`FULFILMENT_UNAVAILABLE`) until B3.

Public entries: `index.ts` (server) and `browser.ts` (asset kinds, upload and key statuses, limits, `LineDigitalExtra`).

## Will own

Assets and multipart uploads into private R2 (`private/digital/<asset>/<upload>`), the upload sweep, licence-key import and revoke (the pool is the variant's tracked stock), the digital fulfiller, download tickets bound to the buyer's cookie proof, key reveal, entitlement reset and revoke, the per-line extras reader and the buyer downloads list.

## Seams already mounted (B0)

- Stubs: `digitalDeliverableSql` (`deliverable.ts`, read by cart validation), `sweepDigitalUploads` (`uploads.ts`), `listLineDeliveries`, `countBuyerDownloads` (`extras.ts`).
- Routers: `apps/api/src/routes/admin/digital-assets.ts` (asset, product-asset and entitlement routers), `routes/admin/orders/digital.ts` (resend), `routes/customer-auth/downloads.ts`, `routes/storefront-orders/downloads.ts`.
- Permissions (`PRODUCTS_EDIT` for assets, `ORDERS_EDIT` for entitlements) in `route-permissions/digital.ts`; operations in `operation-registry/{dashboard,storefront}-digital.ts`.

## Planned edges

`digital → inventory` (key import/revoke as ledger-v2 stock edges), `orders` (line reads), `settings` (delivery mode). `fulfilment → digital` only through `fulfilment/auto/digital.ts`. Nothing in the existing cycle group imports `digital`; notification content is resolved by `apps/api/src/notification-content/digital.ts`.

## Invariants (design §3.6)

- Entitlements and keys only after settlement. A key is assigned at most once; too few keys delivers nothing.
- Pool = stock. Download count never exceeds the limit under concurrent mints.
- Tickets are bound to the cookie proof; a logged URL alone downloads nothing. Objects only under `private/digital/`, served as sandboxed attachments.
- Keys are encrypted at rest with `CREDENTIAL_ENCRYPTION_KEY`-derived keys; plaintext never in logs, outbox payloads or delivery receipts.
