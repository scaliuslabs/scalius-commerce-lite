# Places

The place directory holds the delivery places of any country. Buyers in Bangladesh pick City, Thana and
Area from it, and couriers book with the courier ids it keeps. For contributors who change places,
imports or their readers. Schema: `places` in `packages/database/src/schema/delivery.ts` (migration
0118); import: `packages/core/src/modules/delivery/places-import.ts`; level names:
`@scalius/shared/places`.

## Model, and why

- **One tree per country**, at most four levels; a parent is one level up in the same country
  (triggers enforce it). Bangladesh names its levels City, Thana and Area; other countries get generic
  names until they have their own.
- **Soft deletes.** Orders and bookings keep reading a place's name and courier ids after it is
  removed.
- **Courier ids by courier** (`external_ids`, `{ "pathao": "32" }`), because couriers book with their own
  ids, not ours.
- **Dataset ownership.** `source`, `source_key` and `source_version` record which dataset owns a place,
  so a re-import updates its own places and never a merchant's.
- Read children by `parent_id` alone: the country filter would only make SQLite pick the wider index.
- Cache: any change except the `source*` columns advances `loc`; the checkout fence moves when a name,
  parent, level, country, status or deletion changes.

## The Bangladesh adapter

Bangladesh addresses carry place ids in `city`, `zone` (the thana) and `area`, and only Bangladesh
places can fill them. Readers select `placeAddressFieldSql`, so the public `/api/v1/locations/*` routes,
checkout, the address book, zones and tax regions read the same shapes as before the directory existed.

## Datasets and import

A dataset is a `places/` directory in the app that owns it (`plugins/bangladesh/places/`):
`places.json` (one entry per line, deterministic order) and `manifest.json` (source, country, labels,
counts, and the SHA-256 that is the version).

`importPlaces()` upserts one chunk of at most 500 places (`PLACE_IMPORT_MAX_ENTRIES`), parents first;
running a chunk again changes nothing. It matches by key, then legacy id, then courier id, then name
under the same parent. A dataset changes a place's status only when the dataset's own `active` changed
since the last import, so the merchant's switch stays; it never touches a merchant's place, never
undeletes, and `finish` deactivates (never deletes) the places a version no longer lists. A name clash or
unknown parent is reported and retried next import. Every statement binds one JSON list.

Callers: the dashboard and agents (`dashboard.delivery_locations.import`), apps through the stable
`delivery_locations.import` operation (scope `write_places`, which can add and update but never
delete), and locally `pnpm places:import`. `pnpm places:pathao-dataset --credentials <file.json>`
rewrites the Bangladesh dataset from Pathao for review.

Merchants may remove or deactivate the whole Bangladesh hierarchy (for example to pause physical
delivery); digital and service orders still check out, and placed orders keep their frozen address.
