# Plugins

Installed apps' persistent state and lifecycle (layer L1), for contributors. The domain imports only `events` (`event-deliveries.ts` implements its fan-out target), plus `@scalius/shared`, the database and the shared `auth`, `cache-deps` and `errors` areas. `checkout` and `storefront` import it. The API runs app code in `apps/api/src/plugins`. The author's guide is `packages/plugin-sdk/README.md`.

## Tables

| Table | Holds |
| --- | --- |
| `plugin_installations` | One row per app: manifest, approved grant, status, settings (secrets sealed as `ps1:...`), `revision`. |
| `plugin_registrations` | Rows derived from the manifest in the same batch as each manifest write (`registry.ts`). `kind` is `event`, `function`, `cron` or `provider` (one row per app and port). |
| `plugin_records`, `plugin_kv` | `ctx.storage` and `ctx.kv` data, each with a `revision`. |
| `plugin_log_entries`, `plugin_event_deliveries`, `plugin_cron_runs` | The masked log ring, delivery state (8 attempts), cron claims. |
| `plugin_migrations` | One row per data update an app ran (0125). Kept by a keep-data uninstall. |

An app's sales channels (`manifest.salesChannels`, MARKETS-DESIGN D6) are `sales_channels` rows `<plugin id>:<id>` (kind `app`), written in the batch of each install, update and uninstall: declared channels are upserted, a channel no longer declared is removed when no order names it, else switched off. They are active while the app is active (activate, deactivate and a load failure set them in the same batch).

Records, KV, logs, deliveries and cron runs belong to the plugin id, not to the installation row, so an uninstall that keeps data leaves them. `order_holds` belongs to `orders`. `storefront.ts` reads the active installations a public render needs.

## Lifecycle

Status is `installed`, `active`, `disabled` or `failed`. Activate, deactivate, update, uninstall and settings writes compare-and-set on `plugin_installations.revision` (`installation.revision_conflict`).

1. `installPlugin` adds an `installed` row with the setting defaults. Nothing runs. Bundled apps install from `apps/api/src/plugins/bundled-sync.ts`.
2. `activatePlugin` needs the required settings filled, stores the grant the manifest asks for and sets `active`. Only a Super Admin may activate.
3. `updatePluginInstallation` replaces the manifest, rewrites the registrations, migrates the settings and re-indexes changed collections. An active app whose update asks for more access returns to `installed` until a Super Admin approves it.
4. Deactivate sets `disabled`. `markPluginFailed` sets `failed` when the host cannot load the code.
5. `uninstallPlugin` removes the row. With `keepData` it cancels waiting deliveries. Without it, it also deletes the app's records, KV, logs, deliveries, cron runs, data-update rows and custom-field definitions.
6. `setPluginFeature` turns one of an active app's features on (a Super Admin's consent to that feature's access, checked by grant key) or off (revoked at once). The grant records the features that are on (`grant.features`); `toPluginInstallation` reads the manifest through `pluginManifestWithFeatures`, so `installation.manifest` is the app as it runs and every runtime reader skips off features. `declaredManifest` keeps the whole declaration. Registrations follow in the same batch. An update keeps the features that are on and starts new ones off; settings of an off feature stay stored but are hidden and refused on write.
7. `restorePluginRelease` puts back the release an update replaced (rollback). `stopPlugin` and `stopThirdPartyPlugins` (`safety.ts`) are the emergency stop: `disabled` with a reason, no revision check, no app code. `recordPluginBreach` counts limit breaches and stops an app at the plan's threshold. `recordPluginMigration` and `measurePluginStorage` keep the data-update marker and the measured size on the installation.

`registry-trust.ts` declares the `plugin_registry` settings document (registries and trusted developer keys); the official registry is pinned in `/shared/plugins/registry`.

`apps/api/src/plugins/lifecycle.ts` runs the app's hooks around these calls. In `/api/v1/admin/apps/*`, `GET` needs `apps.view`. Activate, deactivate, settings, uninstall and delivery retry need `apps.manage`. An app's own routes (`/api/v1/plugins/<id>/admin/**`) need `apps.view` for `GET` and `apps.use` for other methods.

## Atomic writes

- `writePluginRecords` writes up to 25 puts, deletes and checks across collections in one provider batch. `expectedRevision` (a number, or `null` for "must not exist") adds a guard ahead of the writes. A failed guard aborts the batch as `storage.conflict` (`details.index` names the operation). A unique-index violation aborts it as `storage.unique_violation`.
- `getPluginRecordVersion`, `getPluginKvVersion` and `compareAndSetPluginKv` (`kv.conflict`) serve conditional writes. The SDK builds `update` and `increment` as read-check-write loops over them.
- `prepareAppStorageCommit` and `appStorageCommitStatements` let checkout write an app's snapshot record in the order's commit batch at the revision the app saw (`checkout/commit.ts`). `isAppStorageCommitConflict` recognizes the lost race.

## Cache dependencies

Triggers generated for migration 0110 (`cdep_plugin_*`) advance dependencies in the same transaction as each write: `plg:<plugin id>`, `plg:*` and `t:<table>` for installations and registrations, and `plgs:<plugin id>:<collection>` and `t:plugin_records` for records. A write that changes only bookkeeping columns advances nothing. `plugin_kv`, logs, deliveries and cron runs have no public dependency. Readers declare `deps.plugin(id)` or `deps.anyPlugin()` (registry: `packages/shared/src/cache-deps.ts`).
