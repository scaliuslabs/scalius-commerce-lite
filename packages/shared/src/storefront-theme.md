# Storefront theme document (version 7)

One JSON document describes how the storefront looks. It holds the template label, the tokens, the brand, one variant per block with its settings, the homepage sections with their content, up to 20 landing pages and what `/` shows. The dashboard saves every visual and merchandising choice into it, previews it, publishes it atomically and restores it from versions. An agent can write it through the API, and installed apps add sections and product blocks. The storefront and the dashboard resolve it against the store with the same function. This file is the contract for contributors and coding agents. It also describes how the dashboard drafts, previews and publishes the document.

Store identity (name, phone, email, address, social profiles) is not in the theme. The business document (Settings > Store details) owns it, and every buyer surface reads it only from there.

Source of truth: `packages/shared/src/storefront-theme/*.ts`, re-exported as `@scalius/shared/storefront-theme`.

## Files

| File | Holds |
|---|---|
| `document.ts` | The document schema, the contrast check, the home mode and the read upgrade entry points. |
| `tokens.ts` | Token enums and specs, palettes, fonts, the token schema and the token CSS. |
| `contrast.ts` | The 19 colour keys, colour maths, the base AA pairs and the header-tone surfaces and bands. |
| `blocks.ts` | The block-variant registry, card and buy box looks, listing filter styles and page chrome, product modules, sticky bars, the navigation and blocks schemas. |
| `sections.ts` | The section registry (20 types, strict settings) and the types the storefront renders. |
| `apps.ts` | Sections and product blocks that installed apps draw (`<plugin id>/<type>`). |
| `fit.ts` | `StoreShape` (bounded store facts), the navigation facts and the fit conditions. |
| `resolve.ts` | `resolveStorefrontTheme(document, storeShape)`. |
| `templates.ts` | The 10 templates as frozen data and `DEFAULT_STOREFRONT_THEME`. |
| `brand.ts`, `links.ts` | The brand images and logo width, and the link rule for theme content. |
| `content.ts` | The merchant's content inside the document (`storefrontThemeWithContent`, `storefrontThemeLook`) and every image it names (`storefrontThemeMediaReferences`). |
| `home-data.ts` | What homepage sections read, shared by the API and the storefront. |
| `pages.ts` | Landing pages at `/pages/<slug>`. |
| `compare.ts` | `compareThemeDocuments`: the typed changes between two documents, stored with each version. |
| `upgrade.ts` | One pure step per historical version. See [upgrade.md](storefront-theme/upgrade.md). |

Two tests guard the registry. `matrix.test.ts` checks every pair of block variants with every palette and density. `fidelity-contract.test.ts` checks template x card x filter style x navigation source on empty, tiny, live-small, 30k-seed and huge stores.

## Shape

```jsonc
{
  "version": 7,                        // literal; a new shape means a new version
  "template": "department-mall",       // the template it is based on: a label, never read for behaviour
  "tokens": {
    "colors": { "<19 keys>": "#rrggbb" },
    "typography", "typeScale", "headingCase", "density", "radius",
    "buttonShape", "surface", "imageRatio", "imageFit", "headerTone", "container"
  },
  "brand": { "logo", "logoWidth", "footerLogo", "favicon" },  // media ids (null: none); width 80-240 step 10
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
    "product": { "gallery", "buyBox", "below": [], "apps"?: [], "sticky": { "phoneTop", "phoneBottom", "desktop" } },
    "footer"                           // every variant: { tagline, about, copyright } (+ directory's style)
  },
  "pages": {
    "home": [{ "id", "type", "version", "settings", "hidden"? }],
    "homeMode": { "kind": "sections" }, // or { "kind": "product", "productId" }
    "landing": { "<slug>": { "title", "description", "sections": [], "noIndex"?, "excludeFromSitemap"? } }
  }
}
```

| Token | Values |
|---|---|
| `typography` | `retail`, `market`, `editorial`, `fresh`, `beauty`, `heritage`, `tech` |
| `typeScale` | `flat`, `retail`, `display` |
| `headingCase` | `sentence`, `uppercase` |
| `density` | `dense`, `compact`, `comfortable`, `airy` |
| `radius` | `square`, `subtle`, `rounded`, `soft` |
| `buttonShape` | `square`, `radius`, `pill` |
| `surface` | `flat`, `hairline`, `raised` |
| `imageRatio` | `square`, `portrait`, `landscape` |
| `imageFit` | `contain`, `cover` |
| `headerTone` | `light`, `dark`, `brand` |
| `container` | `1200`, `1290`, `1360`, `1440`, `full` |

## Rules

### Content, brand and what `/` shows

- **One draft for the look.** Every visual and merchandising choice is in the document. A save writes the draft only. A preview renders the draft. A publish makes all of it live at once. A version restores all of it. Header and footer menus stay navigation menus with their own publish. The theme only chooses where their links come from (`blocks.navigation`).
- **Announcement and footer words.** The `topBar` variant is the only switch for the announcement: `none` is off. The other three variants carry `text` (160 characters at most) and an optional `link`. Every footer variant carries `tagline` (160), `about` (1,000; plain text, a blank line between paragraphs) and `copyright` (120; the name after "©"). An empty `copyright` shows the store name. The line always renders.
- **Brand.** `brand.logo`, `brand.footerLogo` and `brand.favicon` are media ids. `null` shows the store name in text, or the platform tab icon. `brand.logoWidth` is the header logo width on computers (80 to 240 px, steps of 10). Phones cap it at 160 px. The layout read returns the published brand images in its one batch (`layout.brand`). A preview resolves the draft's own images (`POST /api/v1/storefront/theme-preview/resolve` returns `brand`). Emails use the published logo's original upload.
- **Saves check what the document names.** A save rejects a media id that is not a ready or trashed image in Files. It rejects a product home mode whose product is gone or in trash. Each error names its document path (`brand.logo`, `pages.home.2.settings.slides.0.image`). A link is a canonical, navigation-safe href: a same-store path, a `?query`, a `#fragment` or an https URL. Files refuses to delete an image that the published theme or the draft still shows.
- **Content survives a template.** Choosing a template copies its look and keeps the merchant's content (`storefrontThemeWithContent`): the brand, the home mode, the landing pages, the announcement and footer words where the new variants carry them, each hero's slides and side banners, and the category tiles' and collections' picks. Picks go to the first section of the same type, then the second. "Matches a template" compares looks only (`storefrontThemeLook`). Switching a block variant, and a resolver fit fallback, keeps the settings both variants declare (`storefrontBlockSwitch`).
- **What `/` shows.** `pages.homeMode` is `sections`, or `product` with a `productId`. While that product is public (the homepage read returns it as `sections.homeProduct`), `/` answers 302 to the product page. That page keeps its canonical URL and SEO and never redirects back. A product that stops being public leaves `/` on the sections. A preview follows the draft's mode.
- **The template is a label.** `template` says what the theme is based on: the dashboard's "based on" line and its reset-to-template defaults. No storefront component and not the resolver read it for behaviour. Every behaviour is a block variant, a setting or a token, so blocks from any template mix freely. `apps/storefront/src/lib/theme-contract-consumers.test.ts` fails when a component branches on the template. The same test checks that every enum value of every block setting, toolbar piece, product module and section setting has a consumer. A choice with no renderer is removed.
- **Per-resource overrides.** `products.page_template` names a template (or `classic`, the Department mall product page). The product page then uses that template's `blocks.product` and keeps the store's own header, footer, tokens and card (`apps/storefront/src/components/product/lib/product-page-theme.ts`). `categories`, `collections` and `brands` have `listing_template`: a listing layout (`grid`, `list`, `shelves`, `quick-grid`) or a filter style. It replaces the theme's layout or filter style for that listing when the store fits it (`catalogListingPresentation`). `null` uses the theme. The product form sets `page_template`. The category form sets `listing_template`.
- **Strict writes, upgraded reads.** Writes accept only the current version, known keys and valid registry settings. Stored reads run the pure step-wise `upgradeThemeDocument` before the same validation. Older merchant documents upgrade in memory without writes or resets. An invalid or unknown future document fails closed: the dashboard reports it unreadable and the storefront renders the default theme.

### Tokens, cards and contrast

- **Tokens are global; blocks choose structure.** A variant never carries its own colour, so any mix of variants stays coherent. One card per store. Cards are the exception for shape and type (below).
- **Readable text.** Every pair in `STOREFRONT_THEME_TEXT_PAIRS`, plus the `contrastPairs` of every chosen variant and of every variant it can fall back to, must reach WCAG AA (4.5:1). The header roles (`header-background`, `header-foreground`) follow `headerTone`: `dark` takes the darker of ink and page, `brand` takes the action colour. A write that breaks a pair is rejected. `muted-foreground` must also be near-neutral (Lab chroma 25 or less) and at least 40 CIE76 units from `destructive`, so helper text never looks like an error.
- **Colours.** Every colour a block paints is a theme token. The footer tones re-point the footer's surface tokens to an AA pair. The banded `directory` footer uses the header tone with two derived bands: `theme-header-raised` (at most 14% toward the header text, never below AA) and `theme-header-deep` (away from the text). Stars and review bars use `theme-rating` (amber, always beside the rating number in text).
- **Cards.** The registry has 12 card variants. `standard` follows the template's tokens and type scale. Every other card owns its measured look (`STOREFRONT_CARD_LOOKS`): photo ratio and fit, radius in px, surface, and title and price size and weight per viewport. A template's radius, surface and photo tokens never flatten it. Density still owns the grid (card minimum, gaps) and the card padding.
  - A card's anatomy is data in `renders`: body order, price colour role, discount wording, placement and shape, the struck price style, stars or a score, the buy action and `look`. Any two cards differ in at least three of these on a product with every fact (render test). The storefront renders `standard` from its own file and every other card from `apps/storefront/src/components/cards/variants/anatomy.astro`.
  - Settings: `standard` and `portrait` take `hoverImage`. `boutique` takes `hoverImage` and `quickAction`. `retail` takes `quickAction`. `quick-add` takes `fullAction` (the Daily Essentials default: a full-width outline action) and `showBuyNow`. The editor's card sketch follows the saved choice. The `showcase` card shows Add only for a product that needs no buyer input (no options, customization or gift card; in stock; a fixed positive price). Other in-stock products open their page.
  - Facts (brand, key specs, rating, sold, pack size, delivery, EMI, swatches, options) render only when the product has the data. There are no zero states. Sold counts show from 10 units in 30 days. Swatches come from the first colour axis (a swatch attribute colour or an exact CSS colour name, at most 5). Key specs show at most 4. The `emi` fact needs `emiMonthlyFrom`, which no API read sends, so it never renders. Only `spec` has `compare` (Star Tech's "Add to Compare" and the floating tray to `/compare`).
  - The facts are each product's `cardFacts` (`packages/core/src/modules/catalog/card-facts.ts`): one bounded statement batched with the card media, so no page gains a D1 round trip.
  - A card never shows an original upload that has no renditions. It shows the placeholder while the render job runs. The hover photo loads on intent, decodes, then fades. Variant-specific minimum heights (Showcase and Marketplace titles, `spec` and `mall` tiles on computers) keep sparse cards aligned without inventing a fact.

### Fit and store shape

- **Fit.** A variant declares `requires` (conditions over the `StoreShape`) and a `fallback`. The resolver walks the fallback chain until a variant fits. Every chain ends in a variant that always fits (tested). Toolbar pieces, product modules and sections without their data are left out. `resolved.fallbacks` says what changed and which conditions failed, so the dashboard can say why.
- **Store shape.** The API reads it in one bounded statement in the storefront layout batch (`packages/core/src/modules/storefront/store-shape.ts`) and serves it beside the theme (`layout.storeShape` and the dashboard's theme read). Counts stop at 1,000 rows. A fact counts only what a buyer can reach. A public product is a row of `product_buyer_state` with `is_public`.

  | Fact | Meaning |
  |---|---|
  | `topCategoryCount` | Published root categories with a public product in their published subtree. |
  | `categoryDepth` | 1 plus the deepest `category_closure` level where a category with every ancestor published holds a public product (0 to 4). |
  | `categoryGroups` | The most second-level categories with two or more published children under one root. |
  | `brandCount` | Published brands with a public product. |
  | `hasKeySpecs` | A live `key_spec` attribute has a value on a public product. |
  | `hasReviews` | Reviews are on and one is published. |
  | `hasDigitalLines` | A live digital SKU of an active product. |
  | `hasEmiPlans` | The `emi` settings document is on and has a plan. |
  | `hasContentBlocks` | A public product has a block the product page renders (`STOREFRONT_RENDERED_CONTENT_BLOCK_TYPES`, outside the description tabs). |

  `productCount`, `skuCount`, `hasCollections`, `hasDeliveryMethods` and the header menu counts complete the shape. A core test fails when a `requires` names a fact the statement does not produce. The cache keys are `lm:shape`, `lm:all`, the "any row" keys, `set:emi:document` and `t:product_content_blocks`. `store-shape.scale.test.ts` (opt-in) checks the 30k catalogue seed: 25 roots, 4 levels, 300 brands and key specs.

### Navigation

`blocks.navigation` is shared by every header surface.

- `source` is `menu`, `category-tree` (published roots with public products and their published descendants, 4 levels at most) or `tree+menu` (the roots in tree order, then the menu's other top items). In `tree+menu`, an item whose target is already present merges into it and keeps the first position and the menu's label.
- `maxTopItems` (1 to 18) caps the top entries of a row, rail or drawer root. The rest go behind "More" or "All categories". `linkBudget` (20 to 150) caps the anchors of all header surfaces together, clones included.
- A tree source on a store without a public root renders the menu. A menu source without a menu renders the tree (`resolved.blocks.navigation`, with a `navigation` fallback).
- Menu patterns fit against `navTopItems`, `navDepth` and `navGroups` in `resolved.facts`: the source that renders, capped by `maxTopItems`.

### Listing

One listing block serves category, collection, brand and search pages. The editor shows it as those pages' blocks.

- **Layout.** `grid`, `list`, `shelves` (one shelf per sub-category or collection, at most 8; `spacing: airy` is Aarong's track; needs category depth 2 or a collection, else `grid`) and `quick-grid` (needs the `quick-add` card, else `grid`). Shelves show only on the plain first page: no search, refinement, sort or later page.
- **Starting views.** `searchLayout` (`same`, `grid`, `list`) sets how search results start. `phoneLayout` (`grid`, `list-row`) sets the phone view. The buyer's grid/list switch (toolbar piece `grid-list-toggle`) is stored in the browser, separately for browsing and for searching. `paging` is `numbered`, `load-more` or `infinite`. The last two keep crawlable `?page=n` links.
- **Description.** `descriptionPlacement` puts a category, collection or brand description `above` the results (clamped to two lines with "Read more") or `below`. The merchant's buying guide always renders below the results.
- **Filter styles.** `filters.style` places the facets:
  - `sidebar-dense` (Amazon, Daraz, Star Tech): a 240 px column, 22 px rows, 14 px labels.
  - `sidebar-comfortable` (Apple Gadgets, Fabrilife, Game Ghor): 270 px, 28 px, 16 px.
  - `bar-dropdowns` (Dawn, Aarong): up to 4 facet dropdowns in a bar, the rest in a drawer.
  - `drawer` (Target, Chaldal): a Filter button and a drawer.

  On phones every style opens the facets from a Filter button in a sheet. `openByDefault` opens the facet groups (never for `bar-dropdowns`). A template may set its reference's own numbers over the style's: `column` (180 to 340 px), `rowPitch` (16 to 36 px) and `label` (12 to 18 px). `resolved.blocks.listing.filters.spec` carries the result. Marketplace uses 262/22/14, spec-catalogue 225/32/14, rounded-tech 316/28/16 and department-mall 262/21/14. A facet shows 10 values in the HTML. "See more" fetches the rest.
- **Filter order and placement.** `order` reorders whole groups. Unset keeps the style's reference arrangement. Star Tech and Apple Gadgets state price first. `searchPlacement: drawer` (Star Tech) moves a sidebar's facets into the drawer on search, so the results take the width (up to five columns). `ruled` (Fabrilife) draws a sidebar's groups as one flat, ruled list that scrolls on its own. A sidebar stays sticky on computers (from 1024 px).
- **Small catalogues.** Filters need 8 results and a facet with two values, unless the buyer already refined (`storefrontListingFiltersShown`). A store with fewer than 8 products resolves `shown: false`. Sort needs two results.
- **Toolbar pieces.** `breadcrumb`, `category-banner`, `subcategory-pills`, `facet-value-chips`, `popular-filter-chips`, `aspect-chips`, `result-count`, `sort`, `per-page`, `applied-chips`, `grid-list-toggle`. A piece without data is left out: `subcategory-pills` needs category depth 2 and `popular-filter-chips` needs key specs. `applied-chips` shows the buyer's refinements as removable chips. Without it the filter form still undoes each one. `facet-value-chips` shows one row of 2 to 8 values of the first option or attribute facet. The editor has a switch for every piece except `popular-filter-chips` and `aspect-chips`, which follow the layout.
- **Page chrome.** Template data states what the references do around the results:
  - `surface`: `page` (Dawn's page colour behind the grid) or `muted`. `gutter`: `inset` or Aarong's `flush`.
  - `band`: `standard`; `inline` (Dawn: the title alone, then the count and controls over a facet bar); `beside-filters` (Star Tech: the band in the results column). `inline` needs the bar placement and `beside-filters` a sidebar. Otherwise `standard` renders.
  - `phoneBar`: `standard`, `pill-row` (Target), `split-sheet` (Amazon, Daraz) or `bottom` (Fabrilife, pinned to the bottom of the screen).
  - `links`: `chips`, or the Showcase `tabs` strip that starts with "All" (not on search).
  - `phoneBanner`: the category banner on phones too (Apple Gadgets shows it on computers only). `maxColumns`: 3 to 6 or `null` (Target's four roomy columns). The `spec` and `mall` cards cap at four.

### Product page

`blocks.product` is the page template for every product. A product's `page_template` can swap it (see above).

- **Gallery.** `classic` (the original page: thumbnails beside the photo), `thumbs-below`, `thumbs-left` (48 px rail; `phoneSideThumbnails` keeps it beside phone photos), `stacked` (every photo full width beside a sticky 345 px info column), `portrait` (3:4 stage) and `image-grid` (photos two across). `stacked` and `image-grid` keep their details column sticky by layout.
- **Buy box.** 12 variants: `classic`, `spec`, `tech`, `marketplace-3col`, `retail`, `mall`, `essentials`, `boutique`, `showcase`, `fashion`, `heritage`, `digital`. Each but `classic` has a measured look (`STOREFRONT_BUY_BOX_LOOKS`).
  - `spec` and `tech` take `emi`. The EMI line shows only when the store has EMI plans. `tech` also takes `whatsapp` (an "Order on WhatsApp" strip when the store has a WhatsApp number).
  - `fashion` and `heritage` start with one purchase button. Their `showBuyNow` setting adds Buy now.
  - `essentials` puts quantity beside Add to cart and Buy now full width below. `essentials` and `showcase` also show the store's call and WhatsApp links from the business phone, after the buy buttons.
  - `marketplace-3col` puts delivery and purchase facts in a right column. Its option tiles show a price when the other selected options identify one purchasable SKU.
  - `digital` needs a digital SKU, else `classic`.
  - `classic`, `boutique`, `showcase`, `heritage` and `fashion` keep the description beside the gallery. Other buy boxes render it as the `description` module.
- **Modules.** `below` lists the modules in page order. Each renders only when this product has its data, from reads the page already makes.

  | Module | Shows |
  |---|---|
  | `frequently-bought-together` | The first half of the recommendations (two at most) when they are mostly real co-purchases, with this item and a total for fixed prices. |
  | `key-attributes` | The key-spec rows (at most 8). Needs key specs in the store. |
  | `about-bullets` | The product's features. Left out when the buy box already lists them. |
  | `spec-table` | Every attribute value as a specification row. A brand is never a row. |
  | `description` | The product's description (see above). |
  | `content-blocks` | The product's rendered content blocks. Needs a public product with one. |
  | `compare-similar` | Recommended products of the same category in the store's card, and a link into `/compare`. Needs key specs. |
  | `warranty` | The product's warranty terms. |
  | `reviews` | The reviews. The zero state carries "Write a review", so the first review can be written. |
  | `policies` | The published policy pages from the layout data. |
  | `related` | The recommendations the page already reads. |
  | `recently-viewed` | This browser's own list, filled before paint. Nothing without JavaScript. |

- **Sticky bars.** At most one at the top and one at the bottom on phones. `phoneTop: anchor-bar` (Amazon's Top, Details, Explore and Reviews bar). `phoneBottom: buy-bar` (the price and Add to cart once the buy buttons scroll away). `desktop: anchor-bar` (Star Tech) or `product-bar` (Target: name, price and Add to cart under the header once the buy buttons scroll away).
- **App blocks.** `blocks.product.apps` lists blocks that installed apps draw (`{ id, app, values }`, at most 10, in the merchant's order). Each renders in the buy box or after the modules, as its app declares.

### Sections, landing pages and apps

- **Registry.** Each `type` is an entry in `STOREFRONT_SECTION_REGISTRY` with its own `version` and strict settings. The 20 types are `hero`, `usp-strip`, `category-tiles`, `collections`, `product-rail`, `product-grid`, `deal-block`, `product-tabs`, `shop-by`, `banner-mosaic`, `lookbook`, `banner`, `brand-wall`, `editorial` (layouts `rich-text`, `image-with-text`, `multicolumn`, `testimonial`), `faq`, `utility-cards`, `endless-grid`, `seo-text`, `recently-viewed` and `newsletter`. An app section has type `app` (`settings.app` is `<plugin id>/<type>`). Sections are optional, repeatable and reorderable. Ids are unique. A page holds at most 24. A hidden section (`hidden: true`) stays saved and media-validated but makes no public reads.
- **Renderers.** `STOREFRONT_SECTION_RENDERERS` lists the types the storefront renders: one component each under `apps/storefront/src/components/homepage/`. An app section that is gone, inactive or no longer declared renders nothing.
- **Sections without data.** A section without data renders nothing, with no placeholder. `storefrontSectionNeedsContent` flags a section whose own settings leave nothing to show, and the dashboard shows the flag. Examples: a hero without a slide whose image resolves, category tiles with fewer public categories than their style needs (`storefrontCategoryTilesMinimum`), an empty testimonial list or FAQ. Templates ship the story, highlights, quotes and FAQ sections empty, so they stay hidden until the merchant fills them in the editor. A collections section without a collection that has products shows the newest products. The storefront reads shipping and checkout facts only when a `usp-strip` section shows them (`homeSectionsShowDeliveryFacts`). Consecutive `banner` sections with the same `two-up` or `four-up` layout share one row.
- **Hero slides.** A slide has a computer image and an optional `phoneImage`, each with a focal point (`phoneFocalPoint` falls back to `focalPoint`), the alt text (never drawn over the image), optional `heading` and `text` over it, and a link (`null`: not a link). The button shows only with a link. At most 10 slides. `sideBanners` (at most 2) show only with `contained-banners`.
- **Newsletter.** `newsletter` is the signup form: the phone always, the e-mail `optional`, `required` or `hidden`, an optional WhatsApp box and a consent line in the store's language. It posts to the storefront's `/api/newsletter/subscribe` and works without JavaScript (`apps/storefront/src/lib/newsletter-server.ts`). It reads no data, so it always renders. The `newsletter-grey` footer carries the same form, left out on a page that already shows one.
- **Home data.** `homeSectionRequests(home, homeMode)` derives what the page reads: one product list per source at the largest limit any section asks (at most 8 lists of 36), at most 40 images, the category tiles' categories (24), the collections (8), the brand wall's brands, the deal promotions (4), a product homepage's product and the app sections (8). Callers never name reads. The API reads exactly these in the homepage's two batches (`sections`: `lists`, `media`, `brands`, `promotions`, `categories`, `collections`, `homeProduct`, `apps`). The homepage batch part serves them for the published theme (a fixed read that rejects any query string). A preview reads the saved draft's sections on the private, never-cached, token-verified `POST /api/v1/storefront/theme-preview/homepage`.
- **Landing pages.** `pages.landing` holds at most 20 pages at `/pages/<slug>`. A handle is one lowercase CMS-style segment that is not a reserved route and not `pages`. A page has a `title` (120), a `description` (320), its own sections (same registry and 24 cap as home) and optional `noIndex` (public with `noindex,follow`, out of the sitemap) and `excludeFromSitemap`. A landing page renders from the same single batch as home (the layout plus `GET /api/v1/storefront/landing/<slug>`). Its canonical is always the absolute `/pages/<slug>` address. The pages sitemap lists the live theme's landing pages without a lastmod.
- **No per-page templates.** A product, collection, category, brand or search page has no page entry: its structure is `blocks.product` or `blocks.listing`. A single-product store uses `pages.homeMode`. A CMS page keeps its own content, framed by the theme.

## Draft, preview, publish and versions

The service is `packages/core/src/modules/settings/site-settings.service.ts`. The rows are `theme_settings` (live), `theme_settings_drafts` (the one shared draft) and `theme_settings_versions` (immutable published versions).

- **One shared draft per store.** Every write is one guarded D1 batch on revisions. The draft revision only grows. Save, page edit, restore, discard and publish each carry the revisions they read. A stale revision answers 409.
- **Restore and discard replace the draft only.** Publish is the one way anything goes live. One batch writes the live row, a version row and the rebased draft, and prunes history to the newest 20 versions.
- **Version rows.** A row holds `{ meta: { changes, moreChanges, note }, theme }`. `changes` has at most 20 typed entries (`compareThemeDocuments`). `note` has at most 500 characters. Author and time come from the row. A document is at most 512 KiB.
- **Missing images.** A version that names images deleted from Files since is refused with `THEME_VERSION_IMAGES_MISSING` (`details.missingImages`). Restoring it with `withoutMissingImages` leaves out the slides, cards and tiles that showed one and empties single images (`storefrontThemeWithoutMedia`).
- **Preview.** `POST /api/v1/admin/settings/theme/preview-session` mints a one-time continuation code (`tpc_`, valid 5 minutes) for the saved draft or one published version. The browser posts it to the storefront `/theme-preview/continue` (`/theme-preview/embed` in the editor frame). The storefront exchanges it for a `tpv_` token in the HttpOnly cookie `stp_theme_preview` (valid 30 minutes). The database stores only the SHA-256 of each token. A draft token is `D` plus random. A version token is `V`, the base-36 revision and random. The session stores no theme: every preview read resolves the saved draft or version as it is then. A pruned version stops previewing. Preview needs a valid HTTPS Storefront URL in the Platform settings (Settings > Store details > Web addresses).
- **Permissions.** Reads need `settings.general.view`. Writes need `settings.general.edit`. Staff with view only open the editor read-only.

## Editor

Online store > Theme (`/admin/online-store/theme`) shows the current theme, whether its draft has unpublished changes and who published last, with Customize, Preview and Publish. Below it is the template library: choosing a template restyles the draft and keeps the merchant's content. Customize opens the editor at `/admin/online-store/theme/editor`.

- **Layout.** A top bar holds back, the theme state, the page picker, the device toggle, undo and redo, More actions (Versions, Preview in a new tab, Discard draft), Save and Publish. The left panel shows the page's tree. The preview in the middle is the real storefront in a frame. The selected part's settings sit at the right, and replace the tree below 1280 px. Edits autosave to the draft 800 ms after the last one, against the draft revision. A conflict keeps the edits and offers reload or an explicit overwrite.
- **Page picker.** Home page, Products, Collections, Categories (brands too), Search results, Pages (CMS) and every landing page. A resource page previews the store's first item and can switch to another.
- **Tree.** Header (announcement bar, header), the page, Footer. Home and landing pages list their sections (add, reorder by drag or keyboard, duplicate, hide, remove with undo). Product pages list Product information, the modules (shown first in page order, then hidden ones) and App blocks. Listing pages list Toolbar, Filters and Product grid. CMS pages link to their content editor.
- **Theme settings tab.** Six colours (background, text, buttons, button text, highlight, highlight text), each writing every token of its role and showing the readable-text problems it causes. Typography (pairing, type scale, heading case, with the template's values marked and a reset). The brand images and logo width. Product cards. The header, its menu style and the footer have their own settings.
- **Generated forms.** Section and block settings forms come from the registry's zod schemas (`apps/admin-v2/src/components/admin/online-store/schema-form/`). A new setting needs a label in `apps/admin-v2/src/i18n/theme-settings.ts` (English and Bangla) and no form code.
- **The frame.** The frame is a normal preview session redeemed by `/theme-preview/embed`: the code arrives by `postMessage` and the cookie is `SameSite=None; Partitioned`. Only a page that rendered a valid preview carries the section marks (`data-theme-section-id`), the inline bridge (`apps/storefront/src/lib/theme-preview-bridge.ts`) and a `frame-ancestors` that names the dashboard origin. Both sides check the other's exact origin and window (`@scalius/shared/theme-editor-bridge`). A click on the preview selects the part under the pointer. A settings change re-renders its section from the private, never-stored `/theme-preview/section?id=`. Anything that moves the page reloads it. A buyer's homepage is byte-identical with or without the editor (`apps/storefront/src/lib/route-tests/theme-editor-preview.render.test.ts`).

## API and agents

The routes are in `apps/api/src/routes/admin/settings/site.ts` under `/api/v1/admin/settings/theme/`. Their operation ids start with `dashboard.theme.`.

| Operation | Route | Notes |
|---|---|---|
| `editor_get` | `GET /editor` | The editor's bundle (documents, store shape, images, app surfaces). Not an agent operation. |
| `workspace_get` | `GET /workspace` | Revisions, last publication and the landing pages. |
| `document_get` | `GET /document?source=draft\|published\|version` | One whole document (`revision` with `version`). Agents get it as an authenticated JSON artifact. |
| `versions_list` | `GET /versions` | Five versions per page, newest first. |
| `draft_save` | `POST /draft` | The whole document. |
| `page_draft_update` | `POST /page-draft` | The homepage sections or one landing page (`null` removes it). |
| `version_restore` | `POST /restore` | Puts a version in the draft. |
| `draft_discard` | `POST /discard` | The draft becomes the live theme again. |
| `publish` | `POST /publish` | The exact saved draft revision, with an optional note. |
| `preview_session_create` | `POST /preview-session` | A browser continuation for an agent. |

The commands answer revision receipts only. The curated workflow `theme.draft-landing-page.v1` drafts one landing page and verifies it through `workspace_get`. It never publishes.

The OpenAPI contract states shared shapes once as named components (`ErrorResponse`, `StorefrontThemeDocument`, `StorefrontSectionList`, `StorefrontLandingPage`, `StorefrontHomepageSections`), so a full operation description fits one agent result. A nullable use of a named schema is `z.union([Named, z.null()])`, because `.nullable()` would make the component itself nullable. `apps/api/src/openapi/component-schema-refs.test.ts` checks this.

## Templates

Template defaults live in `templates.ts`, and the data is the truth. This table summarizes each template's starting blocks.

| Id | Best for | Header / desktop menu / phone menu / card | Listing + filters (chrome) / gallery / buy box / footer | Look: density, radius, buttons, surface, header, container |
|---|---|---|---|---|
| `boutique` | one brand, 5-200 products | boutique-inline / dropdown / accordion-drawer / boutique | grid + bar-dropdowns (surface page, band inline) / stacked / boutique / minimal-columns | airy, square, radius, flat, light, 1200 |
| `heritage-editorial` | fashion, sarees, crafts | heritage-nav / mega-panel / accordion-drawer / portrait | shelves + bar-dropdowns (gutter flush) / portrait / heritage / newsletter-grey | airy, square, radius, flat, light, 1360 |
| `fashion-value` | apparel, 200-5,000 SKUs | fashion-department / mega-panel / bottom-tabs / fashion-value | grid + sidebar-comfortable (phone bar bottom, ruled) / thumbs-below / fashion / newsletter-grey | compact, square, radius, flat, light, 1360 |
| `spec-catalogue` | electronics, 5k-50k SKUs | spec-two-row / sticky-category-bar / bottom-tabs / spec | grid + sidebar-dense (band beside-filters, search drawer) / thumbs-below / spec / support-dark | dense, subtle, radius, flat, dark, 1290 |
| `rounded-tech` | premium gadgets, 500-10k SKUs | tech-rounded / dropdown / bottom-tabs / tech-rounded | grid + sidebar-comfortable (no phone banner) / thumbs-below / tech / brand-black | comfortable, soft, pill, raised, dark, 1360 |
| `marketplace` | very large mixed catalogues | marketplace-search / drill-in-drawer / drill-in-drawer / detailed | grid + sidebar-dense (phone bar split-sheet, list search) / thumbs-left / marketplace-3col / directory (bands) | compact, subtle, radius, flat, dark, full |
| `mass-retail` | household, general goods | retail-pill / drill-in-drawer / drill-in-drawer / retail | grid + drawer (phone bar pill-row, 4 columns, list search) / image-grid / retail / minimal-columns | comfortable, rounded, pill, flat, brand, 1440 |
| `department-mall` | multi-category shops, 50-3,000 SKUs (the default) | mall-search / departments-rail / accordion-drawer / mall | grid + sidebar-dense / classic / mall / product-widgets | compact, subtle, radius, hairline, light, 1200 |
| `daily-essentials` | grocery, pharmacy, repeat buys | mall-search / sticky-category-bar / bottom-tabs / quick-add (full action) | grid + sidebar-comfortable / thumbs-left / essentials / directory | compact, rounded, radius, flat, light, 1360 |
| `showcase-landing` | 1-20 hero products, launches | showcase-simple / dropdown / accordion-drawer / showcase | grid + drawer (links tabs) / stacked / showcase / minimal-columns | comfortable, rounded, pill, flat, light, 1200 |

Each template also sets a top bar, the navigation source and its top-item cap, the product modules, the sticky bars and a starting homepage. Read them in `templates.ts`. Notes on where a template departs from its reference:

- **Department mall** is the default: every store with no saved theme renders it (`DEFAULT_STOREFRONT_THEME`). It keeps the `classic` gallery, with its own `mall` buy box, radius buttons and hairline cards in a 1200 px container. Its utility top bar, department search header and "All departments" rail (open on the home page) take departments from the tree (`tree+menu`).
- **Mass retail** starts with Target's filter drawer. Merchants can select a sticky category sidebar in the dashboard. Its popular-filter chips stay.
- **Marketplace** starts categories as cards and searches as rows. Shoppers can switch views. The dashboard sets the category default and the switch. Other grid and list templates expose the same controls.
- **Daily Essentials** has a bottom tab bar (home, categories, cart, search, account) and no sticky buy bar. Its card is `quick-add` with the full-width outline action. Its gallery is `thumbs-left` without the side rail on phones. Its home shows a full-bleed hero, category tiles, a "Top selling products" grid (`popular`), a brand wall and an on-sale grid.
- **Showcase landing** shows its collection links as a tab strip starting with "All", and one row of real option or attribute values from the listing facets (`facet-value-chips`). The editor can hide either row. Its home opens on the offer: hero, delivery facts, products, then the story, highlights, quotes, FAQ and an order banner.
- **Heritage editorial** and **Fashion value** start with one purchase button on the product page.
- **Card minimums** are grid minimums, not the measured card widths: an auto-fill grid stretches cards, and two cards must fit a 360 px phone. `dense` shares compact's type scale (the 14 px phone floor) and uses a 12 px desktop gap, so columns never drop when the page gutter grows at 1024 px.
- **Containers** add `1440` (Mass retail's) to the measured 1200, 1290, 1360 and `full`.

## Changing the contract

1. To add a block variant, add a registry entry (strict settings, defaults, `requires`, `fallback`, `contrastPairs`, `renders`) and a storefront renderer. `matrix.test.ts` covers the new variant against every other block, palette and density. To add a section type, add a registry entry (strict settings, defaults, `requires`), its data reads in `home-data.ts`, its renderer and its type in `STOREFRONT_SECTION_RENDERERS`.
2. To change a section's settings incompatibly, bump that entry's `version`. An optional field (the hero's `sideBanners`) keeps stored sections valid without one.
3. For any other shape change, bump `STOREFRONT_THEME_DOCUMENT_VERSION`, add one upgrade step from the previous version in `upgrade.ts` and capture the previous version's golden fixture. Never reset older stored themes. A bump needs no reset migration, because reads upgrade in memory.
4. Add a label for every new setting in `apps/admin-v2/src/i18n/theme-settings.ts`.
5. Run `pnpm generate:sdk` after any change to the document schema, because the API contract embeds it.
6. Release the API and the storefront together. An older storefront cannot read a future document. Unknown store-shape keys still fail closed to fit fallbacks.

`pnpm fidelity:check` measures the built storefront against the reference sites for every template.

## Palettes

A template chooses one palette. Merchants recolour it with six colour roles. A palette has one ink, one restrained brand colour, neutrals tinted toward the palette's hue (never raw grey on a warm page), surfaces and semantic tones. Every palette passes every AA pair and the helper-versus-error rule (tested). A card surface uses a border or a shadow, never both. The values are in `STOREFRONT_THEME_PALETTES` (`tokens.ts`).

| Palette | Used by | Reference | Idea |
|---|---|---|---|
| `retail` | department-mall, rounded-tech, showcase-landing | Shopify Horizon and Dawn, Allbirds, Game Ghor | White page, charcoal ink and buttons. Sand neutrals carry the warmth. |
| `marketplace` | spec-catalogue, mass-retail | Target, Daraz | White page, near-black ink, cool neutral panels, one saturated orange for buying. |
| `marketplaceAmazon` | marketplace | Amazon | The marketplace purchase hierarchy with its own ink (#1c2530), terracotta (#b84724) and warm gold (#f1c65a). |
| `boutique` | boutique | COS, Aesop, Ssense | Linen page, espresso ink, no colour. Type and space carry the hierarchy. |
| `fresh` | daily-essentials | Instacart, Chaldal, Ocado | White with a leaf green for buying and green-tinted panels. |
| `beauty` | fashion-value | Glossier, Sephora | Black type and buttons on white. A blush accent on surfaces, never on text. |
| `heritage` | heritage-editorial | Aarong, Fabindia, Anthropologie | Hand-made paper, umber ink, madder terracotta actions. |
| `midnight` | no template | Apple, Nothing, Linear | Layered near-blacks, white ink and buttons, soft zinc for helper text. |

## Typography

The font families are Google Fonts, self-hosted by the storefront (`STOREFRONT_FONTS`, `apps/storefront/src/lib/theme-fonts.ts`). Each Latin face carries a Latin `unicode-range`, so Bangla text falls through to the pairing's Bengali family (Noto Sans, Noto Serif or Hind Siliguri). A metric-matched fallback face (`<Family> Fallback`, with size-adjust and ascent and descent overrides) keeps the swap from shifting layout. The storefront preloads only the heading face's Latin subset.

The dashboard's Typography card draws each pairing in the same files under `Preview <Family>` names, registered only when the picker opens (`apps/admin-v2/src/components/admin/online-store/type-preview-fonts.ts`). Both files are keyed by the same font keys, so a new family fails the type check until both have its file.

| Pairing | Heading | Body | Bangla |
|---|---|---|---|
| retail | Inter | Inter | Noto Sans Bengali |
| market | Inter | Inter | Hind Siliguri |
| editorial | Instrument Serif | Inter | Noto Serif Bengali |
| fresh | Nunito Sans | Nunito Sans | Hind Siliguri |
| beauty | DM Serif Display | DM Sans | Noto Sans Bengali |
| heritage | Cormorant Garamond | Inter | Noto Serif Bengali |
| tech | Inter | Inter | Noto Sans Bengali |

Each pairing also sets the heading weight, tracking and leading, the body leading and the uppercase label tracking (`STOREFRONT_TYPE_PAIRING_SPECS`).

## Craft

- **Motion:** 180 ms ease-out for hover, press and reveal. None under `prefers-reduced-motion`.
- **Images:** one aspect per store (`imageRatio`). A card photo zooms 1.03 on hover, or fades to the second photo where the card shows one.
- **Buttons:** square, the theme radius or pill (`buttonShape`). A pressed button scales to 0.98.
- **Surfaces:** flat, hairline or raised (`surface`).
- **Skeletons:** loading states mirror the final layout (the same aspect ratios and rows).
