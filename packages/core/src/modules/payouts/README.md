# Payouts

Money an app sends out of the store to a payee (a marketplace's seller, an affiliate) through a payout provider, the `payout` port. Core keeps the record; the provider moves the money. Audience: contributors and coding agents.

## Entries

`index.ts` is the server entry. There is no browser entry.

Main file: `payouts.ts`.

- `recordPayout`: commits the payout `pending`, one row per app and Idempotency-Key (`INSERT … ON CONFLICT DO NOTHING` on `(app_id, idempotency_key)`). A repeat finds the row; a different request under the key is 409 `payout_request_mismatch` (`details.payoutId`).
- `applyPayoutAnswer`: a provider's fact, forward only, as a compare-and-set on `version`. A fact about a final or further-on payout, or one naming another provider payout, changes nothing. Failure codes are cut to lower_snake; reasons lose contact data and credentials and are cut to 300 characters.
- `applyPayoutCallback`: one verified callback update of a provider, by the platform's payout id (scoped to that provider) or the provider's own reference. Unknown payouts are ignored.
- `getAppPayout`, `listAppPayouts`: an app's own payouts only, in `(updated_at, id)` order.
- `payoutRepresentation`, `payoutRepresentations`, `readPayoutRepresentation`: the sealed `payout` representation, with its `reversals` (oldest first, read for a page in one query) and `reversedMinor`.

`reversals.ts` (0206): money an app takes back from its `paid` payout.

- `recordPayoutReversal`: commits the reversal `pending`, one row per app and Idempotency-Key with the request's hash (409 `payout_reversal_request_mismatch` for another request). Refuses another app's payout (404), one that is not `paid` (409 `payout_not_reversible`), another currency (422 `payout_reversal_currency_mismatch`) and more than the payout less its reversals that have not failed (409 `payout_reversal_exceeds_payout`, `details.reversibleMinor`); the triggers refuse the same under a race.
- `applyPayoutReversalAnswer`, `applyPayoutReversalCallback`: a provider's fact, forward only, as a compare-and-set on `version`, as for payouts.

## Layer and imports

- Layer L0, a leaf. It imports no domain: `@scalius/database`, `@scalius/shared` and core `errors` only.
- The provider call is `apps/api/src/plugins/providers/payout.ts` (the API owns the plugin host). The stable routes are `apps/api/src/routes/admin/resources-payouts.ts` (`payouts.create`, `payouts.get`, `payouts.list`, `payouts.reverse`); callbacks are `apps/api/src/routes/webhooks/payouts.ts`.

## Tables

| Table | Role and constraints |
|-------|----------------------|
| `payout_reversals` | One reversal of a paid payout. Id `pyr_` + random. Copies the payout's `app_id`, `provider_id` and `currency`. Unique `(app_id, idempotency_key)` with `request_hash`; `provider_ref` unique per provider once set. Insert triggers refuse a payout that is not `paid` (or not the app's, provider's or currency's), a sum of unfailed reversals above the payout and a 21st reversal. Triggers keep the identity immutable, move `status` forward only (`pending`, `processing`, then `reversed` or `failed`) and refuse a delete; each insert and status move advances the payout's `version` and `updated_at`. Event triggers write `payout.reversal_updated` about the payout. |
| `payouts` | One payout. Id `pyt_` + random. `app_id` is the app that sent it, the only one that reads it. `provider_id` is `<plugin id>:<provider id>`. `amount_minor` is above 0, `currency` ISO 4217. Unique `(app_id, idempotency_key)`; `request_hash` is the SHA-256 of what the key was first used for. `provider_ref` is unique per provider once set. `failure_code` is set exactly when `failed`; `settled_at` exactly when `paid` or `failed`. Triggers keep the identity (who, how much, to whom, the key, a set `provider_ref`) immutable, move `status` forward only and refuse a delete. Event triggers write `payout.created` and `payout.updated`. |

## Rules

- A payout is committed before its provider call, and the provider is called with `payoutId` = the row id on every retry: the port requires the provider to apply a payout once per `payoutId`.
- A `declined` or `misconfigured` provider error ends the payout `failed` with its code. A `retryable` error (uncertain or not), a timeout or an invalid answer leaves it `pending`; the same `payouts.create` request resubmits it.
- Statuses move `pending → processing → paid | failed`; `paid` and `failed` are final.
- A reversal follows the same rules through the port's optional `reversePayout` (with `reversalStatus`), keyed by `reversalId`; a provider without them refuses (422 `payout_reversal_unsupported`) with nothing written. Statuses move `pending → processing → reversed | failed`.
