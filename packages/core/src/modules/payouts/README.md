# Payouts

Money an app sends out of the store to a payee (a marketplace's seller, an affiliate) through a payout provider, the `payout` port. Core keeps the record; the provider moves the money. Audience: contributors and coding agents.

## Entries

`index.ts` is the server entry. There is no browser entry.

Main file: `payouts.ts`.

- `recordPayout`: commits the payout `pending`, one row per app and Idempotency-Key (`INSERT … ON CONFLICT DO NOTHING` on `(app_id, idempotency_key)`). A repeat finds the row; a different request under the key is 409 `payout_request_mismatch` (`details.payoutId`).
- `applyPayoutAnswer`: a provider's fact, forward only, as a compare-and-set on `version`. A fact about a final or further-on payout, or one naming another provider payout, changes nothing. Failure codes are cut to lower_snake; reasons lose contact data and credentials and are cut to 300 characters.
- `applyPayoutCallback`: one verified callback update of a provider, by the platform's payout id (scoped to that provider) or the provider's own reference. Unknown payouts are ignored.
- `getAppPayout`, `listAppPayouts`: an app's own payouts only, in `(updated_at, id)` order.
- `payoutRepresentation`, `readPayoutRepresentation`: the sealed `payout` representation.

## Layer and imports

- Layer L0, a leaf. It imports no domain: `@scalius/database`, `@scalius/shared` and core `errors` only.
- The provider call is `apps/api/src/plugins/providers/payout.ts` (the API owns the plugin host). The stable routes are `apps/api/src/routes/admin/resources-payouts.ts` (`payouts.create`, `payouts.get`, `payouts.list`); callbacks are `apps/api/src/routes/webhooks/payouts.ts`.

## Tables

| Table | Role and constraints |
|-------|----------------------|
| `payouts` | One payout. Id `pyt_` + random. `app_id` is the app that sent it, the only one that reads it. `provider_id` is `<plugin id>:<provider id>`. `amount_minor` is above 0, `currency` ISO 4217. Unique `(app_id, idempotency_key)`; `request_hash` is the SHA-256 of what the key was first used for. `provider_ref` is unique per provider once set. `failure_code` is set exactly when `failed`; `settled_at` exactly when `paid` or `failed`. Triggers keep the identity (who, how much, to whom, the key, a set `provider_ref`) immutable, move `status` forward only and refuse a delete. Event triggers write `payout.created` and `payout.updated`. |

## Rules

- A payout is committed before its provider call, and the provider is called with `payoutId` = the row id on every retry: the port requires the provider to apply a payout once per `payoutId`.
- A `declined` or `misconfigured` provider error ends the payout `failed` with its code. A `retryable` error (uncertain or not), a timeout or an invalid answer leaves it `pending`; the same `payouts.create` request resubmits it.
- Statuses move `pending → processing → paid | failed`; `paid` and `failed` are final.
