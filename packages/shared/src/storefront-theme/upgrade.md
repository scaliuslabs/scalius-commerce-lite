# Stored theme upgrades

`upgradeThemeDocument(document)` clones its input, applies one step per
version (`THEME_UPGRADES` in `upgrade.ts`), then validates the result against
the current strict schema. Stored live, draft and version reads use it through
`parseStoredStorefrontThemeDocument`; the storefront's `readStorefrontTheme`
uses it too. Writes accept only the current version, and a read never writes
back or replaces a merchant's document with the default theme: an invalid
document reads as null (the dashboard fails closed, the storefront renders the
default theme for that request).

## Purity

- Every step is a pure structural conversion. It uses only literals frozen with
  the version it reads (variant names, choice maps, historical defaults), never
  today's block or section registries.
- Today's registry defaults enter once, after the last step
  (`withCurrentDefaults`): settings an upgraded document never stored take
  today's defaults, and stored values win. A document that is already current
  is returned as a copy, unchanged.
- A variant or section type today's registries no longer know is left as
  stored, so the strict parse rejects it rather than guessing.

## Golden fixtures

`fixtures/v<N>.json` holds one stored document per version, captured from the
historical sources below (primary colour `#123456` and the Bangla/English
`merchant-story` copy are the markers the tests follow through every step).

| Input | Historical source | Conversion |
| --- | --- | --- |
| v1 | `519d88ef9^` | Pre-v2 semantic settings were unversioned; explicit `version: 1` and the unversioned shape both read. CSS colours become equivalent opaque hex (alpha flattens over the old white page); the fixed homepage order becomes sections. |
| v2 | `519d88ef9` | Independent heading/body fonts map to the pairing with the same faces: editorial + humanist is heritage, editorial + other is editorial, a humanist body is fresh, everything else retail. |
| v3 | `216fc3f55` | Layout choices become block variants of the department-mall template; category, delivery and rich-text sections are renamed with their ids, order and copy. |
| v4 | `92890ce73` | Shared navigation and listing filters become explicit; sidebar/bar layouts become the grid arrangement. |
| v5 | `727a1081d` | Template-only page chrome becomes stored listing settings; brand and home mode are added; options that never rendered (questions module, retired sticky modes, deal end times, sub-brand rows, trending queries) are removed. |
| v6 | `11d0d2788` | Landing pages (`pages.landing`) are added, empty. |
| v7 | current | The current document (with a landing page); the input of the next step. |

`v1-partial.json` and `v1-colors.json` cover the original partial semantic
settings and flat colour maps.

## Adding v8

1. Add `7: v7to8` to `THEME_UPGRADES`, written against `fixtures/v7.json`'s
   shape with its own literals.
2. Bump `STOREFRONT_THEME_DOCUMENT_VERSION` and the schema.
3. Add `fixtures/v8.json` (a current document). The fixture-count test fails
   until it exists. Earlier steps and fixtures do not change.
