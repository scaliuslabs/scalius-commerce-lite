# Digital Module

Digital goods: downloadable files and licence keys (design: `audit/rewrite-2026-09-23/WAVE-B-DESIGN.md` §3). Owner slice: **B3**.

Public entries: `index.ts` (server) and `browser.ts` (asset kinds, upload and key statuses, limits, `LineDigitalExtra`). Pure rules (limits, part geometry, filenames, key import parsing, masking) live in `@scalius/shared/digital`.

## Files

| File | Owns |
|---|---|
| `assets.ts` | Files and key pools of a product; multipart uploads into private R2 (`private/digital/<asset>/<upload>`, 50 MiB parts, ≤ 40 parts); replace moves `current_r2_key`; archive, delete only when nothing was delivered |
| `uploads.ts` | The maintenance sweep: aborts uploads older than 24 h, deletes replaced objects a day after the switch |
| `licence-keys.ts` | Import (≤ 500, deduped by HMAC per pool) and revoke of unused keys, each committed with a ledger-v2 stock edge through `executeInventoryOperation(…, { companionStatements })`: the pool is the variant's stock |
| `fulfiller.ts` | The delivery plan for the auto-fulfil batch: file entitlements (limit and expiry snapshots), FIFO key assignment with a count guard. `fulfilment/auto/digital.ts` composes it with the outbox rows |
| `downloads.ts` | Buyer lists, the counted ticket mint (guarded `UPDATE`, D4), ticket open (signature bound to the cookie proof, D5), key reveal |
| `entitlements.ts` | Staff reset/revoke, the resend guard, and the send-time content of the delivery message |
| `extras.ts` | Per-line extras (`downloads`, `licenceKeys`) and the account Downloads count |
| `deliverable.ts` | The cart-validation readiness column (a ready file or pool, no empty ready pool) |
| `secrets.ts` | Licence-key hash and ciphertext from `CREDENTIAL_ENCRYPTION_KEY` (strict, no fallback); ticket HMAC from `SCALIUS_SECRET` |

## Edges

`digital → inventory` (key import/revoke as ledger-v2 stock edges). `fulfilment → digital` only through `fulfilment/auto/digital.ts`; `checkout → digital` only through `deliverable.ts`. Nothing in the existing cycle group imports `digital`; notification content is resolved by `apps/api/src/notification-content/digital.ts`.

## Invariants (design §3.6, tests in `digital.d1.test.ts`)

- Entitlements and keys only after settlement (and staff confirmation in `after_confirmation` mode).
- A key is assigned at most once (trigger); too few keys delivers nothing: the batch rolls back, a `digital_keys_exhausted` staff alert is recorded (deduped per variant per day), and the 15-minute sweep retries after an import.
- Pool = stock: import and revoke move keys and stock in one batch; delivery deducts through `reconcileInventoryForStatus(DELIVERED)`.
- A download count never passes its limit under concurrent mints. Tickets are bound to the cookie proof; a logged URL alone downloads nothing. Objects only under `private/digital/`, served as sandboxed attachments with Range.
- Keys are encrypted at rest; plaintext never reaches logs, outbox payloads or delivery receipts. Staff see `last4` only.
