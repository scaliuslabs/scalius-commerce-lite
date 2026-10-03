# @scalius/plugin-sdk

Build Scalius apps: a manifest that says what the app may do, and handlers
the platform calls. The same module runs in both loaders:

- **bundled** (Workers Free, or the operator's choice): compiled into the API
  Worker from `scalius.plugins.json` (`pnpm plugin add <path>`), run
  in-process with every value structured-cloned like an RPC call;
- **sandbox** (Workers Paid): a Dynamic Worker per app with no network of
  its own; everything goes through the platform bridge.

The runtime that builds `ctx` is the same code in both, so an app that passes
its tests with `@scalius/plugin-sdk/testing` behaves the same in either.
References: `plugins/hello` (events, routes, cron, storage), `plugins/bulk-discount`
(checkout functions), `plugins/loyalty` (atomic storage and order commits),
`plugins/bkash` and `plugins/nagad` (payment providers).

```ts
import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.points",                // <vendor>.<name>
  name: "Points",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "…",
  author: { name: "Acme" },
  permissions: ["orders.view"],     // RBAC names every ctx.api call is checked against
  allowedHosts: ["api.acme.example"], // ctx.http targets; "host:port" for one non-default port
  events: ["order.paid"],
  storage: { balances: {}, ledger: { indexes: ["customerId"], unique: ["ref"] } },
  settings: [{ key: "api_key", label: "API key", type: "secret", required: true }],
} satisfies PluginManifestInput;

export default definePlugin({ manifest, events: { "order.paid": async (event, ctx) => { /* … */ } } });
```

Settings marked `secret` are encrypted with the store's credential key,
masked everywhere, never logged (the host masks them out of your log lines
and error messages), and present only in `ctx.settings` at run time.

## Storage

`ctx.storage.<collection>` holds JSON records (64 KiB each) of a collection
the manifest declares. Queries use declared indexes only (equality on the
leading fields, ordering by the next one), never a table scan.

Every write advances the record's **revision**. Writes can be conditional:

```ts
const current = await ctx.storage.balances.getVersion(customerId); // { data, revision } | null
await ctx.storage.balances.put(customerId, next, { expectedRevision: current?.revision ?? null });
// someone wrote since (or the record exists when null was expected): storage.conflict, nothing changed
```

- `update(id, patch, { expectedRevision? })` merges top-level fields; without
  a pinned revision a concurrent write is re-read and merged again, so no
  update is lost.
- `increment(id, field, delta, { min?, max? })` adds to a whole-number field
  atomically; a result outside the bounds changes nothing and fails with
  `storage.out_of_range`. A balance never goes below its floor, however many
  debits race.
- `ctx.storage.batch([...])` writes up to 25 `put` / `delete` / `check`
  operations across collections **all-or-nothing** in one database batch;
  each may carry `expectedRevision`. Use it for "credit once" patterns:

```ts
await ctx.storage.batch([
  { op: "put", collection: "ledger", id: `earn:${orderId}`, record, expectedRevision: null }, // only once
  { op: "put", collection: "balances", id: customerId, record: newBalance, expectedRevision: rev },
]);
```

`ctx.kv` is a small key/value store with TTLs; `getVersion` and
`compareAndSet(key, expectedRevision | null, value)` give the same
compare-and-set (`kv.conflict`). `batch` is a reserved collection name.

## Checkout functions

Functions are pure: `(input, settings) => output`, no I/O, strict time
limits; the platform validates the output and merges it (see
`@scalius/shared/plugins/functions`). Points: `cart.validate`,
`checkout.discounts`, `checkout.shipping_rates`, `checkout.payment_methods`,
`order.risk`. They run on every channel: the online store, staff (manual)
orders and buyer agents (`cart.channel`).

- **Failure policy.** By default a function that throws, times out or answers
  invalidly is left out (`onError: "skip"`). A check the store relies on may
  register `onError: "block"` (only `cart.validate` and
  `checkout.payment_methods`): checkout then stops with the store's own
  buyer-safe message (Settings → Checkout languages, "Apps at checkout").
- **Snapshots and commits** (`checkout.discounts`). Declare
  `snapshot: { collection }` and the signed-in buyer's record in that
  collection (record id = customer id) arrives as `input.snapshot`
  (`{ revision, data } | null`). Your answer may `commit: { record }`, the
  record's next version: the platform writes it in the order's own commit
  batch, at the revision you saw, and only when one of your discounts
  applied. If the record changed meanwhile the order fails
  (`APP_OFFER_CHANGED`) and the buyer reviews it: nothing is ever spent
  twice. Size the discount against `cart.lines[].lineTotalMinor` (after the
  store's own discounts). `plugins/loyalty` is the worked example.
- **Holds** (`order.risk`). Answer `{ level, reasons, hold: true }` to put the
  order on hold for staff review. A held order is not shipped, handed over or
  moved on until staff release the hold; it can still be cancelled. Nothing
  is cancelled automatically.

## Providers

An app can fill a **port**: the same typed interface the platform's own
adapters implement (`@scalius/shared/plugins/providers`). Core code calls one
interface per port and never asks whether it got a built-in adapter or an
app. Declare providers in the manifest, grouped by port, and implement each
with `definePaymentProvider`, `defineCourierProvider`, `defineSmsProvider`,
`defineEmailProvider`, `defineFraudProvider` or `defineTaxProvider`. A
provider's id inside the store is `<plugin id>:<provider id>`.

Every operation's input and output are validated by the host on both sides.
Fail with `ProviderError`:

| Category | Meaning | Platform reaction |
| --- | --- | --- |
| `declined` | The provider refused; nothing happened. | Shown, not retried. |
| `retryable` | Try again later. Add `{ uncertain: true }` if the call may have reached the provider. | Retried or reconciled; an uncertain outcome is kept and resolved, never repeated blindly. |
| `misconfigured` | Credentials or settings are wrong. | The provider is not ready; fail closed. |

A throw that is not a `ProviderError`, a timeout or an invalid answer counts
as `retryable` + `uncertain`. Messages must be merchant-safe: never put a
credential or a raw provider body in one. Inside a provider operation
`ctx.messaging` is refused; reach your provider with `ctx.http`. The
merchant sees your providers beside the built-ins in the matching settings
page, with readiness (the app is active, approved for the port, runnable
here, its settings complete and its secrets readable) and a connection test
when you declare `testConnection`.

### Build a payment provider

```ts
providers: {
  payment: [{
    id: "wallet",
    name: "Acme Wallet",
    checkoutName: "Acme Wallet",           // what buyers see
    flow: "hosted",                         // apps redirect; in-page card forms are built in
    chargeCurrencies: ["BDT"],              // or "any"
    amountLimits: { currency: "BDT", minMinor: 1_000, maxMinor: 50_000_00 }, // optional
    amountCodecs: { BDT: { wireExponent: 2 } },                               // optional
    operations: ["verifyReturn", "queryPayment", "refund", "refundStatus", "testConnection"],
  }],
},
```

Required: `createSession`, `verifyWebhook`. A hosted provider must also
implement `verifyReturn` and `queryPayment`; a provider that refunds must
implement `refundStatus` (and may add `listRefunds` to import refunds made
in the provider's dashboard).

1. **`createSession(input, ctx)`.** The platform has already claimed the
   attempt locally; `input.attemptKey` is your idempotency key (a retry of the
   same attempt must return the same provider session, never a second one:
   store it), `input.correlationId` (≤30 chars) is the merchant reference
   the provider must echo, `input.wireAmount` is the amount in your declared
   wire form (`{ minor, decimal }`; the platform refuses a charge your codec
   cannot carry exactly). Send the buyer to `input.urls.success` /
   `fail` / `cancel`; webhooks arrive at `input.urls.webhook`. Return
   `{ providerRef, redirectUrl }` (https only).
2. **`verifyReturn` / `verifyWebhook(request, ctx)`.** Authenticate before
   anything changes (a signature, or ask the provider server-to-server with
   the reference the request names: query strings are never authority).
   Answer `{ status: "event", event }`, `"ignored"`, `"invalid"` (forged:
   nothing changes) or `"retry"` (the provider could not be asked now). A
   confirmed event carries the provider-authenticated `amountMinor` and
   `currency`; the same capture reached by a webhook and a return must yield
   the same `eventType` + `eventId`, so the platform applies it once.
   Failed and cancelled events carry `correlationId` so the platform
   releases the right attempt.
3. **`queryPayment`** answers "did it go through?" for a buyer or staff
   reconcile: `{ providerStatus, event? }`.
4. **`refund`** is sent at most once per `input.idempotencyKey` (store
   what you sent); when the answer is lost, raise `retryable` +
   `uncertain` and the platform asks `refundStatus` later instead of
   refunding twice.

Test with the harness: `harness.provider("wallet", "createSession", input)`
validates both sides like the host. See `plugins/bkash` (Tokenized Checkout:
execute on return, query, refunds) and `plugins/nagad` (RSA-signed
initialize/complete, unverified).

### Build a courier

```ts
providers: {
  courier: [{
    id: "parcel",
    name: "Acme Parcel",
    trackingUrl: "https://track.acme.example/{trackingId}",                  // optional
    operations: ["findShipment", "cancelShipment", "verifyWebhook", "reconcileCod", "testConnection"],
  }],
},
```

Required: `createShipment`, `trackShipment`.

1. **`createShipment(input, ctx)`.** The platform inserts its own shipment row
   first and passes its id as `input.idempotencyKey`: a retry after a lost
   answer reuses it, so book at most once per key. `input.orderId` is the
   order number your courier records; `codAmountMinor` is the cash to collect
   (0 for prepaid) in minor units of `currency` (`decimalPlaces` for couriers
   that take major units). Return the booking: `externalId`, `trackingId`,
   a normalized `status` plus your `rawStatus`, the `chargeMinor` you quoted
   and an optional label (an https URL, or a PDF as base64 the platform
   stores privately). If the call may have reached the courier but you got no
   answer, raise `retryable` + `uncertain`; with `findShipment` (by order
   number) the platform finds the booking instead of booking twice.
2. **`trackShipment`** maps your courier's status onto
   `COURIER_SHIPMENT_STATUSES` (`picked_up`, `in_transit`, `delivered`,
   `returned`, …) with an ISO timestamp; the platform moves the order from it.
3. **`verifyWebhook`** authenticates a tracking push and answers
   `{ status: "update", externalId, tracking }`, `"ignored"` or `"invalid"`;
   the platform claims each push once.
4. **`reconcileCod`** reports what the courier collected and paid out for a
   parcel (minor units), so the merchant's COD ledger matches.

Never trust your courier's free text beyond the port's fields: the platform
stores only the normalized status and your short raw status for staff.
