# Stored theme upgrades

`upgradeThemeDocument(document)` clones its input, applies one step per version (`THEME_UPGRADES` in `upgrade.ts`), then validates the result against the current strict schema. This file is for contributors who change the document shape.

Stored live, draft and version reads use it through `parseStoredStorefrontThemeDocument`, and so does the storefront's `readStorefrontTheme`. Writes accept only the current version. A read never writes back and never replaces a merchant's document with the default theme. An invalid document reads as `null`: the dashboard fails closed and the storefront renders the default theme for that request.

## Purity

- Every step is a pure structural conversion. It uses only literals frozen with the version it reads (variant names, choice maps, historical defaults), never today's block or section registries.
- Today's registry defaults enter once, after the last step (`withCurrentDefaults`). Settings an upgraded document never stored take today's defaults, and stored values win. A document that is already current is returned as a copy, unchanged.
- A variant or section type that today's registries no longer know stays as stored, so the strict parse rejects it. The upgrade never guesses.

## Versions and golden fixtures

`fixtures/v<N>.json` holds one stored document per version, captured from the code of that version. The primary colour `#123456` and the Bangla and English `merchant-story` copy are the markers that `upgrade.test.ts` follows through every step. `v1-partial.json` and `v1-colors.json` cover the original partial semantic settings and flat colour maps.

A reset migration deleted every stored theme row not at the version it introduced (with its drafts, versions and preview sessions). From v7 on, a version bump needs no reset migration, because reads upgrade in memory.

| Input | Reset migration | Conversion to the next version |
| --- | --- | --- |
| v1 | `0075_theme_layout_reset` | Pre-v2 settings had no version property. An explicit `version: 1` and the unversioned shape both read. CSS colours become opaque hex (alpha flattens over the old white page). The fixed homepage order becomes sections. |
| v2 | `0078_theme_document_v2` | Independent heading and body fonts map to the pairing with the same faces: editorial plus humanist is `heritage`, editorial plus another body is `editorial`, a humanist body is `fresh`, everything else is `retail`. |
| v3 | `0081_theme_document_v3` | Layout choices become block variants of the `department-mall` template. The category, delivery and rich-text sections are renamed with their ids, order and copy. |
| v4 | `0082_theme_document_v4` | The shared navigation and the listing filters become explicit. Sidebar and bar layouts become the grid arrangement. |
| v5 | `0093_theme_document_v5` | Template-only page chrome becomes stored listing settings. The brand and the home mode are added. Options that never rendered are removed: the questions module, retired sticky modes, deal end times, sub-brand rows and trending queries. |
| v6 | `0106_theme_document_v6` | Landing pages (`pages.landing`) are added, empty. |
| v7 | none | Page templates (`pages.templates`) are added, empty, with the fixed part first. |
| v8 | none | The current document. It is the input of the next step. |

## Adding v9

1. Add `8: v8to9` to `THEME_UPGRADES`, written against the shape in `v8.json` with its own literals.
2. Bump `STOREFRONT_THEME_DOCUMENT_VERSION` and the schema.
3. Create the v9 golden fixture (a current document) next to the v8 one and add it to `goldenFixtures` in `upgrade.test.ts`. The fixture-count test fails until you do. Earlier steps and fixtures do not change.
