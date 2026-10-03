# Plugins

Installed apps' persistent state and lifecycle. Depends only on `events`
and leaf modules; the API (`apps/api/src/plugins`) runs app code through the
host and its two loaders (bundled, sandbox).

| File | What |
| --- | --- |
| `installations.ts`, `grants.ts`, `settings-crypto.ts` | Install, activate (approved grant), update, uninstall; app settings with secrets sealed under the credential key |
| `registry.ts` | Active registrations by kind (`event`, `function`, `cron`, `provider`): one indexed read, none when nothing is active; `selectActiveCheckoutRegistrations` rides checkout's own read batch (functions and payment providers in one statement) |
| `storage.ts` | `ctx.storage` collections in `plugin_records`, queried only through declared indexes |
| `kv.ts` | `ctx.kv` with TTLs |
| `logs.ts`, `event-deliveries.ts`, `cron-runs.ts` | Masked log ring, event delivery and cron bookkeeping |
| `storefront.ts` | What storefront surfaces may read |

## Revisions and atomic writes

Every `plugin_records` row and `plugin_kv` entry has a `revision` each write
advances (cache dependencies follow from the 0110 triggers; nothing here
advances a key by hand).

- `writePluginRecords` writes up to 25 puts, deletes and checks across
  collections in **one** provider batch. An operation with `expectedRevision`
  (a number: still at it; null: must not exist) adds a guard statement ahead
  of the writes; a failed guard aborts the whole batch as `storage.conflict`
  (`details.index` names the operation). Unique-index violations abort it the
  same way (`storage.unique_violation`).
- `getPluginRecordVersion` / `getPluginKvVersion` read what a conditional
  write names; `compareAndSetPluginKv` is the KV twin (`kv.conflict`).
- The SDK builds `update` and `increment` as read-check-write loops over these
  in the app's runtime, so both loaders behave identically.
- `prepareAppStorageCommit` / `appStorageCommitStatements` let checkout write
  an app's snapshot record inside the order's commit batch at the revision
  the app's function saw (`checkout/commit.ts`), and
  `isAppStorageCommitConflict` recognizes the lost race.
