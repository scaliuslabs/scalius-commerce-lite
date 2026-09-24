# Storefront theme document (version 2)

One JSON document describes how the storefront looks. The dashboard Theme page
writes it in `configured` mode; a future builder writes it in `custom` mode.
The storefront renders from the same document in both modes.

Source of truth: `storefront-theme.ts` (`storefrontThemeDocumentSchema`).
`storefrontThemeDocumentJsonSchema()` exports the structure as JSON Schema; the
contrast and section rules below live in the Zod schema only.

```jsonc
{
  "version": 2,                        // literal; a new shape means a new version
  "mode": "configured" | "custom",
  "tokens": {
    "colors": { "<19 keys>": "#rrggbb" }, // every key, lowercase hex
    "typography": { "heading", "body" },
    "radius", "containerWidth",
    "components": { "buttons", "inputs", "cards" }
  },
  "layout": { "header", "footer", "card", "density", "productPage" },
  "sections": [{ "id", "type", "version", "settings" }]
}
```

## Rules

- **Strict.** Unknown keys, values outside the enums and other versions are
  rejected. Writes (API) and reads (core, storefront) use the same schema.
  There is no tolerant or legacy reader: a stored document that fails the
  schema fails closed in the dashboard. The storefront then renders
  `DEFAULT_STOREFRONT_THEME` whole, never a mix.
- **Readable text.** Every pair in `STOREFRONT_THEME_TEXT_PAIRS` must reach
  WCAG AA (4.5:1). A write that breaks this is rejected.
- **Helper text is not an error.** `muted-foreground` is near-neutral (Lab
  chroma ≤ 25) and at least 40 ΔE away from `destructive`, so a brand accent
  never makes a correct form look full of errors.
- **Layout.** There are five independent choices, each a small curated set
  that works with every other choice and every preset.
  `resolveStorefrontThemeLayout` maps them to rendering facts: photo ratio,
  hover photo, buy-now, badge placement, gallery and thumbnails.
- **Fluid.** Nothing is a fixed column count. Grids auto-fill cards of at
  least `cardMin`, which steps up with the grid's container width. Density
  (`compact` | `comfortable`) sets that minimum, the gaps and the fluid
  type/spacing scale. Content width is capped (`containerWidth`) for
  ultra-wide screens.
- **Sections.** Each `type` is an entry in `STOREFRONT_SECTION_REGISTRY` with
  its own `version` and settings schema.
  - `editor: "theme"` sections (hero, collections, categories, delivery) are
    the homepage blocks the Theme page reorders. A `configured` document has
    each exactly once. A `custom` document has each at most once.
  - `editor: "builder"` sections, such as `rich_text`, are created and edited
    only by the builder. The Theme page lists them as "Custom section (edit
    in builder)" and keeps them in place.
  - Ids are unique. There are at most 24 sections.
- **Custom mode.** The Theme page shows "This store uses a custom design"
  and hides the configured options. Only the builder edits the document.

## Changing the contract

1. To add a section type, add a registry entry (a versioned schema) and a
   storefront renderer.
2. To change a section's settings, bump that entry's `version`.
3. For any other shape change, bump `STOREFRONT_THEME_DOCUMENT_VERSION` and
   add a migration that resets stored theme rows to the defaults. There is
   no backward compatibility.
