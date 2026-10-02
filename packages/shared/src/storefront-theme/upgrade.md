# Stored theme upgrades

`upgradeThemeDocument(document)` clones its input, applies one conversion for
each version, and validates the result as the current strict document. Stored
live, draft and version reads use it through `parseStoredStorefrontThemeDocument`.
Saving or publishing accepts only the current schema; reading never writes or
replaces a merchant document with the default theme.

The golden inputs in `fixtures/` were captured from these historical sources:

| Input | Historical source | Conversion |
| --- | --- | --- |
| v1 | `519d88ef9^` | Pre-v2 semantic settings were actually unversioned; explicit `version: 1` and that unversioned shape are both accepted. CSS colours become equivalent opaque hex values, and fixed homepage ordering becomes sections. |
| v2 | `519d88ef9` | Separate curated font choices map to the later type pairings; navigation and button shape become explicit. Editorial + humanist maps to heritage; editorial + system maps to editorial; humanist body maps to fresh; system/modern sans choices map to retail. |
| v3 | `216fc3f55` | Layout choices become block variants; category, delivery and rich-text sections are renamed without changing their IDs, order or copy. |
| v4 | `92890ce73` | Shared navigation and listing filters become explicit; sidebar/bar layouts become the grid arrangement. |
| v5 | `727a1081d` | Former template-specific page chrome becomes stored block settings. Brand/home mode and newly required section settings are added. Options that never rendered (questions, retired sticky modes, arbitrary deal end times) are removed. |
| v6 | `11d0d2788` | Landing pages and fixed product/collection/search block lists are added; merchant tokens, brand and sections stay exact. |

The v1/v2 font models cannot represent arbitrary independent fonts in the
current curated pairing model; the mapping above preserves their intended
sans/serif character. Historical alpha colours flatten onto the old white
page. Documents still must satisfy current contrast and safe-content checks;
malformed values and unknown future versions fail closed.

`v1-partial.json` and `v1-colors.json` cover the original partial semantic
settings and flat colour maps. Missing fields receive the defaults from the
pre-v2 source; supplied choices and valid colour references remain intact.

A future v8 adds `7: v7to8` to `THEME_UPGRADES`, updates the current schema/version,
and adds the v7 fixture. Existing conversions stay independent of that step.

`pages.landing` holds at most 20 non-reserved slugs, each at most 24 sections.
Landing pages use `/pages/<slug>`; `overrideCms` opts a same-slug CMS body into
the sections. Product and listing templates retain every fixed block exactly
once, including hidden blocks, so showing one keeps its position. Grid density
continues to use `tokens.density`, and the existing fit/data guards still apply.
