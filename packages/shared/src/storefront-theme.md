# Storefront theme document (version 3)

One JSON document describes how the storefront looks. The dashboard Theme page
writes it in `configured` mode; a future builder writes it in `custom` mode.
The storefront renders from the same document in both modes.

Source of truth: `storefront-theme.ts` (`storefrontThemeDocumentSchema`).
`storefrontThemeDocumentJsonSchema()` exports the structure as JSON Schema; the
contrast and section rules below live in the Zod schema only.

```jsonc
{
  "version": 3,                        // literal; a new shape means a new version
  "mode": "configured" | "custom",
  "tokens": {
    "colors": { "<19 keys>": "#rrggbb" }, // every key, lowercase hex
    "typography": "<pairing>",          // curated heading/body pairing
    "radius", "buttonShape", "containerWidth",
    "components": { "buttons", "inputs", "cards" }
  },
  "layout": { "header", "footer", "card", "density", "productPage",
              "navigation", "mobileNavigation" },
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
- **Navigation.** `navigation` is how the header menu (Online store →
  Navigation) is browsed on computers: `menu` (dropdowns), `mega` (full-width
  panels with category photos), `pills` (a scrolling category row) or
  `sidebar` (a category column beside the content). `mobileNavigation` is
  `drawer` (accordion side sheet) or `tabs` (a bottom tab bar). Both are
  server-rendered disclosure patterns with no layout shift.
- **Layout.** There are seven independent choices, each a small curated set
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

## Style presets: references and rationale

Every preset is a complete configured document anchored to two or three
world-class references. Palettes are small systems. They have one ink, one
restrained brand colour, neutrals tinted toward the palette's hue (never raw
grey on a warm page), surfaces, and semantic tones. All of them pass every AA
text pair and the helper-vs-error rule (tested). Card surfaces use either a
border or a shadow, never both on the same element.

| Style | References | Rationale |
|---|---|---|
| Classic retail (`retail`) | Shopify Horizon/Dawn, Allbirds | Warm white paper, charcoal ink and charcoal buttons; sand neutrals carry the warmth, and the merchant's brand colour is the only accent. |
| Bold marketplace (`marketplace`) | Amazon, Daraz, Target | Density done cleanly: bright white, near-black ink, cool neutral panels, one saturated orange reserved for buying; compact bold grotesque. |
| Minimal boutique (`boutique`) | COS, Aesop, Ssense | No colour at all: linen page, espresso ink, flat cards and square corners; an editorial serif over a neutral grotesque carries the hierarchy. |
| Daily needs (`daily`, palette `fresh`) | Instacart, Chaldal, Ocado | Clean white, a leaf green for buying, green-tinted panels for categories and delivery facts; friendly rounded sans and pill buttons for thumb use. |
| Beauty (`beauty`) | Glossier, Sephora | Black type and black pill buttons on white, a blush accent used only on surfaces; a soft display serif over a geometric sans. |
| Heritage (`heritage`) | Aarong, Fabindia, Anthropologie | Hand-made paper, umber ink and madder terracotta; a crafted Garamond with a Bengali serif, generous leading and a narrower measure. |
| Midnight (`midnight`) | Apple, Nothing, Linear | Layered near-blacks (page, card, panel), white ink and white pill buttons; a precise grotesque with tight tracking; soft shadows instead of borders. |

### Palette tokens

| Token | retail | marketplace | boutique | fresh | beauty | heritage | midnight |
|---|---|---|---|---|---|---|---|
| background | #fbfaf7 | #ffffff | #f6f4ef | #ffffff | #ffffff | #faf6ef | #0a0a0b |
| foreground (ink) | #1d1c1a | #0f1111 | #242220 | #15231b | #1a1718 | #2a2018 | #f4f4f5 |
| card | #ffffff | #ffffff | #f6f4ef | #ffffff | #ffffff | #fffdf8 | #141416 |
| primary (actions) | #1d1c1a | #c2410c | #242220 | #0b7a3e | #1a1718 | #8a3b1e | #f4f4f5 |
| muted surface | #f1eee8 | #f2f4f5 | #ebe7df | #f1f6f1 | #fbf4f3 | #f2eadd | #1c1c1f |
| muted text (helper) | #5d5850 | #565959 | #5a554d | #4b5a51 | #625a5b | #665646 | #a8a8b0 |
| accent surface | #e9e3d8 | #fff1e6 | #e3ddd2 | #e3f4e6 | #f8e1e1 | #ecdfc9 | #232327 |
| border | #e5e0d6 | #e3e6e6 | #d9d3c7 | #dde8de | #f0e2e1 | #e2d5bf | #27272b |
| destructive (error) | #b42318 | #b12704 | #9b1c1c | #c0262d | #b4232c | #a3191b | #f87171 |

### Typography pairings

Families are Google Fonts, self-hosted by the storefront (`STOREFRONT_FONTS`).
Each Latin face carries a Latin `unicode-range`, so Bangla text falls through to
the pairing's Bengali family (Noto Sans or Noto Serif Bengali). Swap uses
metric-matched fallback faces (`<Family> Fallback`, with size-adjust and
ascent/descent overrides), so it never shifts layout. Only the heading face's
Latin subset is preloaded.

| Pairing | Heading | Body | Bangla | Heading weight / tracking / leading | Body leading | Labels (uppercase) |
|---|---|---|---|---|---|---|
| retail | Inter | Inter | Noto Sans Bengali | 650 / −0.02em / 1.15 | 1.6 | 0.06em |
| market | Inter | Inter | Hind Siliguri | 700 / −0.01em / 1.2 | 1.5 | 0.04em |
| editorial | Instrument Serif | Inter | Noto Serif Bengali | 400 / −0.01em / 1.08 | 1.65 | 0.14em |
| fresh | Nunito Sans | Nunito Sans | Hind Siliguri | 800 / −0.015em / 1.15 | 1.55 | 0.05em |
| beauty | DM Serif Display | DM Sans | Noto Sans Bengali | 400 / −0.005em / 1.1 | 1.6 | 0.1em |
| heritage | Cormorant Garamond | Inter | Noto Serif Bengali | 600 / 0 / 1.1 | 1.7 | 0.12em |
| tech | Inter | Inter | Noto Sans Bengali | 600 / −0.03em / 1.1 | 1.6 | 0.08em |

### Craft

- **Motion:** 150–200ms ease-out for hover, press and reveal, and none under
  `prefers-reduced-motion`.
- **Images:** a fixed aspect per card style. A subtle 1.03 zoom on hover, or
  the second photo for portrait cards.
- **Buttons:** radius or pill per Style, and a pressed state that scales to
  0.98.
- **Surfaces:** bordered, elevated or flat, never both a border and a shadow.
- **Skeletons:** loading states mirror the final layout (the same aspect
  ratios and rows).

