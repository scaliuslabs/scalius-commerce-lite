# Plugins

Installed apps' persistent state and lifecycle (layer L4), for contributors. The domain imports `events` (delivery fan-out) and `objects` (manifest types and records), plus `@scalius/shared`, the database and the shared `auth`, `cache-deps` and `errors` areas. `checkout` and `storefront` import it. The API runs app code in `apps/api/src/plugins`. The author's guide is `packages/plugin-sdk/README.md`.

## Tables

| Table | Holds |
| --- | --- |
| `plugin_installations` | One row per app: manifest, approved grant, status, settings (secrets sealed as `ps1:...`), `revision`. |
| `plugin_registrations` | Rows derived from the manifest in the same batch as each manifest write (`registry.ts`). `kind` is `event`, `function`, `cron` or `provider` (one row per app and port). |
| `plugin_kv` | Private `ctx.kv` cache entries, each with a revision and optional expiry. |
| `object_types`, `object_records` | `ctx.objects` data in the Objects domain, validated against manifest fields. |
| `plugin_log_entries`, `plugin_event_deliveries`, `plugin_cron_runs` | The masked log ring, delivery state (8 attempts), cron claims. |
| `plugin_migrations` | One row per data update an app ran (0125). Kept by a keep-data uninstall. |

An app's sales channels (`manifest.salesChannels`, MARKETS-DESIGN D6) are `sales_channels` rows `<plugin id>:<id>` (kind `app`), written in the batch of each install, update and uninstall: declared channels are upserted, a channel no longer declared is removed when no order names it, else switched off. They are active while the app is active (activate, deactivate and a load failure set them in the same batch).

Records, KV, logs, deliveries and cron runs belong to the plugin id, not to the installation row, so an uninstall that keeps data leaves them. `order_holds` belongs to `orders`. `storefront.ts` reads the active installations a public render needs.

## An app's data (`app-data.ts`)

Everything an app owns is keyed by its plugin id: object types (namespace) and records, custom fields (namespace) and values, `plugin_kv`, `plugin_customer_roles`, its jobs in `bulk_runs`, `app_resource_owners`, its webhook subscriptions, logs, deliveries, cron runs and data updates. An uninstall that keeps data also writes `system_kv` `plugin-retained:<id>` (name, version, source, signer, stored settings, `revision`): `installPlugin` takes the settings back (secrets only for the same signer) and deletes the row in its batch, so a reinstall reclaims everything. `listRemovedAppData` lists, by app, the data of every plugin id with no installation (any source, including a bundled app removed from the deployment), named from that row or by its id when none exists. `appDataDeleteStatements` is the one delete, used by `uninstallPlugin` without `keepData` and by `deleteRemovedAppData` (guarded: no installation, and the retained row unchanged since the listed `revision`, 0 when none). Catalogue items the app created are not deleted here: the API (`apps/api/src/plugins/app-data.ts`) reads them first and, after the batch, runs the staff permanent delete on the trashed ones (inventory history, orders or a file still shown keep them) and removes the app's R2 files under `private/plugins/<id>/`; live ones become the store's own.

## Lifecycle

Status is `installed`, `active`, `disabled` or `failed`.

No read mappings for retired manifest shapes before v2 is stable. A row whose stored manifest no longer parses is skipped by the runtime but never hidden (`readPluginInstallations`): a bundled one is rewritten from the deployed code by the next sync (its approved grant decides active or waiting for approval); any other is listed on the Apps page as failed, reinstall needed. Activate, deactivate, update, uninstall and settings writes compare-and-set on `plugin_installations.revision` (`installation_revision_conflict`).

1. `installPlugin` adds an `installed` row with the setting defaults. Nothing runs. Bundled apps install from `apps/api/src/plugins/bundled-sync.ts`.
2. `activatePlugin` needs the required settings filled, stores the grant the manifest asks for and sets `active`. Only a Super Admin may activate.
3. `updatePluginInstallation` replaces the manifest, rewrites the registrations, migrates the settings and synchronizes declared object types and rebuilds changed indexes. An active app whose update asks for more access returns to `installed` until a Super Admin approves it; presentation (sections, blocks, skins) under an approved `storefrontCode` grant asks for nothing new. It also replaces a row whose stored manifest no longer reads (its grant still decides). The bundled sync marks a running app `failed` with the reason when the deployed release cannot be installed.
4. Deactivate sets `disabled`. `markPluginFailed` sets `failed` when the host cannot load the code.
5. `uninstallPlugin` removes the row. With `keepData` it cancels waiting deliveries and keeps the app's name and settings (`plugin-retained:<id>`). Without it, it deletes everything the app owns (`appDataDeleteStatements`).
6. `setPluginFeature` turns one of an active app's features on (a Super Admin's consent to that feature's access, checked by grant key) or off (revoked at once). The grant records the features that are on (`grant.features`); `toPluginInstallation` reads the manifest through `pluginManifestWithFeatures`, so `installation.manifest` is the app as it runs and every runtime reader skips off features. `declaredManifest` keeps the whole declaration. Registrations follow in the same batch. An update keeps the features that are on and starts new ones off; settings of an off feature stay stored but are hidden and refused on write.
7. `restorePluginRelease` puts back the release an update replaced (rollback). `stopPlugin` and `stopThirdPartyPlugins` (`safety.ts`) are the emergency stop: `disabled` with a reason, no revision check, no app code. `recordPluginBreach` counts limit breaches and stops an app at the plan's threshold. `recordPluginMigration` and `measurePluginStorage` keep the data-update marker and the measured size on the installation.

`registry-trust.ts` declares the `plugin_registry` settings document (registries and trusted developer keys); the official registry is pinned in `/shared/plugins/registry`.

`apps/api/src/plugins/lifecycle.ts` runs the app's hooks around these calls. In `/api/v1/admin/apps/*`, `GET` needs `apps.view`. Activate, deactivate, settings, uninstall and delivery retry need `apps.manage`. An app's own routes (`/api/v1/plugins/<id>/admin/**`) need `apps.view` for `GET` and `apps.use` for other methods.

## Atomic writes

Object record helpers are exported by `@scalius/core/modules/objects`.

- `writeObjectRecords` writes up to 25 puts, deletes and checks across object types in one provider batch. `expectedRevision` (a number, or `null` for "must not exist") adds a guard ahead of the writes. A failed guard aborts the batch as `object_conflict` (`details.index` names the operation). A unique-index violation aborts it as `object_unique_violation`.
- `getObjectRecordVersion`, `getPluginKvVersion` and `compareAndSetPluginKv` (`kv_conflict`) serve conditional writes. The SDK builds `update` and `increment` as read-check-write loops over them.
- `prepareAppObjectCommit` and `appObjectCommitStatements` let checkout write an app's snapshot record in the order's commit batch at the revision the app saw (`checkout/commit.ts`). `isAppObjectCommitConflict` recognizes the lost race.

## Cache dependencies

Installations and registrations advance `plg:<plugin id>` and `plg:*` transactionally. Objects advance `obj:<typeId>` only when the type or affected record is public, including removal from publication. Private object writes have no public dependency cost. Bookkeeping-only changes advance nothing. `plugin_kv`, logs, deliveries and cron runs have no public dependency. Readers declare `deps.plugin(id)`, `deps.anyPlugin()` or `deps.objects(typeIds)` (registry: `packages/shared/src/cache-deps.ts`).
