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
- `manifest.json` has the level labels, the counts and the SHA-256 of
  `places.json`.

The Bangladesh pack plugin owns this dataset. It seeds the place directory and
updates it idempotently. It matches a place by `key` (then by `legacyId`) and
never deletes a merchant's own places. Do not edit a place by hand: refresh the
dataset from the couriers' location APIs, then review the diff.
