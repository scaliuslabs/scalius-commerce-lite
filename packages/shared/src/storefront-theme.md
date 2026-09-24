# Storefront theme document (version 4)

One JSON document describes how the storefront looks: the template it is
based on, the tokens every block reads, one variant per block, and the
homepage sections. The dashboard Theme page writes it; the storefront renders
it; both resolve it against the store's shape with the same function.

Source of truth: `storefront-theme/*.ts`, re-exported by `storefront-theme.ts`
(import `@scalius/shared/storefront-theme`). The layout grammar and the
numbers come from the storefront study
(`audit/rewrite-2026-09-23/storefront-study/SYNTHESIS.md`).

| File | Holds |
|---|---|
| `contrast.ts` | the 19 colour keys, colour maths, the base AA pairs, header-tone surfaces |
| `tokens.ts` | token enums and specs (density, type scale, radius…), palettes, fonts, the token schema, token CSS |
| `fit.ts` | `StoreShape` (bounded store facts) and the fit conditions variants declare |
| `blocks.ts` | the block-variant registry and the blocks schema |
| `sections.ts` | the section registry (17 types, strict settings) |
| `document.ts` | the document schema, the document's contrast pairs, strict parsing, token CSS |
| `templates.ts` | the 10 templates as frozen data, `DEFAULT_STOREFRONT_THEME` |
| `resolve.ts` | `resolveStorefrontTheme(document, storeShape)` |

```jsonc
{
  "version": 4,                        // literal; a new shape means a new version
  "template": "department-mall",       // the template it is based on (a label)
  "tokens": {
    "colors": { "<19 keys>": "#rrggbb" },
    "typography", "typeScale", "headingCase", "density", "radius",
    "buttonShape", "surface", "imageRatio", "imageFit", "headerTone", "container"
  },
  "blocks": {                          // each block: { "variant", "settings" }
    "topBar", "header", "desktopNav", "mobileNav", "card",
    "listing": { "layout", "toolbar": [], "phoneLayout", "paging" },
    "product": { "gallery", "buyBox", "below": [], "sticky": { "phoneTop", "phoneBottom", "desktop" } },
    "footer"
  },
  "pages": { "home": [{ "id", "type", "version", "settings" }] }
}
```

## Rules

- **Strict.** Unknown keys, values outside the enums, settings that belong to
  another variant, and other versions are rejected. Writes (API) and reads
  (core, storefront) use the same schema. There is no tolerant or legacy
  reader: a stored document that fails the schema fails closed in the
  dashboard, and the storefront renders `DEFAULT_STOREFRONT_THEME` whole.
- **Tokens are global; blocks choose structure only.** A variant never
  carries its own radius, font size or colour, so any mix of variants stays
  coherent (mix rule 1). One card per store (rule 2).
- **Readable text per combination.** Every pair in
  `STOREFRONT_THEME_TEXT_PAIRS`, plus the `contrastPairs` of every chosen
  variant and of every variant it can fall back to, must reach WCAG AA
  (4.5:1). Header roles (`header-background`, `header-foreground`) follow
  `headerTone`: `dark` takes the darker of ink and page, `brand` the action
  colour. A write that breaks a pair is rejected.
- **Helper text is not an error.** `muted-foreground` is near-neutral (Lab
  chroma ≤ 25) and at least 40 ΔE away from `destructive`.
- **Fit.** A variant declares `requires` (conditions over the `StoreShape`)
  and a `fallback`. The resolver walks the fallback chain until a variant
  fits; every chain ends in a variant that always fits (tested). Toolbar
  pieces, product modules and sections without their data are left out.
  `resolved.fallbacks` says what changed and which conditions failed, so the
  dashboard can say why.
- **Store shape.** The API reads it with bounded counts (`LIMIT 1000`) in the
  storefront layout batch (no extra round trip) and serves it beside the
  theme (`storeShape` in the layout data and in the dashboard's theme read).
  Facts that do not exist yet (brands, key specs, EMI, digital lines,
  reviews, questions, content blocks) read as absent until their phase lands.
- **Sections.** Each `type` is an entry in `STOREFRONT_SECTION_REGISTRY` with
  its own `version` and strict settings. Sections are optional, repeatable
  and reorderable; ids are unique; at most 24.
- **Today's renderers.** Each variant and section also names the existing
  storefront renderer it maps to (`renders`) until the phase that builds its
  own. `resolved.layout` carries those facts (header, menus, card, grid,
  gallery, footer, top bar). Sections whose renderer has not landed render
  nothing, and the Theme page says so.
- **The default renders today's store.** `DEFAULT_STOREFRONT_THEME` is the
  Department mall template. It resolves to the version 3 Classic look
  exactly (tested against values captured from the v3 code), including the
  owner-protected product page (`gallery: classic`, `buyBox: classic`).

## Templates

| Id | Best for | Blocks (header / desktop menu / phone menu / card / listing / gallery / buy box / footer) | Tokens |
|---|---|---|---|
| `boutique` | one brand, 5–200 products | boutique-inline / dropdown / accordion-drawer / boutique / bar-drawer / stacked / boutique / minimal-columns | airy, display, square, flat, 1200 |
| `heritage-editorial` | fashion, sarees, crafts | fashion-department / mega-panel / accordion-drawer / portrait / shelves / portrait / fashion / newsletter-grey | airy, display, uppercase, portrait photos, 1360 |
| `fashion-value` | apparel, 200–5,000 SKUs | fashion-department / mega-panel / bottom-tabs / fashion-value / sidebar-grid / thumbs-below / fashion / newsletter-grey | compact, retail, uppercase, square, flat |
| `spec-catalogue` | electronics, 5k–50k SKUs | spec-two-row / sticky-category-bar / bottom-tabs / spec / sidebar-grid (list rows on phones) / thumbs-below / spec / support-dark | dense, flat type, subtle, dark header, contain, 1290 |
| `rounded-tech` | premium gadgets, 500–10k SKUs | tech-rounded / dropdown / bottom-tabs / tech-rounded / sidebar-grid / thumbs-below / tech / brand-black | comfortable, soft, pill, raised, dark header |
| `marketplace` | very large mixed catalogues | marketplace-search / drill-in-drawer / drill-in-drawer / marketplace / sidebar-grid / thumbs-below / marketplace-3col / directory | dense, flat type, brand header, full width |
| `mass-retail` | household, general goods | retail-pill / drill-in-drawer / drill-in-drawer / retail / bar-drawer (list rows on phones) / image-grid / retail / minimal-columns | comfortable, rounded, pill, brand header |
| `department-mall` | multi-category shops, 50–3,000 SKUs (the default) | mall-departments / dropdown / accordion-drawer / standard / sidebar-grid / classic / classic / product-widgets | compact, subtle, hairline cards, 1440 |
| `daily-essentials` | grocery, pharmacy, repeat buys | grocery-shell / departments-rail (always open) / accordion-drawer / quick-add / quick-grid / thumbs-below / classic / minimal-columns | compact, rounded, pill, contain, full width |
| `showcase-landing` | 1–20 hero products, launches | boutique-inline / dropdown / accordion-drawer / boutique / bar-drawer / stacked / boutique / minimal-columns | comfortable, display, rounded, pill, 1200 |

Where the data departs from SYNTHESIS.md, and why:

- **Department mall** keeps today's Classic tokens (radius buttons, hairline
  cards, a 1440px container, today's homepage order and product page)
  instead of the study's pill buttons, flat cards and Game Ghor order: it is
  the default, and today's store and product page must stay pixel-identical.
  For the same reason it uses the announcement top bar and the dropdown menu
  row (today's bar and row) instead of the study's utility bar and
  "All departments" rail; both stay available as `utility` and
  `departments-rail` for any other mix.
- **Card minimums** are grid minimums, not the measured card widths: an
  auto-fill grid stretches cards, and two cards must fit a 360px phone.
  `dense` shares compact's type scale (the 14px phone floor) and uses a 12px
  desktop gap so columns never drop when the page gutter grows at 1024px.
- **Containers** add `1440` (today's width) to the measured 1200/1290/1360/full.
- **`pages.landing`** is left out until a route renders it: the agent
  operation manifest inlines the whole document schema into every theme
  operation, so each page costs about 0.9 MB of generated source.

## Changing the contract

1. To add a section type or a block variant, add a registry entry (strict
   settings, defaults, `requires`, `fallback`, `contrastPairs`, `renders`)
   and a storefront renderer. The pairwise matrix test
   (`storefront-theme/matrix.test.ts`) covers the new variant with every
   other block, palette and density.
2. To change a section's settings, bump that entry's `version`.
3. For any other shape change, bump `STOREFRONT_THEME_DOCUMENT_VERSION` and
   add a migration that resets stored theme rows to the defaults (0082 is
   the version 4 reset). There is no backward compatibility.
4. Deploy order: a storefront that reads an older or newer document version
   renders its own default whole and logs a warning. The v4 default renders
   the v3 Classic look, and the reset migration puts every store on it, so
   `deploy:api` then `deploy:storefront` shows no visible change in between.

## Palettes: references and rationale

Templates choose a palette; merchants recolour it with four roles. Each
palette is anchored to two or three world-class references. Palettes are
small systems. They have one ink, one
restrained brand colour, neutrals tinted toward the palette's hue (never raw
grey on a warm page), surfaces, and semantic tones. All of them pass every AA
text pair and the helper-vs-error rule (tested). Card surfaces use either a
border or a shadow, never both on the same element.

| Palette | References | Rationale |
|---|---|---|
| `retail` | Shopify Horizon/Dawn, Allbirds | Warm white paper, charcoal ink and charcoal buttons; sand neutrals carry the warmth, and the merchant's brand colour is the only accent. |
| `marketplace` | Amazon, Daraz, Target | Density done cleanly: bright white, near-black ink, cool neutral panels, one saturated orange reserved for buying; compact bold grotesque. |
| `boutique` | COS, Aesop, Ssense | No colour at all: linen page, espresso ink, flat cards and square corners; an editorial serif over a neutral grotesque carries the hierarchy. |
| `fresh` | Instacart, Chaldal, Ocado | Clean white, a leaf green for buying, green-tinted panels for categories and delivery facts; friendly rounded sans and pill buttons for thumb use. |
| `beauty` | Glossier, Sephora | Black type and black pill buttons on white, a blush accent used only on surfaces; a soft display serif over a geometric sans. |
| `heritage` | Aarong, Fabindia, Anthropologie | Hand-made paper, umber ink and madder terracotta; a crafted Garamond with a Bengali serif, generous leading and a narrower measure. |
| `midnight` | Apple, Nothing, Linear | Layered near-blacks (page, card, panel), white ink and white pill buttons; a precise grotesque with tight tracking; soft shadows instead of borders. |

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
- **Images:** one aspect per store (`imageRatio`). A subtle 1.03 zoom on
  hover, or the second photo where the card shows one.
- **Buttons:** square, the theme radius or pill (`buttonShape`), and a
  pressed state that scales to 0.98.
- **Surfaces:** flat, hairline or raised (`surface`), never both a border and
  a shadow.
- **Skeletons:** loading states mirror the final layout (the same aspect
  ratios and rows).

