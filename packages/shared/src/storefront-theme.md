# Storefront theme document (version 7)

One JSON document describes how the storefront looks: the template it is
based on (a label), the tokens every block reads, the brand (logo, footer
logo, tab icon), one variant per block with its settings (the announcement's
words, the footer's words), the homepage sections with their own content
(hero slides, the category tiles' and collections' picks) and what `/`
shows. It is the one draft for the look: the dashboard (the Theme page and
its theme editor) saves every visual and merchandising choice into it,
previews it,
publishes it atomically and restores it from theme versions (and a builder,
an agent or a plugin section can write it); the storefront renders it; both
resolve it against the store's shape with the same function. Store identity
(name, phone, email, address, social profiles) is not here: Settings ->
Store (the business document) owns it, and every buyer surface reads it
from there only.

Source of truth: `storefront-theme/*.ts`, re-exported by `storefront-theme.ts`
(import `@scalius/shared/storefront-theme`). The layout grammar and the
numbers come from the storefront study
(`audit/rewrite-2026-09-23/storefront-study/SYNTHESIS.md`).

| File | Holds |
|---|---|
| `brand.ts` | the brand (logo, logo width, footer logo, tab icon as media ids) and the resolved brand images the layout and a preview carry |
| `links.ts` | the link rule theme content uses (navigation-safe hrefs in canonical form) |
| `content.ts` | the merchant's content inside the document (`storefrontThemeWithContent`, `storefrontThemeLook`) and every image it names with its path (`storefrontThemeMediaReferences`) |
| `contrast.ts` | the 19 colour keys, colour maths, the base AA pairs, header-tone surfaces and the bands derived from them |
| `tokens.ts` | token enums and specs (density, type scale, radius…), palettes, fonts, the token schema, token CSS (with the rating colour and the header bands) |
| `fit.ts` | `StoreShape` (bounded store facts), the navigation facts, and the fit conditions variants declare |
| `blocks.ts` | the block-variant registry, card looks, listing filter styles and page chrome, product modules and sticky bars, the navigation schema and the blocks schema |
| `sections.ts` | the section registry (20 types, strict settings) and the types the storefront renders |
| `home-data.ts` | what homepage sections read (product lists by source, images), shared by the API and the storefront |
| `document.ts` | the current document schema, contrast pairs, stored-read upgrades and token CSS |
| `pages.ts` | landing pages: bounded section pages at `/pages/<slug>` |
| `upgrade.ts` | one pure step per historical version; golden inputs and provenance in `upgrade.md` |
| `templates.ts` | the 10 templates as frozen data, `DEFAULT_STOREFRONT_THEME` |
| `resolve.ts` | `resolveStorefrontTheme(document, storeShape)` |
| `fidelity-contract.test.ts` | the slice 0 contract matrix: template x card x filter style x navigation source on empty, tiny, live-small, 30k-seed and huge stores |

```jsonc
{
  "version": 7,                        // literal; a new shape means a new version
  "template": "department-mall",       // the template it is based on: a label, never read for behaviour
  "tokens": {
    "colors": { "<19 keys>": "#rrggbb" },
    "typography", "typeScale", "headingCase", "density", "radius",
    "buttonShape", "surface", "imageRatio", "imageFit", "headerTone", "container"
  },
  "brand": { "logo", "logoWidth", "footerLogo", "favicon" },  // media ids (null: none), width 80-240 step 10
  "blocks": {                          // each block: { "variant", "settings" }
    "topBar",                          // none (off) | announcement | utility | app-banner: { text, link }
    "header",
    "navigation": { "source", "maxTopItems", "linkBudget" },   // shared by every header surface
    "desktopNav", "mobileNav", "card",
    "listing": {
      "layout",                        // grid | list | shelves { maxShelves, spacing } | quick-grid
      "searchLayout", "descriptionPlacement",
      "filters": { "style", "openByDefault", "order"?, "column"?, "rowPitch"?, "label"?, "searchPlacement", "ruled" },
      "toolbar": [], "phoneLayout", "paging",
      "surface", "gutter", "band", "phoneBar", "links", "phoneBanner", "maxColumns"
    },
    "product": { "gallery", "buyBox", "below": [], "sticky": { "phoneTop", "phoneBottom", "desktop" } },
    "footer"                           // every variant: { tagline, about, copyright } (+ directory's style)
  },
  "pages": {
    "home": [{ "id", "type", "version", "settings", "hidden"? }],
    "homeMode": { "kind": "sections" }, // or { "kind": "product", "productId" }
    "landing": { "<slug>": { "title", "description", "sections": [] } }
  }
}
```

## Rules

- **One draft for the look.** Every visual and merchandising choice is in
  the document: the brand images and logo width, the announcement bar (its
  `topBar` variant is the only switch, `none` is off; `announcement`,
  `utility` and `app-banner` carry `{ text, link }`), the footer's words
  (`tagline`, plain-text `about` with blank lines between paragraphs, and
  `copyright`, the name after "©", empty: the store name; the line always
  renders), the hero's slides, the category tiles' categories and title,
  the collections section's collections, every other section and what `/`
  shows. A dashboard Save writes the draft only; preview renders the draft;
  publish makes all of it live at once; a theme version restores all of it.
  Header and footer menus stay navigation menus (their own publish); the
  theme chooses only where links come from (`blocks.navigation`).
- **Brand.** `brand.logo`, `brand.footerLogo` and `brand.favicon` are media
  ids (`null`: the store name in text, or the platform tab icon);
  `brand.logoWidth` is the header logo's computer width (80-240px in steps
  of 10, phones cap it at 160). The layout read resolves the published
  theme's images in its one batch, through the stored theme row
  (`layout.brand`: `{ logo, footerLogo, favicon }`, each a ready or trashed
  image or `null`), declaring `m:<id>` for each id the row names (or
  `m:none`, which never advances, when it names none: the read matched no
  row and `theme` covers that). A preview resolves its draft's own
  (`theme-preview/resolve` returns `brand`). Emails use the published logo's
  original upload. Store identity is never brand: the store name, phone,
  email, address and social profiles come from the business document only.
- **Saves check what the document names.** A draft save rejects a media id
  that is not a ready or trashed image in Files, and a product home mode
  whose product is gone or in trash, each against its document path
  (`brand.logo`, `pages.home.2.settings.slides.0.image`,
  `pages.homeMode.productId`); links are canonical navigation-safe hrefs
  (a same-store path, `?query`, `#fragment` or an https URL; the schema
  refuses anything else). The published theme and the draft are places in
  a file's "Used in" (`theme`), so Files refuses to delete an image either
  still shows.
- **Content survives a template.** Choosing a template copies its look and
  keeps the merchant's content (`storefrontThemeWithContent`: brand, home
  mode, announcement and footer words where the new variants carry them,
  each hero's slides and side banners, the category tiles' and collections'
  picks, given to the first section of the same type, then the second...);
  "matches a template" compares looks only (`storefrontThemeLook`).
  Switching a block's variant (and the resolver's fit fallbacks) keeps the
  settings both variants declare (`storefrontBlockSwitch`).
- **What `/` shows.** `pages.homeMode` is `sections`, or `product` with a
  `productId`: while that product is public (the homepage read returns it
  as `sections.homeProduct`), `/` answers 302 to its own page
  (`/products/<slug>`), which keeps its canonical URL and SEO; the product
  route never redirects back, so there is no loop, and a product that stops
  being public leaves `/` on the sections. A preview follows the draft's
  mode.

- **The theme editor.** Online store → Theme → Customize
  (`/admin/online-store/theme/editor`) edits the homepage sections (drag or
  keyboard reorder, add, duplicate, remove with undo), each section's
  settings and the brand, colours, fonts, header, menus and footer, over the
  real storefront in a frame. Settings forms are generated from the
  registry's zod schemas (dashboard `online-store/schema-form/`), so a new
  setting needs a label in `i18n/theme-settings.ts` and no form code. Edits
  autosave the draft against its revision. The frame is a normal preview
  session redeemed by `/theme-preview/embed` (the code arrives by
  postMessage; the cookie is `SameSite=None; Partitioned`). Only a page
  that rendered a valid preview carries the editor's section marks
  (`data-theme-section-id`), the inline bridge
  (`apps/storefront/src/lib/theme-preview-bridge.ts`) and a frame-ancestors
  that names the dashboard origin; both sides check the other's exact
  origin (Platform settings) and window (`@scalius/shared/theme-editor-bridge`).
  A settings change re-renders its section from the private, never-stored
  `/theme-preview/section?id=` (the homepage's own renderers); anything
  that moves the page reloads it. A buyer's homepage is byte-identical with
  or without the editor (`theme-editor-preview.render.test.ts`).
- **The template is a label.** `template` says what the theme is based on
  (the dashboard's "based on" line and its reset-to-template defaults). No
  storefront component and not the resolver read it for behaviour: every
  behaviour a reference needs is a block variant, a setting or a token that
  the template's data states, so blocks from any template (or a builder, an
  agent, a plugin section) mix freely and render truthfully. A test fails if
  a component branches on the template
  (`apps/storefront/src/lib/theme-contract-consumers.test.ts`).
- **Every choice does something.** Every enum value of every block setting,
  the listing's and product page's choices, each toolbar piece, product
  module and section setting has a consumer (a renderer, or the variant's
  `renders` mapping), tested by the same file. An option with nothing to
  render it is removed, not shipped (questions wait for a question model).
- **Strict writes, upgraded reads.** Writes accept only the current version,
  known keys and valid registry settings. Stored reads use the pure step-wise
  `upgradeThemeDocument` before the same validation; older merchant documents
  are upgraded in memory without writes or resets. Invalid or unknown future
  documents fail closed. Golden fixtures and historical mappings are documented
  in [upgrade.md](storefront-theme/upgrade.md).
- **Tokens are global; blocks choose structure.** A variant never carries
  its own colour, so any mix of variants stays coherent (mix rule 1). One
  card per store (rule 2). **Cards are the exception for shape and type:**
  every card but `standard` owns its measured look (`STOREFRONT_CARD_LOOKS`:
  photo ratio and fit, radius in px, surface, title and price size per
  viewport and weight). A template's radius, surface and photo tokens never
  flatten it; `standard` follows them (and the theme's type scale), so
  today's card stays pixel-identical. Density still owns the grid (card
  minimum, gaps) and the card's padding.
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
- **Store shape.** The API reads it in one bounded statement in the
  storefront layout batch (no extra round trip; `@scalius/core`
  `storefront/store-shape.ts`) and serves it beside the theme (`storeShape`
  in the layout data and in the dashboard's theme read). It counts what a
  buyer can reach: `topCategoryCount` = published roots with a public
  product in their published subtree; `categoryDepth` = 1 + the deepest
  `category_closure` level where a category whose every ancestor is
  published holds a public product; `categoryGroups` = the most
  second-level categories with two or more published children under one
  root; `brandCount` = published brands with a public product;
  `hasKeySpecs` = a live `key_spec` attribute has a value on a public
  product; `hasReviews` = reviews are on and one is published;
  `hasDigitalLines` = a live digital SKU of an active product;
  `hasEmiPlans` = the `emi` settings document is on with a plan;
  `hasContentBlocks` = a public product has a block the product page
  renders (`STOREFRONT_RENDERED_CONTENT_BLOCK_TYPES`, outside the
  description tabs). "Public product" is `product_buyer_state.is_public`.
  Every fact is computed (a core test fails if a `requires` names a fact
  the statement does not produce); its cache keys are precise: `lm:shape`,
  `lm:all`, the "any row" keys, `set:emi:document` and
  `t:product_content_blocks` (block edits are rare merchant writes). On the
  30k catalogue seed it reads 25 roots, 4 levels, 300 brands and key specs
  (`store-shape.scale.test.ts`, opt-in).
- **Navigation.** `blocks.navigation` is shared by every header surface:
  `source` is `menu`, `category-tree` (published roots with public products
  and their published descendants, 4 levels at most) or `tree+menu` (the
  roots in tree order, then the menu's other top items; an item whose target
  is already present merges into it, keeping the first position and the
  menu's label). `maxTopItems` (1-18) caps the top entries of a row, rail or
  drawer root (the rest go behind "More" or "All categories"); `linkBudget`
  (20-150) caps the anchors of all header surfaces together, clones
  included. A tree source on a store without a public root renders the
  menu, and a menu source without a menu renders the tree
  (`resolved.blocks.navigation`, with a `navigation` fallback). Menu
  patterns fit against `navTopItems`, `navDepth` and `navGroups` in
  `resolved.facts`: the source that renders, capped by `maxTopItems`.
- **Listing filters.** `blocks.listing.filters.style` places the facets:
  `sidebar-dense` (Amazon, Daraz, Star Tech: 240px column, 22px rows, 14px
  labels), `sidebar-comfortable` (Apple Gadgets, Fabrilife, Game Ghor:
  270px, 28px, 16px), `bar-dropdowns` (Dawn, Aarong: up to 4 facet
  dropdowns in a bar, the rest in a drawer) or `drawer` (Target, Chaldal).
  `openByDefault` opens the facet groups (never for `bar-dropdowns`).
  A template may set its reference's own numbers over the style's:
  `column` (180-340px), `rowPitch` (16-36px) and `label` (12-18px);
  `resolved.blocks.listing.filters.spec` carries the result
  (`storefrontListingFilterSpec`). Marketplace is Amazon's 262/22/14,
  spec-catalogue Star Tech's 225/32/14 and rounded-tech Apple Gadgets'
  316/28/16. Other templates use a Filter button and a 288px phone sheet;
  Marketplace uses persistent filter chips and a full-width split sheet.
  `order` reorders whole groups (unset keeps the style's reference
  arrangement, including the dense column's price after the first two
  specs); Star Tech and Apple Gadgets state price first.
  `searchPlacement: drawer` (Star Tech) moves a sidebar's facets into the
  drawer on search, so the results take the width (up to five columns);
  `ruled` (Fabrilife) draws a sidebar's groups as one flat, ruled list that
  scrolls on its own. The small-catalogue
  rule is `storefrontListingFiltersShown`: filters need 8 results and a
  facet with two values, unless the buyer already refined; a store with
  fewer than 8 products resolves `shown: false`. The listing `layout` is
  the result arrangement only: `grid`, `list`, `shelves` (`spacing: airy`
  is Aarong's track), `quick-grid`.
- **Listing chrome.** What the references do around the results is data:
  `surface` (`page`, Dawn's page colour behind the grid, or `muted`),
  `gutter` (`inset` or Aarong's `flush`), `band` (`standard`, Dawn's
  `inline` title band over a facet bar, Star Tech's `beside-filters` band
  in the results column), `phoneBar` (`standard`, Target's `pill-row`,
  Amazon's `split-sheet`, Fabrilife's `bottom`), `links` (`chips`, or the
  showcase `tabs` strip that starts with "All"), `phoneBanner` (the
  category banner on phones too; Apple Gadgets shows it on computers only)
  and `maxColumns` (3-6 or null; Target's four roomy columns). A band that
  needs a placement (`inline` the bar, `beside-filters` a sidebar) renders
  `standard` elsewhere. The toolbar's `applied-chips` piece shows the
  buyer's refinements as removable chips; without it the filter form still
  undoes each one.
- **Product page.** `below` lists the modules in page order, each rendered
  only when this product has its data, all from reads the page already
  makes: `frequently-bought-together` (the recommendations when they are
  mostly real co-purchases; the co-bought products rank first, so it shows
  the first half, two at most, with this item and a total for fixed
  prices), `compare-similar` (recommended products of the same category in
  the store's card, and a link into `/compare` with this one),
  `policies` (the published policy pages in the layout data),
  `recently-viewed` (this browser's own list, filled before paint, nothing
  without JavaScript). `sticky`: `phoneTop: anchor-bar` (Amazon's Top,
  Details, Explore, Reviews bar), `phoneBottom: buy-bar`, `desktop:
  anchor-bar` (Star Tech) or `product-bar` (Target: name, price and Add to
  cart under the header once the buy buttons scroll away). Stacked and
  image-grid galleries keep their details column sticky by layout.
- **Sections.** Each `type` is an entry in `STOREFRONT_SECTION_REGISTRY` with
  its own `version` and strict settings. Sections are optional, repeatable
  and reorderable; ids are unique; at most 24.
- **Today's renderers.** Each block variant also names the existing
  storefront renderer it maps to (`renders`) until the phase that builds its
  own. `resolved.layout` carries those facts (header, menus, card, grid,
  gallery, footer, top bar).
- **Section renderers and data.** `STOREFRONT_SECTION_RENDERERS` lists the
  section types the storefront renders (one component each under
  `apps/storefront/src/components/homepage/`); every registered type has
  one. `newsletter` is the signup form (phone always, the e-mail optional,
  required or hidden, an optional WhatsApp box, the consent line in the
  store's language); it posts to the storefront's `/api/newsletter/subscribe`
  and works without JavaScript (`apps/storefront/src/lib/newsletter-server.ts`).
  It reads no data, so it always renders; `boutique` ends its homepage with
  it and `fashion-value` closes with it as Fabrilife's band. The
  `newsletter-grey` footer carries the same form (left out on a homepage
  that already shows the section). `home-data.ts` derives what the page reads
  (`homeSectionRequests(home, homeMode)`: one product list per source at the
  largest limit any section asks, capped at 8 lists of 36; at most 40
  images, hero slides and their phone images included; the category tiles'
  categories, at most 24; the collections sections' collections, at most
  8; the brand wall's brands; the deal promotions; and a product homepage's
  product). The API reads exactly those in the homepage's two batches
  (`sections`: `lists`, `media`, `brands`, `promotions`, `categories`,
  `collections`, `homeProduct`): for the published theme in the homepage
  batch part (a fixed read that rejects any query string), and for the
  saved draft a preview follows on the token-verified
  `POST /storefront/theme-preview/homepage` (private, never cached), so
  slides, tiles, collections and the home mode all preview. Callers never
  name reads. The storefront looks each section's data up by the same
  keys. A section without data renders nothing (no placeholder): a hero
  without a slide whose image resolves, category tiles with fewer public
  categories than their style needs (`storefrontCategoryTilesMinimum`).
  A collections section without a collection that has products shows the
  newest products. The `usp-strip` section's presence is its switch (the
  storefront reads shipping and checkout facts only when a section shows
  them, `homeSectionsShowDeliveryFacts`). Consecutive `banner` sections with
  the same `two-up` or `four-up` layout share one row. The hero's optional
  `sideBanners` show only with `contained-banners`.
- **Hero slides.** Each slide is a computer image and an optional phone
  image (`phoneImage`; phones use the computer image without one), each
  with a focal point (`phoneFocalPoint` falls back to `focalPoint`), the alt
  text (what the image shows, never drawn over it), optional words over it
  (`heading`, `text`) and a link (`null`: not a link; the button shows only
  with a link). At most 10.
- **Colours.** Every colour a block paints is a theme token: the footer
  tones re-point the footer's surface tokens to an AA pair (the header
  tone, ink on page, ink on muted); Amazon's banded directory footer uses
  the header tone with two bands derived from it (`theme-header-raised`,
  at most 14% toward the header's text and never below AA, and
  `theme-header-deep`, away from the text, so never less readable); stars
  and review bars use `theme-rating` (the references' shared amber; a
  rating always carries its number in text); scrollbars use the neutrals.
- **Cards.** A card id's `renders` is its measured anatomy as data: body
  order (title, price, facts), price colour role (`sale-always` is Star
  Tech's red price), discount wording, placement (`both`: Fabrilife's photo
  tag and the percentage after the price) and shape (pill, tag, flag, text,
  chip, Amazon's `deal` box), the struck price (after, before, Target's
  `reg`, Amazon's `List:`), stars or a score for ratings, the buy action
  (Amazon's `compact` pill) and its `look` (title emphasis and lines derive
  from it; Star Tech, Fabrilife and Chaldal are white hairline tiles, flat
  looks sit on the page). Any two cards differ in at least three of these
  treatments on a product with every fact (render test), and the fidelity
  harness measures the same on the seeded store's richest product.
  `resolved.layout.productCard.look` is always concrete. Facts (brand, key specs, rating, sold, pack size, delivery, EMI,
  swatches, options) render only when their data exists, so there are no zero states; sold counts
  show from 10. The data is each listing and homepage product's `cardFacts`
  (core `catalog/card-facts.ts`): one bounded statement batched with the card
  media, so no page gains a D1 round trip. Swatch colours come only from a
  swatch attribute value of the same name or an exact CSS colour name. Ten
  cards: `detailed` is Amazon's (swatches, three-line title, "Options: 4
  sizes", "bought in past month", a superscript price, the delivery line);
  only `spec` has `compare` (Star Tech's "Add to Compare" and the floating
  tray to `/compare`). Cards never show one of our originals served without
  renditions (the placeholder shows while the render job runs), and the
  hover photo is fetched on intent, decoded, then faded. `standard` is today's card, unchanged. The storefront renders
  `standard` from its own file and every other id from
  `apps/storefront/src/components/cards/variants/anatomy.astro`.
- **The default.** `DEFAULT_STOREFRONT_THEME` is the Department mall
  template: the v3 Classic grid, density and tokens (tested against values
  captured from the v3 code) with the department search header, the mall
  card and buy box, and the owner-protected classic gallery.

## Templates

Generated from `templates.ts` (the data is the truth; this is a summary).

| Id | Best for | Blocks (header / desktop menu / phone menu / card / listing + filters (chrome) / gallery / buy box / footer); navigation; modules; sticky | Tokens (density, radius, buttons, surface, header, container) |
|---|---|---|---|
| `boutique` | one brand, 5–200 products | boutique-inline / dropdown / accordion-drawer / boutique / grid + bar-dropdowns (surface page, band inline) / stacked / boutique / minimal-columns; nav menu, 6; modules description, content-blocks, policies, reviews, related | airy, square, radius, flat, light header, 1200 |
| `heritage-editorial` | fashion, sarees, crafts | heritage-nav / mega-panel / accordion-drawer / portrait / shelves + bar-dropdowns (gutter flush) / portrait / heritage / newsletter-grey; nav tree+menu, 11; modules description, reviews, related, recently-viewed | airy, square, radius, flat, light header, 1360 |
| `fashion-value` | apparel, 200–5,000 SKUs | fashion-department / mega-panel / bottom-tabs / fashion-value / grid + sidebar-comfortable (phone bar bottom, ruled) / thumbs-below / fashion / newsletter-grey; nav tree+menu, 6; modules frequently-bought-together, description, reviews, related | compact, square, radius, flat, light header, 1360 |
| `spec-catalogue` | electronics, 5k–50k SKUs | spec-two-row / sticky-category-bar / bottom-tabs / spec / grid + sidebar-dense (band beside-filters, search drawer) / thumbs-below / spec / support-dark; nav category-tree, 18; modules spec-table, description, warranty, reviews, related; sticky phoneTop anchor-bar, desktop anchor-bar | dense, subtle, radius, flat, dark header, 1290 |
| `rounded-tech` | premium gadgets, 500–10k SKUs | tech-rounded / dropdown / bottom-tabs / tech-rounded / grid + sidebar-comfortable (no phone banner) / thumbs-below / tech / brand-black; nav category-tree, 9; modules spec-table, description, warranty, policies, reviews, related, recently-viewed; sticky phoneBottom buy-bar | comfortable, soft, pill, raised, dark header, 1360 |
| `marketplace` | very large mixed catalogues | marketplace-search / drill-in-drawer / drill-in-drawer / detailed / grid + sidebar-dense (phone bar split-sheet, list search) / thumbs-left / marketplace-3col / directory (bands); nav tree+menu, 18; modules about-bullets, key-attributes, spec-table, description, warranty, reviews, related; sticky phoneTop anchor-bar, phoneBottom buy-bar | compact, subtle, radius, flat, dark header, full |
| `mass-retail` | household, general goods | retail-pill / drill-in-drawer / drill-in-drawer / retail / grid + drawer (phone bar pill-row, 4 columns, list search) / image-grid / retail / minimal-columns; nav tree+menu, 17; modules about-bullets, description, spec-table, warranty, compare-similar, reviews, related; sticky desktop product-bar | comfortable, rounded, pill, flat, brand header, 1440 |
| `department-mall` | multi-category shops, 50–3,000 SKUs (the default) | mall-search / departments-rail / accordion-drawer / mall / grid + sidebar-dense / classic / mall / product-widgets; nav tree+menu, 8; modules description, reviews, related; sticky phoneBottom buy-bar | compact, subtle, radius, hairline, light header, 1200 |
| `daily-essentials` | grocery, pharmacy, repeat buys | mall-search / sticky-category-bar / bottom-tabs / quick-add / grid + sidebar-comfortable / thumbs-left / essentials / directory; nav tree+menu, 16; modules description, related | compact, rounded, radius, flat, light header, 1360 |
| `showcase-landing` | 1–20 hero products, launches | showcase-simple / dropdown / accordion-drawer / showcase / grid + drawer (links tabs) / stacked / showcase / minimal-columns; nav menu, 6; modules content-blocks, description, reviews; sticky phoneBottom buy-bar | comfortable, rounded, pill, flat, light header, 1200 |

Where the data departs from SYNTHESIS.md, and why:

- **Department mall** keeps the owner-protected classic gallery with its
  own mall buy box, radius buttons and hairline cards in a 1200px container
  instead of the study's pill buttons and flat cards: it is the default.
  It uses the utility top bar, the department search header and the "All
  departments" rail (open on the home page).
- **Mass retail** starts with Target's filter drawer; merchants can select a
  sticky category sidebar in the dashboard. Its popular-filter chips stay.
- **Marketplace** starts categories as cards and searches as rows. Shoppers
  can switch views; the dashboard sets the category default and the switch.
  Other grid/list templates expose the same dashboard controls.
- **Department mall** takes its departments from the tree (`tree+menu`),
  as Game Ghor's "All departments" does; a store without published roots
  with products keeps rendering its menu exactly as before.
- **Card minimums** are grid minimums, not the measured card widths: an
  auto-fill grid stretches cards, and two cards must fit a 360px phone.
  `dense` shares compact's type scale (the 14px phone floor) and uses a 12px
  desktop gap so columns never drop when the page gutter grows at 1024px.
- **Containers** add `1440` (the v3 width, Mass retail's) to the measured 1200/1290/1360/full.
- **Pages.** `pages.landing` holds at most 20 landing pages with the same
  section registry and 24-section cap as home; `/pages/<slug>` renders one
  from the same single batch as home. Product, collection, category, brand
  and search pages have no page entry: their structure is `blocks.product`
  (gallery, buy box, the ordered `below` modules, app blocks, sticky bars)
  and `blocks.listing` (layout, toolbar pieces, filters and their order),
  which the theme editor shows as those pages' blocks. Hidden sections
  (`hidden: true`) stay saved and media-validated but make no public reads.
  A single-product store uses `pages.homeMode`. The document schema is one named OpenAPI
  component (`StorefrontThemeDocument`) that every theme operation
  references, so a page adds its sections once to the generated contract.

## Changing the contract

1. To add a block variant, add a registry entry (strict settings,
   defaults, `requires`, `fallback`, `contrastPairs`, `renders`) and a
   storefront renderer. The pairwise matrix test
   (`storefront-theme/matrix.test.ts`) covers the new variant with every
   other block, palette and density. To add a section type, add a registry
   entry (strict settings, defaults, `requires`), its data reads in
   `home-data.ts`, its renderer, and its type in
   `STOREFRONT_SECTION_RENDERERS`.
2. To change a section's settings incompatibly, bump that entry's
   `version`; an optional field (the hero's `sideBanners`) keeps stored
   sections valid without one.
3. For any other shape change, bump `STOREFRONT_THEME_DOCUMENT_VERSION`,
   add one upgrade step from the previous version in `upgrade.ts`, and
   capture that previous version's golden fixture. Never reset older stored
   themes. Historical reset migrations remain immutable; this upgrade path
   applies to documents that still exist.
4. Coordinate API/storefront release versions: an older storefront cannot
   read a future document. Current readers upgrade older stored documents,
   while unknown store-shape keys continue to fail closed to fit fallbacks.

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
| `marketplace` | Target, Daraz | Bright white, near-black ink, cool neutral panels, orange actions. |
| `marketplaceAmazon` | Amazon | Dark header, white content, amber search and cart actions, orange buy action. |
| `boutique` | COS, Aesop, Ssense | No colour at all: linen page, espresso ink, flat cards and square corners; an editorial serif over a neutral grotesque carries the hierarchy. |
| `fresh` | Instacart, Chaldal, Ocado | Clean white, a leaf green for buying, green-tinted panels for categories and delivery facts; friendly rounded sans and pill buttons for thumb use. |
| `beauty` | Glossier, Sephora | Black type and black pill buttons on white, a blush accent used only on surfaces; a soft display serif over a geometric sans. |
| `heritage` | Aarong, Fabindia, Anthropologie | Hand-made paper, umber ink and madder terracotta; a crafted Garamond with a Bengali serif, generous leading and a narrower measure. |
| `midnight` | Apple, Nothing, Linear | Layered near-blacks (page, card, panel), white ink and white pill buttons; a precise grotesque with tight tracking; soft shadows instead of borders. |

### Palette tokens

| Token | retail | marketplace | boutique | fresh | beauty | heritage | midnight |
|---|---|---|---|---|---|---|---|
| background | #ffffff | #ffffff | #f6f4ef | #ffffff | #ffffff | #faf6ef | #0a0a0b |
| foreground (ink) | #1d1c1a | #0f1111 | #242220 | #15231b | #1a1718 | #2a2018 | #f4f4f5 |
| card | #ffffff | #ffffff | #f6f4ef | #ffffff | #ffffff | #fffdf8 | #141416 |
| primary (actions) | #1d1c1a | #c2410c | #242220 | #0b7a3e | #1a1718 | #8a3b1e | #f4f4f5 |
| muted surface | #f1eee8 | #f2f4f5 | #ebe7df | #f1f6f1 | #fbf4f3 | #f2eadd | #1c1c1f |
| muted text (helper) | #5d5850 | #565959 | #5a554d | #4b5a51 | #625a5b | #665646 | #a8a8b0 |
| accent surface | #e9e3d8 | #fff1e6 | #e3ddd2 | #e3f4e6 | #f8e1e1 | #ecdfc9 | #232327 |
| border | #e5e0d6 | #e3e6e6 | #d9d3c7 | #dde8de | #f0e2e1 | #e2d5bf | #27272b |
| destructive (error) | #b42318 | #b12704 | #9b1c1c | #c0262d | #b4232c | #a3191b | #f87171 |

`marketplaceAmazon` shares `marketplace`'s white and neutral surfaces,
uses #131921 ink, and replaces its pale accent with #ffd814 and dark accent text.

### Typography pairings

Families are Google Fonts, self-hosted by the storefront (`STOREFRONT_FONTS`).
Each Latin face carries a Latin `unicode-range`, so Bangla text falls through to
the pairing's Bengali family (Noto Sans or Noto Serif Bengali). Swap uses
metric-matched fallback faces (`<Family> Fallback`, with size-adjust and
ascent/descent overrides), so it never shifts layout. Only the heading face's
Latin subset is preloaded.

The dashboard's Theme page offers them in a Typography card (pairing, type
scale, heading case; the template's values marked, with a reset). Its
previews draw each pairing in the same files under `Preview <Family>` names,
registered only when the picker opens
(`apps/admin-v2/src/components/admin/online-store/type-preview-fonts.ts`,
keyed by the same font keys as `apps/storefront/src/lib/theme-fonts.ts`, so a
new family fails the type check until both have its file).

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
