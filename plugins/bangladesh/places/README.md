# Bangladesh places

The delivery places of Bangladesh: 66 cities, 1,258 thanas and 10,226 areas.
Pathao's delivery locations are the source. The Scalius demo store exported
them on 2026-10-07.

- `places.json` has one place per line. Each place has:
  - `key`: a stable source key, for example `pathao:area:13193`.
  - `level`: 1 is a city, 2 is a thana, 3 is an area.
  - `parent`: the key of the parent place.
  - `name`.
  - `externalIds`: the courier IDs of the place.
  - `active`: whether the courier delivers there.
  - `homeDelivery` and `pickup`: the availability flags, when Pathao gives them.
  - `legacyId`: the place's row ID in stores that were set up before this
    dataset existed.
- `manifest.json` has the dataset id (`bd`, the source of the places it
  creates), the level labels, the counts and the SHA-256 of `places.json` (the
  dataset version).

The import matches a place by `key`, then by `legacyId`, and never deletes or
switches off a merchant's own places. The rules are in
[docs/PLACES.md](../../../docs/PLACES.md).

- The Bangladesh pack (`scalius.bangladesh`) owns this dataset. Activating the
  pack loads it into the store; its hourly job finishes a load and loads a
  newer version after an update.
- Load it into the local store without the pack: `pnpm places:import`.
- Do not edit a place by hand. Refresh the dataset from Pathao's location API
  (`pnpm places:pathao-dataset --credentials <file.json>`), then review the
  diff.
