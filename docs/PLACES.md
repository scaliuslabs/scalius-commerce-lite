# Places

The place directory holds the delivery places of any country. Buyers pick their City, Thana and Area from it in Bangladesh. Couriers book with the courier ids it keeps. This page is for contributors who change places, imports or the readers.

## Model

`places` (`packages/database/src/schema/delivery.ts`, migration 0118) is one tree per country.

| Column | Rule |
|--------|------|
| `country_code` | ISO 3166-1 alpha-2, upper case. |
| `level` | 1 is the top. At most 4 (`PLACE_MAX_LEVEL`). |
| `parent_id` | Null for level 1. Otherwise a place one level up in the same country (triggers `places_parent_guard_*`, error `PLACE_PARENT_INVALID`). Clearing a parent is allowed: a hard-deleted parent sets it to null. |
| `name` | Trimmed, whitespace collapsed, at most 120 characters. Active names are unique among a country's level-1 places and among a place's children of one level. |
| `external_ids` | Courier ids by courier, JSON: `{ "pathao": "32" }`. |
| `metadata` | JSON. An import keeps the source's flags here: `home_delivery_available`, `pickup_available`. |
| `is_active`, `deleted_at` | Inactive places are hidden from buyers. Deletes are soft: orders and bookings keep reading names and courier ids. |
| `source` | The dataset that owns the place (`bd`). Null for a place the merchant created. |
| `source_key` | The stable source key (`pathao:area:13193`). Unique per country; null keys never collide. |
| `source_version` | The dataset version that last listed the place. |
| `source_active` | The `active` value the last import applied. Null when it applied none. |

- Indexes: `places_parent_id_idx` (children), `places_country_level_idx` (a country's level), `places_country_source_key_uidx` (key lookup; it also finds unkeyed rows).
- Read children by `parent_id` alone. A child is in its parent's country, so the country filter would only make SQLite choose the wider index.
- Migration 0118 copied every `delivery_locations` row with its id: country `BD`, level from type (city 1, zone 2, area 3). Zones, tax regions, addresses and courier mappings still point at the same rows.
- DVC: any change except the `source*` columns and `updated_at` advances `loc`. The checkout fence moves when the name, parent, level, country, status or deletion changes.

## Levels

`@scalius/shared/places` names each country's levels once, in English and Bangla. A country without its own names gets the generic ones.

| Country | Level 1 | Level 2 | Level 3 | Level 4 |
|---------|---------|---------|---------|---------|
| BD | City (শহর) | Thana (থানা) | Area (এলাকা) | none |
| Any other | Region (অঞ্চল) | City (শহর) | District (জেলা) | Area (এলাকা) |

## The Bangladesh adapter

Bangladesh addresses carry place ids in `city`, `zone` (the thana) and `area`. Only Bangladesh places can fill them (`PLACE_ADDRESS_COUNTRY`).

- `deliveryHierarchyField(level)` and `deliveryHierarchyLevel(field)` map a level to its field.
- SQL readers select `placeAddressFieldSql` (schema) to return `city`, `zone` or `area`. The public `/api/v1/locations/*` routes, checkout validation, the address book, zones and tax regions read this way, so their output is unchanged.
- A shipping zone holds Bangladesh places only. A tax region names a Bangladesh place by its field (`place_type`).

## Datasets

A dataset is a directory `places/` in the app that owns it. The Bangladesh dataset is `plugins/bangladesh/places/`; the Bangladesh pack loads it through the place import when it is activated:

- `places.json`: one `PlaceDatasetEntry` per line, sorted by level, parent key, lower-case name, key (`serializePlaceDataset()`).
- `manifest.json`: `id` (the source), `country`, the level labels, the counts and the SHA-256 of `places.json` (the version).

An entry has `key`, `level`, `parent` (the parent's key), `name`, `externalIds`, `active`, optional `homeDelivery` and `pickup`, and optional `legacyId` (the row id in stores set up before the dataset).

## Import

`importPlaces(db, { country, source, version, places, finish })` (`packages/core/src/modules/delivery/places-import.ts`) upserts one chunk. Running a chunk again changes nothing.

1. Send at most 500 places per call (`PLACE_IMPORT_MAX_ENTRIES`). Send parents before children. A later call can name a parent an earlier call created.
2. Send `finish: true` on the last call of a version.

Matching, in order: the key; the `legacyId` (an unkeyed row of the same level and country); a courier id of an unkeyed live row of the same level; the name among the unkeyed live places under the same parent. No match creates the place, under its `legacyId` when that id is free.

| Rule | Effect |
|------|--------|
| Name, parent, courier ids, flags | Take the dataset's values. Courier ids merge by courier. |
| Status of a place the dataset owns | Changes only when the dataset's `active` changed since the last import. The merchant's own switch stays. |
| Status of a merchant's place | Never changes. |
| A deleted place | Stays deleted. A new place under it is created deleted. |
| `finish` | The dataset's own places that this version did not list become inactive. Nothing is deleted. |
| A name an active sibling holds | The place keeps its old name and status and is reported (`name_taken`). The next import retries it. |
| An unknown parent | The place is skipped and reported (`parent_missing`). |

D1 cost: per level in a call, one read round of at most four statements; then one write batch for the call, one upsert per level. Every statement binds one JSON list (under 20 parameters).

Callers:

| Caller | How |
|--------|-----|
| Dashboard, agents, CLI | `POST /api/v1/admin/settings/delivery-locations/import` (`dashboard.delivery_locations.import`, permission `settings.delivery_locations.edit`). |
| Plugins | `ctx.api.call("dashboard.delivery_locations.import", { body })` through the plugin bridge. The manifest must request `settings.delivery_locations.edit`. The Bangladesh pack loads its dataset this way on activation and finishes or refreshes it with its hourly job (`plugins/bangladesh/src/places.ts`). Removing the pack keeps every place. |
| Local dev | `pnpm places:import [--dataset plugins/bangladesh/places] [--state .wrangler/state]` opens the local D1 file with Miniflare. `pnpm dev:post-sale:seed` runs it. |
| Pathao refresh | `pnpm places:pathao-dataset --credentials <file.json>` rewrites `plugins/bangladesh/places`. Review the diff, then commit it. |
| Dashboard Pathao import | `processPathaoImportChunk()` applies Pathao's live places through `importPlaces()` with source `bd`, without `finish`. |

## Dashboard

Settings, Shipping, Delivery areas lists one country at a time. The selector shows the countries that have places and Add country. Each level of the country is a tab. Delete all deletes one country's places.

## API

| Route | Use |
|-------|-----|
| `GET /api/v1/admin/settings/delivery-locations?country=&level=&parentId=&search=` | List places. `descendants` counts live places under each place, by level. |
| `GET /api/v1/admin/settings/delivery-locations/countries` | The countries with live places, with counts. |
| `POST /api/v1/admin/settings/delivery-locations` | Create a merchant place: `countryCode`, `level`, `parentId`, `name`. |
| `DELETE /api/v1/admin/settings/delivery-locations/all` | Hard-delete one country's places (`countryCode`). Refused for Bangladesh while checkout depends on them. |
| `GET /api/v1/locations/cities`, `/zones?cityId=`, `/areas?zoneId=` (and `/summaries`) | Public Bangladesh pickers, unchanged. |
