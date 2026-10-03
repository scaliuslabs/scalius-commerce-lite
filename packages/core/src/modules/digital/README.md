# Digital

Digital goods: downloadable files in private R2, licence-key pools that are the variant's stock, per-line entitlements, and cookie-bound download tickets. Audience: contributors and coding agents.

## Entries

- `index.ts` is the server entry (assets, keys, buyer downloads, entitlements, the delivery plan, the cart readiness SQL).
- `browser.ts` is the closed entry: `DIGITAL_ASSET_KINDS`, `DIGITAL_UPLOAD_STATUSES`, `LICENCE_KEY_STATUSES`, `DIGITAL_LIMITS` and the `LineDigitalExtra` types.
- Pure rules (limits, part geometry, download filenames, key import parsing) live in `@scalius/shared/digital`.

Main files:

- `assets.ts`, `uploads.ts`: files and key pools, multipart uploads into `private/digital/<asset>/<upload>`. `sweepDigitalUploads` aborts uploads older than 24 hours and deletes a replaced file's object one day after the switch.
- `licence-keys.ts`: import (at most 500 keys per request, deduped by HMAC per pool) and revoke of unused keys. Each change commits with a ledger-v2 stock edge.
- `fulfiller.ts`: `planDigitalDelivery` (file entitlements and FIFO key assignment for the auto-fulfil batch).
- `downloads.ts`, `entitlements.ts`: buyer list, counted ticket mint, key reveal; staff reset and revoke.
- `deliverable.ts`: `digitalDeliverableSql`, the cart-validation readiness column.

## Layer and imports

- Layer L4. Imports `inventory` (key import and revoke run through `executeInventoryOperation` with companion statements).
- Imported by `checkout` (`digitalDeliverableSql`) and `fulfilment` (`planDigitalDelivery`, composed in `fulfilment/auto/digital.ts`). Send-time message content is resolved in `apps/api/src/notification-content/digital.ts`.

## Tables

| Table | Role and constraints |
|-------|----------------------|
| `digital_assets` | A file or a key pool of a product. `variant_id` is NULL for a product-wide file. `status` is `draft`, `ready` or `archived`. `current_r2_key` must start with `private/digital/`. `download_limit` is 1 to 100 or NULL (default 5). `access_days` is 1 to 3,650 or NULL. `version` is the CAS token. |
| `digital_asset_uploads` | Multipart session. The `parts` JSON holds the declared file and each part's etag. |
| `digital_entitlements` | What an order line received. Unique `(order_item_id, asset_id)`. A CHECK keeps `download_count` within `download_limit`. The limit and expiry are snapshots from delivery. |
| `digital_licence_keys` | One key. `key_ciphertext` (AES-GCM), `key_hash` (HMAC, unique per pool), `key_last4`. A trigger allows only `available` to `assigned` or `revoked`. Assignment is final. |

None of these tables is buyer-visible, so no DVC dependency applies.

## Rules

- A key pool is the variant's tracked stock. Import adds keys and `+n` stock in one batch. Revoke removes unused keys and `-n`. Order reservation, release and delivery move the stock as for any SKU.
- A pool needs a live, tracked, digital SKU. A variant has at most one pool and at most 10 files.
- No manual path changes a digital SKU's stock (`products/digital-stock-rules.ts`). A SKU turns digital only without stock, and one with a ready pool keeps tracking.
- Delivery happens after settlement, or after staff confirmation when `checkout.autoFulfilMode` is `after_confirmation` ([`fulfilment`](../fulfilment/README.md)).
- A key is assigned at most once. When a pool has too few keys, the whole batch rolls back and nothing is delivered. A `digital_keys_exhausted` staff alert is recorded (deduped per variant per day). The 15-minute sweep retries after an import.
- `digitalDeliverableSql` is 1 when the variant has a ready file (product-wide or its own) or a ready pool, and no ready pool is empty. Otherwise cart validation answers `FULFILMENT_UNAVAILABLE`.
- Uploads use fixed 50 MiB parts (the last may be shorter), at most 40 parts. The largest file is 2,097,152,000 bytes. Replacing a file moves `current_r2_key`, so earlier buyers get the new file.
- A cancelled, refunded or returned order ends access. Downloads and key reveals stop, and lists show the access as ended.
- A download ticket expires after 10 minutes. The mint is a guarded `UPDATE`: the count never passes the limit under concurrent mints. Resuming within the window does not count again.
- A ticket signature (HMAC from `SCALIUS_SECRET`) covers the entitlement id, expiry and a hash of the buyer's proof (session token or receipt proof). Every failure is the same 404.
- Files stream only through the API as sandboxed attachments with Range support. No bearer URL downloads anything.
- Licence keys are encrypted with keys derived from `CREDENTIAL_ENCRYPTION_KEY`, read strictly with no fallback. Plaintext never reaches logs, outbox payloads or receipts. Staff see `last4`. A buyer reveals a key only by `POST`.

## Routes

Admin permissions are in `packages/core/src/auth/rbac/route-permissions/digital.ts`.

| Method and path | Permission |
|-----------------|------------|
| `GET, POST /api/v1/admin/products/{id}/digital-assets` | `products.view`, `products.edit` |
| `PATCH, DELETE /api/v1/admin/digital-assets/{id}` | `products.edit` |
| `POST /api/v1/admin/digital-assets/{id}/uploads`, `GET .../uploads/{uploadId}`, `PUT .../uploads/{uploadId}/parts/{n}`, `POST .../uploads/{uploadId}/complete` | `products.edit` |
| `GET, POST /api/v1/admin/digital-assets/{id}/licence-keys`, `POST .../licence-keys/revoke` | `products.edit` |
| `POST /api/v1/admin/digital-entitlements/{id}/reset` and `/revoke`, `POST /api/v1/admin/orders/{id}/digital/resend` | `orders.edit` |

Buyer routes:

- Account: `GET /api/v1/customer-auth/downloads`, `POST /api/v1/customer-auth/downloads/{entitlementId}/ticket`, `POST /api/v1/customer-auth/licence-keys/{keyId}/reveal`.
- Guest receipt: `GET /api/v1/orders/receipt/{id}/downloads`, `POST /api/v1/orders/receipt/{id}/downloads/{entitlementId}/ticket`, `POST /api/v1/orders/receipt/{id}/licence-keys/{keyId}/reveal`.
- `GET /api/v1/orders/downloads/{entitlementId}/{exp}/{sig}` streams the file. The proof is `X-Receipt-Token` or the customer session. The storefront proxies it from `apps/storefront/src/pages/api/downloads/`.

Dashboard code: `apps/admin-v2/src/components/admin/product-form/DigitalDeliveryCard.tsx` and `DigitalKeyDialogs.tsx`.
