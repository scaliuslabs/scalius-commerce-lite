# Storefront theme document (version 10)

One JSON document describes how the storefront looks: the template label, tokens, brand, one variant per block with its settings, the homepage sections, up to 20 landing pages, the sections of the product, listing, cart and CMS page templates and what `/` shows. The dashboard drafts, previews, publishes (atomically) and restores it. An agent can write it through the API, and installed apps add sections and product blocks. The storefront and the dashboard resolve it against the store with the same function. This file is the contract for contributors and coding agents.

Store identity (name, phone, email, address, social profiles) is not in the theme. The business document (Settings > Store details) owns it, and every buyer surface reads it only from there.

Source of truth: `packages/shared/src/storefront-theme/*.ts`, re-exported as `@scalius/shared/storefront-theme`. `document.ts` holds the schema, `upgrade.ts` the read entry point and the upgrade chain, and `compat.test.ts` the compatibility gate. The registries are `blocks.ts` (block variants) and `sections.ts` (20 section types), and `apps.ts` holds the sections and product blocks that installed apps draw (`<plugin id>/<type>`). `tokens.ts` and `contrast.ts` hold the tokens, the 19 colour keys and the AA pairs. `fit.ts` (`StoreShape`) and `resolve.ts` (`resolveStorefrontTheme(document, storeShape)`) fit a document to a store. `templates.ts` holds the 5 presets and `DEFAULT_STOREFRONT_THEME`. `content.ts`, `home-data.ts`, `pages.ts`, `preview.ts` (the editor's preview bodies) and `compare.ts` (`compareThemeDocuments`, the typed changes stored with each version) hold the rest.

## Shape

```jsonc
{
  "version": 10,                       // literal; a new shape means a new version
  "template": "department-mall",       // the template it is based on: a label, never read for behaviour
  "tokens": {
    "colors": { "<19 keys>": "#rrggbb" },
    "typography", "typeScale", "headingCase", "density", "radius",
    "buttonShape", "surface", "imageRatio", "imageFit", "headerTone", "container"
  },                                   // token values: tokens.ts
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
      "surface", "band", "phoneBar", "links", "phoneBanner", "maxColumns"
    },
    "product": { "gallery", "buyBox", "below": [], "apps"?: [], "sticky": { "phoneTop", "phoneBottom", "desktop" } },
    "footer"                           // every variant: { tagline, about, copyright } (+ directory's style)
  },
  "apps"?: {                           // app storefront components (packages/plugin-sdk/docs/storefront.md); optional
    "header"?, "footer"?, "productCard"?: { "app": "<plugin id>/<slot id>", "values": {} },
    "template"?: "<plugin id>/<template id>"  // the app template the look came from: a label
  },
  "pages": {
    "home": [{ "id", "type", "version", "settings", "hidden"?, "aiDraft"? }],  // a block item may carry "hidden": true
    "homeMode": { "kind": "sections" }, // or { "kind": "product", "productId" }
    "landing": { "<slug>": { "title", "description", "sections": [], "noIndex"?, "excludeFromSitemap"? } },
    "templates": {                     // product | collection (category, collection, brand) | cart | page (CMS)
      "<kind>": { "sections": [], "main": 0 }  // main: the fixed part's place among the sections
    }
  },
  "translations"?: [                   // the theme's words in other languages; optional (Compatibility)
    { "locale": "bn", "marketId": null, "fields": { "<source words>": "<translation>" } }
  ]
}
```

## Rules

### Content, brand and what `/` shows

- **One draft for the look.** A save writes the draft only. A preview renders the draft. A publish makes all of it live at once. A version restores all of it. Header and footer menus stay navigation menus with their own publish. The theme only chooses where their links come from (`blocks.navigation`).
- **Announcement and footer words.** The `topBar` variant is the only switch for the announcement: `none` is off. The other three variants carry `text` (160 characters at most) and an optional `link`. Every footer variant carries `tagline` (160), `about` (1,000; plain text, a blank line between paragraphs) and `copyright` (120; the name after "©"). An empty `copyright` shows the store name.
- **Brand.** `brand.logo`, `brand.footerLogo` and `brand.favicon` are media ids. `null` shows the store name in text, or the platform tab icon. `brand.logoWidth` is the header logo width on computers (80 to 240 px, steps of 10; phones cap it at 160 px). A preview resolves the draft's own images (`POST /api/v1/storefront/theme-preview/resolve` returns `brand`).
- **Saves check what the document names.** A save rejects a media id that is not a ready or trashed image in Files, and a product home mode whose product is gone or in trash. Each error names its document path (`brand.logo`, `pages.home.2.settings.slides.0.image`). A link is a canonical, navigation-safe href: a same-store path, a `?query`, a `#fragment` or an https URL. Files refuses to delete an image that the published theme or the draft still shows.
- **Content survives a template.** Choosing a template copies its look and keeps the merchant's content (`storefrontThemeWithContent`): the brand, the home mode, the landing pages, the announcement and footer words where the new variants carry them, each hero's slides and side banners, and the category tiles' and collections' picks. Picks go to the first section of the same type, then the second. "Matches a template" compares looks only (`storefrontThemeLook`). Switching a block variant, and a resolver fit fallback, keeps the settings both variants declare (`storefrontBlockSwitch`).
- **What `/` shows.** `pages.homeMode` is `sections`, or `product` with a `productId`. While that product is public (the homepage read returns it as `sections.homeProduct`), `/` answers 302 to the product page. That page keeps its canonical URL and SEO and never redirects back. A product that stops being public leaves `/` on the sections. A preview follows the draft's mode.
- **The template is a label.** `template` feeds the dashboard's "based on" line and its reset-to-template defaults. No storefront component and not the resolver read it for behaviour: every behaviour is a block variant, a setting or a token, so blocks from any template mix freely. `apps/storefront/src/lib/theme-contract-consumers.test.ts` fails when a component branches on the template, or when an enum value has no consumer. A choice with no renderer is removed.
- **Per-resource overrides.** `products.page_template` names a preset (or `classic`, the Department product page); an id that names no preset uses the store's theme. The product page then uses that template's `blocks.product` and keeps the store's own header, footer, tokens and card. `categories`, `collections` and `brands` have `listing_template`: a listing layout or a filter style. It replaces the theme's own for that listing when the store fits it (`catalogListingPresentation`). `null` uses the theme.
- **Strict writes, upgraded reads.** Writes accept only the current version, known keys and valid registry settings. A stored read upgrades an older document through the upgrade chain, then applies the same strict schema (see Compatibility). A document that does not upgrade or validate fails closed: the dashboard reports it unreadable and the storefront renders the default theme.

### Tokens, cards and contrast

- **Tokens are global; blocks choose structure.** A variant never carries its own colour, type size, radius or elevation, so any mix of variants stays coherent ("Scalius Base": one design system, not looks copied from other sites). The scales: spacing in 4px steps (`STOREFRONT_SPACE_SCALE`), one type scale of about 1.2 (`STOREFRONT_TYPE_STEPS`, 12 to 48 px), gutters 16/24/32 (`STOREFRONT_GUTTERS`), surface padding 12/16, elevation flat/hairline/raised (`STOREFRONT_ELEVATION`: a border or a shadow, never both), motion 150/250 ms (`STOREFRONT_MOTION_MS`). Colour roles beyond the palette: `theme-sale` (the error colour, for discounted prices and the sale badge only), `theme-rating` and `theme-success`. The storefront primitives that draw with them are in `apps/storefront/src/components/ui` (README.md).
- **Readable text.** Every pair in `STOREFRONT_THEME_TEXT_PAIRS`, plus the `contrastPairs` of every chosen variant and of every variant it can fall back to, must reach WCAG AA (4.5:1). The header roles (`header-background`, `header-foreground`) follow `headerTone`: `dark` takes the darker of ink and page, `brand` takes the action colour. A write that breaks a pair is rejected. `muted-foreground` must also be near-neutral (Lab chroma 25 or less) and at least 40 CIE76 units from `destructive`, so helper text never looks like an error.
- **Colours.** Every colour a block paints is a theme token. The footer tones re-point the footer's surface tokens to an AA pair. The banded `directory` footer uses the header tone with two derived bands, `theme-header-raised` (at most 14% toward the header text, never below AA) and `theme-header-deep`. Stars and review bars use `theme-rating`, always beside the rating number in text.
- **Cards.** One card per store (`standard`). Its photo ratio and fit, radius and surface are the tokens; its type is the system's (title 14/500 in two lines, price 16/600, the sale colour only while discounted, the struck regular price after it). Density owns the grid (card minimum, gaps). Three settings vary it:
  - `facts`: `none`, `key-specs` (two on phones, three from 640 px), `swatches` (the colour axis, at most 5 and "+N") or `delivery`. Each renders only when the product has the data: no zero states. A rating shows on every card once the product has a published review; pack size and condition show when present.
  - `action`: `none`, `quick-add` (a round add button on the photo for a product that needs no buyer input: no options, customization or gift card, in stock, a fixed positive price; a chevron hint for products with options) or `full` (a button under the price on every card: Add to cart, Choose options or View product). Simple products add to the cart in place; anything else opens its page.
  - `hoverImage`: the second photo fades in on hover.
  - One discount mark: the sale badge on the photo (or Sold out). The body never repeats it. Rows in a grid stretch to equal height, with the price and action at the bottom.
  - `blocks.card.fields` optionally names up to three storefront-visible product custom fields (`custom.care`, `vendor.app.points`). Listing, home and app-section card reads return these in `fields`; one statement shares each existing card wave, and unused fields add no statement. Card skins receive the same typed values.
  - The facts are each product's `cardFacts` (`packages/core/src/modules/catalog/card-facts.ts`): one bounded statement batched with the card media, so no page gains a D1 round trip. A card never shows an original upload that has no renditions: it shows the placeholder while the render job runs.

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

  `productCount`, `skuCount`, `hasCollections`, `hasDeliveryMethods` and the header menu counts complete the shape. A core test fails when a `requires` names a fact the statement does not produce.

### Navigation

`blocks.navigation` is shared by every header surface.

- `source` is `menu`, `category-tree` (published roots with public products and their published descendants, 4 levels at most) or `tree+menu` (the roots in tree order, then the menu's other top items). In `tree+menu`, an item whose target is already present merges into it and keeps the first position and the menu's label.
- `maxTopItems` (1 to 18) caps the top entries of a row, rail or drawer root. The rest go behind "More" or "All categories". `linkBudget` (20 to 150) caps the anchors of all header surfaces together, clones included.
- A tree source on a store without a public root renders the menu. A menu source without a menu renders the tree (`resolved.blocks.navigation`, with a `navigation` fallback).

### Listing

One listing block serves category, collection, brand and search pages. The editor shows it as those pages' blocks.

- **Layout.** `grid`, `list`, `shelves` (one shelf per sub-category or collection, at most 8; needs category depth 2 or a collection, else `grid`) and `quick-grid` (a denser grid). Shelves show only on the plain first page: no search, refinement, sort or later page.
- **Starting views.** `searchLayout` sets how search results start and `phoneLayout` sets the phone view. The buyer's grid/list switch (`grid-list-toggle`) is stored in the browser, separately for browsing and for searching. `paging` is `numbered`, `load-more` or `infinite`. The last two keep crawlable `?page=n` links.
- **Description.** `descriptionPlacement` puts a category, collection or brand description `above` the results (clamped to two lines with "Read more") or `below`. The merchant's buying guide always renders below the results.
- **Filter styles.** `filters.style` places the facets: `sidebar-dense` (a 240 px column), `sidebar-comfortable` (270 px), `bar-dropdowns` (up to 4 facet dropdowns in a bar, the rest in a drawer) and `drawer` (a Filter button and a drawer). On phones every style opens the facets from a Filter button in a sheet. `openByDefault` opens the facet groups (never for `bar-dropdowns`). A template may set `column` (180 to 340 px), `rowPitch` (24 to 36 px) and `label` (12 to 18 px) over the style's numbers. A facet shows 10 values in the HTML. "See more" fetches the rest.
- **Filter order and placement.** `order` reorders whole groups (unset keeps the style's arrangement). `searchPlacement: drawer` moves a sidebar's facets into the drawer on search, so the results take the width (up to five columns). `ruled` draws a sidebar's groups as one flat, ruled list that scrolls on its own. A sidebar stays sticky on computers (from 1024 px).
- **Small catalogues.** Filters need 8 results and a facet with two values, unless the buyer already refined (`storefrontListingFiltersShown`). A store with fewer than 8 products resolves `shown: false`. Sort needs two results.
- **Toolbar pieces.** The pieces are in `blocks.ts`. A piece without data is left out: `subcategory-pills` needs category depth 2 and `popular-filter-chips` needs key specs. `facet-value-chips` shows one row of 2 to 8 values of the first option or attribute facet. The editor has a switch for every piece except `popular-filter-chips` and `aspect-chips`, which follow the layout.
- **Page chrome.** Template data sets `surface`, `phoneBar` (`standard`, `pill-row` or `split-sheet`; the bottom bar was dropped), `links` (`chips`, or a `tabs` strip that starts with "All"; not on search), `phoneBanner` and `maxColumns` (3 to 6 or `null`). `band` is `standard`, `inline` (needs the bar placement) or `beside-filters` (needs a sidebar). Otherwise `standard` renders.

### Product page

`blocks.product` is the page template for every product. A product's `page_template` can swap it (see above).

- **Gallery.** `classic`, `thumbs-below`, `thumbs-left` (`phoneSideThumbnails` keeps the rail beside phone photos), `stacked`, `portrait` and `image-grid`. `stacked` and `image-grid` keep their details column sticky by layout. No preset defaults to `stacked` (many photos would push the buy box down). The stage adapts to the first photo's stored size between 2:3 and 16:9 (`galleryStageRatio`); only `portrait` states its own 3:4 stage, and a photo of unknown size takes the theme's photo ratio.
- **Buy box.** Two variants. `classic` takes `cta` (`row` or `stack`, full width on phones), `features` (key features under the title), `details` (the description tabs in the buy box, or the description module below), `emi` (shown only when the store has EMI plans) and `whatsapp` (call and WhatsApp links, shown only when the store has a number). Its type scale, button height and shape come from the theme tokens. `marketplace-3col` adds a facts column from 1280px wide (below that it reads as classic).
- **Modules.** `below` lists the modules in page order. Each renders only when this product has its data, from reads the page already makes. Rules: `key-attributes` shows at most 8 key-spec rows and needs key specs in the store, as does `compare-similar`. `key-attributes` shows above a spec table that lists more rows, and not beside the marketplace facts column. `about-bullets` is left out when the buy box already lists the features. `spec-table` never shows a brand as a row. `reviews` carries "Write a review" in its zero state. `recently-viewed` is this browser's own list, filled before paint, and shows nothing without JavaScript.
- **Sticky bars.** At most one at the top and one at the bottom on phones. `phoneBottom: buy-bar` and `desktop: product-bar` show the price and Add to cart once the buy buttons scroll away.
- **App blocks.** `blocks.product.apps` lists blocks that installed apps draw (`{ id, app, values }`, at most 10, in the merchant's order). Each renders in the buy box or after the modules, as its app declares.

### Sections, landing pages and apps

- **Registry.** Each `type` is an entry in `STOREFRONT_SECTION_REGISTRY` with its own `version` and strict settings. There are 20 types (`hero`, `product_rail`, `category_tiles`, `editorial`, `faq`, `newsletter` and more: `sections.ts`). An app section has type `app` (`settings.app` is `<plugin id>/<type>`). Sections are optional, repeatable and reorderable. Ids are unique. A page holds at most 24. A hidden section (`hidden: true`) stays saved and media-validated but makes no public reads.
- **Renderers.** `STOREFRONT_SECTION_RENDERERS` lists the types the storefront renders: one component each under `apps/storefront/src/components/homepage/`. An app section that is gone, inactive or no longer declared renders nothing.
- **Sections without data.** A section without data renders nothing, with no placeholder. `storefrontSectionNeedsContent` flags a section whose own settings leave nothing to show, and the dashboard shows the flag. Examples are a hero without a slide whose image resolves, category tiles with fewer public categories than their style needs, and an empty testimonial list or FAQ. Templates ship the story, highlights, quotes and FAQ sections empty, so they stay hidden until the merchant fills them in. A collections section without a collection that has products shows the newest products. The storefront reads shipping and checkout facts only when a `usp_strip` section shows them (`homeSectionsShowDeliveryFacts`).
- **Hero slides.** A hero has at most 10 slides. A slide has a computer image and an optional `phoneImage`, each with a focal point (`phoneFocalPoint` falls back to `focalPoint`). It also has alt text (never drawn over the image) and an optional link, and the button shows only with a link. `sideBanners` (at most 2) show only with `contained-banners`.
- **Newsletter.** The signup form asks for the phone always and the e-mail as `optional`, `required` or `hidden`. It posts to the storefront's `/api/newsletter/subscribe` and works without JavaScript (`apps/storefront/src/lib/newsletter-server.ts`). It reads no data, so it always renders. The `newsletter-grey` footer carries the same form, left out on a page that already shows one.
- **Home data.** `homeSectionRequests(home, homeMode)` derives what the page reads, so callers never name reads. The limits are 8 product lists of 36, 40 images, 24 category tiles, 8 collections, 4 deal promotions and 24 app sections (component sections, drawn at the edge). The homepage batch part serves them for the published theme (a fixed read that rejects any query string). A preview reads the saved draft's sections on the private, never-cached, token-verified `POST /api/v1/storefront/theme-preview/homepage`.
- **Landing pages.** `pages.landing` holds at most 20 pages at `/pages/<slug>`. A handle is one lowercase CMS-style segment that is not a reserved route and not `pages`. A page has a `title` (120), a `description` (320) and its own sections (same registry and 24 cap as home). `noIndex` keeps it public with `noindex,follow` and out of the sitemap, and `excludeFromSitemap` only leaves it out of the sitemap. It renders from the same single batch as home (the layout plus `GET /api/v1/storefront/landing/<slug>`). Its canonical is always the absolute `/pages/<slug>` address. The pages sitemap lists the live theme's landing pages without a lastmod.
- **Page templates.** `pages.templates` gives the product, listing (category, collection, brand), cart and CMS pages their own sections (same registry and 24 cap) around a fixed part: the product information, the listing, the cart or the page content. `main` is the fixed part's place in the list. The fixed part can move but is never removed. Its own structure stays `blocks.product` or `blocks.listing`. A template without sections reads nothing: the page's batch stays as it was. A template with sections reads them after the batch, once the theme is known (`GET /api/v1/storefront/template/<kind>`, market keyed): one read only for stores that use them. Search has no template.
- **Blocks.** `STOREFRONT_SECTION_BLOCKS` names each section type's block lists (slides, side banners, points, tabs, cards, tiles, columns, quotes, questions, link cards). A block item with `hidden: true` stays saved but buyers do not see it: `storefrontVisibleSection` removes hidden blocks before the resolver and the data planner, so a hidden slide reads no image.
- **App components and skins.** An app with a storefront module (packages/plugin-sdk/docs/storefront.md) adds component sections (an `app` section whose type the module draws, no route) and **skins**: app markup for a core-owned unit. `apps.skins` maps the units `header`, `footer`, `product_card`, `product_main` and `listing_main` to `{ app: "<plugin id>/<skin id>", values }`; a core section placement takes its own `skin` (target `section:<type>`, `STOREFRONT_SKINNABLE_SECTION_TYPES`). Core is the fallback: a skin whose app is gone, inactive, not approved for storefront code, failing or drawing nothing leaves the unit to core (the blocks the document chooses, or the core section). A skin gets the unit's projection: for a core section, its sealed projection (`StorefrontSectionSkinSettings[type]`, mapped by `coreSectionSkinSettings`; see Compatibility), so it reads nothing more. Component section settings may use `image`, `products`, `product`, `link` and `list`; their images and product lists join the page's data batch (`readAppComponentData`); skin settings name no images or products. An app's `storefront.templates` appear in the template library once upgraded from their `themeVersion` (Compatibility); applying one (`applyStorefrontAppTemplate`) sets its tokens, blocks and `apps` and makes its sections the homepage's; the brand, landing pages and page templates stay, and a homepage section whose id the template reuses keeps the merchant's values. `apps` is optional, so documents without it are unchanged.
- **Specifications.** A `specifications` section renders labelled `rows` as a definition list, omitting blank rows. Connect `rows.0.value` to `resource.cf.<namespace>.<key>` to use the current product’s public custom field; the literal remains the fallback. Its core Astro renderer and Noor skin take the same `StorefrontSpecificationsSkinSettings` projection and make no data reads.
- **Section content.** `shop_by` cards may carry a `subtitle`; `deal_block` and `newsletter` may carry a `mediaId`. Their media joins the existing page batch, validates on save and clears on a missing-image restore. Core renderers and section skins receive the same fields; hero headings remain per slide.
- **AI drafts.** A section with `aiDraft: true` came from an AI and nobody opened it yet. It renders like any section. The editor removes the mark when someone opens the section, and the publish summary warns about marked sections (it does not block).

## Draft, preview, publish and versions

Dynamic sources live beside a placement's literal settings as `bindings: { "heading": { "source": "resource.cf.custom.subtitle" } }` (20 per placement). Core section items, app sections, skins and product app blocks use the same contract. `bindings.ts` owns parsing, compatibility and safe resolution; the shared theme writer checks live public definitions and target schemas before saving or publishing. Missing sources and values outside a target setting's schema keep the literal value. The editor's Connect picker lists compatible public fields and published objects; connections on list items follow moves and duplication.

Resource words, images and safe reference links use the page part already read. Object sources share the page's object planner and its four-type bound; app product sources resolve before the existing card reads. Optional `blocks.card.fields` names at most three public product fields and adds one field statement to the existing card wave only when used.

The service is `packages/core/src/modules/settings/site-settings.service.ts`. The rows are `theme_settings` (live), `theme_settings_drafts` (the one shared draft) and `theme_settings_versions` (immutable published versions).

- **One shared draft per store.** Every write is one guarded D1 batch on revisions. The draft revision only grows. Save, page edit, restore, discard and publish each carry the revisions they read. A stale revision answers 409.
- **Restore and discard replace the draft only.** Publish is the one way anything goes live. Each restore and discard first keeps the draft it replaces as a restore point (`theme_restore_points`, the newest 10, in the same batch), so either can be undone. Restoring a restore point keeps one of the draft it replaces too. One batch writes the live row, a version row and the rebased draft, and prunes history to the newest 20 versions.
- **Version rows.** A row holds `{ meta: { changes, moreChanges, note }, theme }`. `changes` has at most 20 typed entries, `note` at most 500 characters, and a document at most 512 KiB.
- **Missing images.** A version that names images deleted from Files since is refused with `theme_version_images_missing` (`details.missingImages`). Restoring it with `withoutMissingImages` leaves out the slides, cards and tiles that showed one and empties single images.
- **Preview.** `POST /api/v1/admin/settings/theme/preview-session` mints a one-time continuation code (`tpc_`, valid 5 minutes) for the saved draft or one published version. The browser posts it to the storefront `/theme-preview/continue` (`/theme-preview/embed` in the editor frame). The storefront exchanges it for a `tpv_` token in the HttpOnly cookie `stp_theme_preview` (valid 30 minutes). The database stores only the SHA-256 of each token. The session stores no theme: every preview read resolves the saved draft or version as it is then. A pruned version stops previewing. Preview needs a valid HTTPS Storefront URL in the Platform settings (Settings > Store details > Web addresses).
- **Permissions.** Reads need `settings.general.view`. Writes need `settings.general.edit`. Staff with view only open the editor read-only.

## Editor

Online store > Theme (`/admin/online-store/theme`) shows the current theme, whether its draft has unpublished changes and who published last, with Customize, Preview and Publish, and the template library below. Choosing a template restyles the draft and keeps the merchant's content. Customize opens the editor at `/admin/online-store/theme/editor` (a lazy route; the code is in `apps/admin-v2/src/components/admin/online-store/theme-editor/`).

- **Layout.** A 48 px top bar: back, the theme's state with one autosave status, the page switcher, the previewed market and language, the device (desktop: fit to the window at 100% by default, or 1280, 1440 or 1920 px scaled to fit; phone at 390 px), undo, redo, history and Publish. A 320 px sidebar has two tabs: the page's layers and Theme settings. From 1600 px the selection's settings are in a right column that is always there (with a close button); below, they replace the tree at once. Below 1024 px the sidebar is a drawer, below 768 px a bottom sheet with a bottom bar. `\` shows or hides the sidebar. The editor opens with nothing selected.
- **The canvas.** The storefront lays out at the frame's width (`canvas-geometry.ts`). The frame's box depends only on the canvas size, the device, the width and the zoom. Selecting, hovering, saving or opening a panel never moves it (`ThemeEditor.test.tsx`, "the frame never moves"). Hover and selection are drawn in an overlay above the frame from rectangles the page reports: a dashed outline with a name, or a solid outline with its name and a toolbar (move, duplicate, hide, remove) inside its top edge, so they never cover the store's header, and "+" on both edges. A part without actions shows no toolbar. A click selects and never scrolls. Shared parts (announcement, header, footer) show in a separate colour.
- **Layers.** One WAI-ARIA tree per group (shared header parts, the page, shared footer parts). Arrow keys move, Enter opens, Alt+↑/↓ moves a row, and every row also has move buttons. A section opens its blocks below it. A template's fixed part moves with the sections but has no remove action.
- **Library.** Add section opens the library: search, categories, a sketch of each section in the store's colours, the reason a section cannot be added here, and app sections with an App badge and "Manage app".
- **Saving.** Edits autosave 800 ms after the last one, against the draft revision. An invalid field holds back only its own part (`saveable-draft.ts`): the rest keeps saving and the status says what is held. Undo and redo (Ctrl/Cmd+Z, Shift+Z) survive autosave. Ctrl/Cmd+S saves now. A conflict keeps the edits and names who saved; reload or overwrite. Ctrl/Cmd+/ lists the shortcuts.
- **History and publish.** History lists the published versions and the restore points; each can be previewed and restored. Publish shows what goes live by page, marks store-wide settings and warns about unopened AI drafts.
- **Theme settings.** Six colours (background, text, buttons, button text, highlight, highlight text) each write every token of their role and show the readable-text problems they cause. Typography, brand images, logo width and product cards have their own settings.
- **Generated forms.** Section and block settings forms come from the registry's zod schemas (`apps/admin-v2/src/components/admin/online-store/schema-form/`). A block list is edited as rows of the tree, never inside its section's form. A new setting needs a label in `apps/admin-v2/src/i18n/theme-settings.ts` (English and Bangla) and no form code.
- **Market and language.** The top bar previews the page in any market presence (`/<presence>/...`). The editor edits the theme's words in the default language; their translations (`translations`, Compatibility) are written through the API (`draft_save`) for now, and the Languages notice says so and links to Settings > Languages. A preview shows the source words.

### Live preview

The editor shows each edit in the frame before it is saved, without a page load:

| Edit | What the frame does |
|---|---|
| A colour or other token | Sets the CSS custom properties at once, then repaints from `POST /theme-preview/paint` (fonts and body attributes). |
| Typing in a text setting | Replaces the text in place, then draws the section again. |
| Move or hide a section | Moves or hides the rendered units in the page at once. |
| Add a section, or show one the page did not draw | Draws the page's regions again from `POST /theme-preview/render`. |
| Any other section setting | Draws that section again from `POST /theme-preview/render`, 90 ms after the last edit. |
| Header, footer, product modules, card settings | Saves at once, then loads the page again in a hidden second frame and swaps it in when ready. |

- **Bridge.** `@scalius/shared/theme-editor-bridge` is the message contract. The storefront side is the inline script in `apps/storefront/src/lib/theme-preview-bridge.ts`, present only on a page that rendered a valid preview. Both sides check the other's exact origin and window.
- **No lost edits.** Every command carries a `seq`, and the page answers `ack` once it applied it (a render or paint: once it landed or failed). The editor keeps the newest command of each kind (per section or region) until its ack arrives. It sends them again when the shown frame connects (a navigation, a reload swap) and when an ack is late (600 ms; 3 s for a render or paint). After five unanswered sends it loads the page again. While a command waits, the canvas says "Updating preview". Each frame keeps one ref callback for its life (`use-preview.ts`), so re-renders never detach it (`use-preview.test.tsx`).
- **Preview routes.** `/theme-preview/render` and `/theme-preview/paint` are storefront POST routes (`theme-preview-post.ts`). They accept a same-origin JSON body only with a valid preview cookie, validate it with `storefrontPreviewRenderSchema` or `storefrontPreviewPaintSchema` (an unsaved document, never stored), answer `no-store`, and never enter a cache. Their reads go through the private preview API read, so the buyer DVC caches never see draft data.
- **Session.** The frame is a normal preview session redeemed by `/theme-preview/embed`: the code arrives by `postMessage` and the cookie is `SameSite=None; Partitioned`. Only a preview page carries the editor marks, the bridge and a `frame-ancestors` that names the dashboard origin. A buyer's page is byte-identical with or without the editor (`theme-editor-preview.render.test.ts`).

### Draft with AI

Scalius has no built-in AI and keeps no model key. The AI port (`@scalius/shared/plugins/providers`, kind `ai`) is the platform's one general AI port: one operation, `generate`, takes host instructions, the merchant's words, a locale and a JSON Schema, and returns one value. The contract is versioned (`AI_PORT_VERSION`). An app provides it with the store's own key. Core calls it only through `generateStructured` (`packages/core/src/integrations/ai-generate.ts`): one attempt (no retries), a 30 s timeout, the caller's cancellation, an answer of at most 256 KB, validation against the caller's schema, and failure logs with masked metadata only (never the prompt or the answer).

The theme editor is the first consumer (`purpose: "theme.sections"`). `POST /theme/ai-draft` sends the section types' settings schemas, then checks every returned section against the theme's own schemas: an invalid one never reaches the draft. Accepted sections arrive as unsaved edits marked `aiDraft`. A failure shows one message in the dialog; the editor stays usable. The dialog's code and the provider list load only when someone opens it. Without an AI app it explains the two ways to get AI: install an AI app, or connect an agent (Settings > Integrations > AI & app access), which drafts with `draft_sections`. Product descriptions, SEO fields, alt text, inbox replies and analytics questions are planned on the same port, and the `translation` kind is to fold into it. A first-party AI app is a planned paid plugin (later).

## API and agents

The routes are in `apps/api/src/routes/admin/settings/site.ts` and `theme-builder.ts` under `/api/v1/admin/settings/theme/`. Their operation ids start with `dashboard.theme.`.

| Operation | Route | Notes |
|---|---|---|
| `editor_get` | `GET /editor` | The editor's bundle. Not an agent operation. |
| `workspace_get` | `GET /workspace` | Revisions, last publication and the landing pages. |
| `document_get` | `GET /document?source=draft\|published\|version` | One whole document (`revision` with `version`). Agents get it as an authenticated JSON artifact. |
| `versions_list` | `GET /versions` | Five versions per page, newest first. |
| `draft_save` | `POST /draft` | The whole document. |
| `page_draft_update` | `POST /page-draft` | The homepage sections or one landing page (`null` removes it). |
| `version_restore` | `POST /restore` | Puts a version in the draft. |
| `draft_discard` | `POST /discard` | The draft becomes the live theme again. |
| `publish` | `POST /publish` | The exact saved draft revision, with an optional note. |
| `preview_session_create` | `POST /preview-session` | A browser continuation for an agent. |
| `draft_snapshots_list` | `GET /restore-points` | The restore points, newest first. Read one with `document_get` (`source=restore-point&id=`). |
| `draft_snapshot_restore` | `POST /restore-point` | Puts a restore point back in the draft. |
| `draft_sections` | `POST /draft-sections` | An agent's drafted sections, validated and marked `aiDraft`, added to one page of the draft. |
| `ai_draft_create` | `POST /ai-draft` | Sections from an app's AI provider. Saves nothing. Not an agent operation. |
| `ai_providers_list` | `GET /ai-providers` | The active apps' AI providers. |

The commands answer revision receipts only. The curated workflow `theme.draft-landing-page.v1` drafts one landing page and verifies it through `workspace_get`. It never publishes.

The OpenAPI contract states shared shapes once as named components (`StorefrontThemeDocument`, `StorefrontSectionList`, `StorefrontLandingPage`, `StorefrontHomepageSections`, `ErrorResponse`). Write a nullable use of a named schema as `z.union([Named, z.null()])`, because `.nullable()` would make the component itself nullable (`apps/api/src/openapi/component-schema-refs.test.ts`).

## Templates

`templates.ts` holds every preset's data: header, menus, card settings, listing and filter style, gallery, buy box, footer, tokens, top bar, navigation source, product modules, sticky bars and a starting homepage. A preset is a combination of tokens and block choices, never a look of its own.

The presets are `department-mall` (Department, the default), `boutique`, `marketplace`, `daily-essentials` (Essentials) and `showcase-landing` (Landing).  The dashboard's template library describes each one (`template_<id>Help` in `apps/admin-v2/src/i18n/online-store.ts`).

- **Department** is the default: every store with no saved theme renders it (`DEFAULT_STOREFRONT_THEME`). It keeps the `classic` gallery with the `mall` buy box, hairline cards with an Add to cart button, a mega menu and a department search in a 1200 px container, with departments from the tree (`tree+menu`).
- **Landing** shows its collection links as a tab strip starting with "All", and one row of real option or attribute values from the listing facets (`facet-value-chips`). The editor can hide either row.
- **Card minimums** are grid minimums: an auto-fill grid stretches cards, and two cards must fit a 360 px phone. `dense` shares compact's type scale (the 14 px phone floor).

## Compatibility

Version 10 is the version the v2 core locks. From here a stored theme is never reset: an older document is upgraded when it is read, and every change to the contract passes a gate.

Version 11 names app surfaces by snake_case keys (the plugin manifest's identifier rule): the 10 → 11 step rewrites every `<plugin id>/<name>` an app section, skin, product block or `apps.template` names with the name's hyphens as underscores (`scalius.noor/noor-header` → `scalius.noor/noor_header`), the name its app now declares.

Version 12 names core identifiers the same way, as the storefront protocol does: the 11 → 12 step rewrites every core section type (`usp-strip` → `usp_strip`, `category-tiles` → `category_tiles`, ...) and every `apps.skins` unit (`product-card` → `product_card`, `product-main`, `listing-main`). Skin targets (`section:usp_strip`) and embed kinds (`buy_form`, `order_form`) follow. Settings values (layouts, styles, source kinds) and product page modules keep their spelling.

- **Upgrade chain.** `upgrade.ts` holds one pure step per document version (`STOREFRONT_THEME_DOCUMENT_UPGRADES[n]`: a version `n` document in, version `n + 1` out) and each section registry entry holds its own steps (`upgrades[n]`: its settings at version `n` in, `n + 1` out). A step reads and writes JSON only (no I/O, no clock) and changes only the parts it finds, because app templates and page presets carry parts of a document. A stored read (`parseStoredStorefrontThemeDocument`) runs the document steps from the stored version to the current one, then the section steps on every section list, then the strict schema. Nothing is written on read: the next save (draft, publish, restore) stores the current version. A document older than `STOREFRONT_THEME_OLDEST_READABLE_VERSION` (10, after the 0155 reset) or newer than the current one, a step that throws, or a result the strict schema rejects reads as unreadable: the dashboard fails closed and the storefront renders the default theme. Writes accept only the current version. SQL that reads a stored row by JSON path (the brand media in `homepage-sections.ts`, the logo in `store-messages.ts`) sees the stored shape, so a step that moves such a path also teaches those reads both shapes.
- **Compatibility gate.** `compat.test.ts` fails the build on an unreviewed change:
  1. Golden stored documents (`compat/v<n>/*.json`, never edited once committed) of every readable version read through the chain. Goldens of the current version also parse with no upgrade, so a change within a version keeps them valid. Together they place every section type and every block variant, so a section change without its own version bump and step fails here.
  2. The chain has a step for every version from the oldest readable one, and a golden for every readable version.
  3. `compat.snapshot.json` records the document's JSON Schema and the section registry (each type's version, settings JSON Schema and translatable text paths); the ABI snapshots seal the skin projections. Accept a change with `vitest run -u` on that file only when it is additive (an optional field, an enum value, a section type). Anything else bumps the document or section version, adds the step and freezes a golden of the old version.
- **App templates and page presets.** A declaration states the document version it was written for (`themeVersion`, absent: 10). Listing runs it through the same chain (its parts as a partial document) and the strict schema. One that still does not fit stays out of the template library, and the app's page reports it with its first problem (App health), instead of hiding it silently.
- **Skin projections.** `storefront-protocol.ts` declares what each core section skin receives (`StorefrontSectionSkinSettings[type]`, versioned by `STOREFRONT_SECTION_SKIN_PROJECTIONS`), sealed in the ABI snapshot. The host maps a core section's settings to its projection in one place (`coreSectionSkinSettings`, `skins.ts`): references resolved, renamed to what they hold (`mediaId` to `image`, `categoryIds` to `categories`, a product `source` to `products`) and editor-only keys (`hidden`, `bindings`) dropped. A compile-time check there fails when a core section's settings stop matching its projection; that type then gets an explicit adapter, so core can evolve its settings while skins keep theirs. A projection only gains optional fields. The SDK exports the projection types, not core's settings types.
- **Translatable text.** The optional `translations` holds rows shaped like the store's translations (`{ locale, marketId, fields }`), keyed by the source text: `fields["Summer sale"]` is its translation. A key follows its words through moves, duplicates and template switches; an edited source shows itself until it is translated again. What is translatable is declared: each section type's text paths (`STOREFRONT_SECTION_TEXT`: headings, body, button labels, alt text, questions and answers), the announcement and footer words (`STOREFRONT_BLOCK_TEXT`), a landing page's title and description, and the `text` and `textarea` settings of app sections, skins and product blocks. A presence read (the layout, and the homepage, landing and template reads) folds its translation context (`translationContextSql`: its locale while its language is published, its market, the default locale) into the theme statement it already runs and declares `tr:locales`; the theme row's own key covers the words, so no statement and no read is added. `translationChain()` orders the rows (`storefrontThemeTextOf`), and `translateStorefrontTheme` replaces the words in place, so every renderer and skin gets translated text from the document it already has: the layout serves the theme translated, skin and product block values included, and the API's app section renderer translates a component section's values (`translatePluginSettingValues`, against the app's schema and within each field's `maxLength`). The served document carries no `translations`. A root read folds nothing and serves the stored words. A save refuses a translation that breaks its place's limits (`storefrontThemeTranslationProblems`), and a read serves the source words if the translated document fails the schema. A preview shows the source words; the editor does not edit translations yet. A translations change is its own area in a version's changes (`translations`).

## Changing the contract

1. To add a block variant, add a registry entry (strict settings, defaults, `requires`, `fallback`, `contrastPairs`, `renders`) and a storefront renderer. `matrix.test.ts` covers the new variant against every other block, palette and density. To add a section type, add a registry entry (strict settings, defaults, `requires`), its data reads in `home-data.ts`, its renderer and its type in `STOREFRONT_SECTION_RENDERERS`.
2. To change a section's settings incompatibly, bump that entry's `version` and add its step (`upgrades[old version]`). An optional field (the hero's `sideBanners`) keeps stored sections valid without one.
3. For any other incompatible shape change, bump `STOREFRONT_THEME_DOCUMENT_VERSION`, add the step from the old version to `STOREFRONT_THEME_DOCUMENT_UPGRADES` and freeze goldens of the old version (`compat/v<old>/`). Never reset stored themes in a migration. Review and accept `compat.snapshot.json` (and the ABI snapshots when a skin projection changes).
4. Add a label for every new setting in `apps/admin-v2/src/i18n/theme-settings.ts`.
5. Run `pnpm generate:sdk` after any change to the document schema, because the API contract embeds it.
6. Release the API and the storefront together. An older storefront cannot read a future document. Unknown store-shape keys still fail closed to fit fallbacks.

`pnpm fidelity:check` measures the built storefront for every preset.

## Palettes

A template chooses one palette. Merchants recolour it with six colour roles. Every palette passes every AA pair and the helper-versus-error rule (tested). Neutrals tint toward the palette's hue, never raw grey on a warm page. A card surface uses a border or a shadow, never both. The values are in `STOREFRONT_THEME_PALETTES` (`tokens.ts`).

- `retail` (department-mall, showcase-landing): white page, charcoal ink and buttons, sand neutrals.
- `marketplace` (marketplace): white page, near-black ink, cool neutral panels, one saturated orange for buying.
- `boutique` (boutique): linen page, espresso ink, no colour.
- `fresh` (daily-essentials): white with a leaf green for buying and green-tinted panels.
- `beauty` (no preset): black type and buttons on white, a blush accent on surfaces and never on text.
- `heritage` (no preset): paper, umber ink, madder terracotta actions.
- `midnight` (no template): layered near-blacks, white ink and buttons, zinc helper text.

## Typography

The font families are Google Fonts, self-hosted by the storefront (`STOREFRONT_FONTS`, `apps/storefront/src/lib/theme-fonts.ts`). The seven pairings are `retail`, `market`, `editorial`, `fresh`, `beauty`, `heritage` and `tech`. Each sets the heading and body families and a Bengali family (Noto Sans Bengali, Noto Serif Bengali or Hind Siliguri). It also sets heading weight, tracking and leading, body leading and label tracking (`STOREFRONT_TYPE_PAIRING_SPECS`).

Each Latin face carries a Latin `unicode-range`, so Bangla text falls through to the pairing's Bengali family. A metric-matched fallback face (`<Family> Fallback`) keeps the swap from shifting layout. A local face, `Bengali System` (`STOREFRONT_BENGALI_SYSTEM_FONT`), names the installed Bengali font right after the Bengali family in every stack. The Taka sign (U+09F3, outside the web font's range) and Bangla text before its font loads then skip the platform's font search, which cost 35-40 ms of the first layout on a laptop. The storefront preloads only the heading face's Latin subset. The dashboard's Typography card uses the same font files (`apps/admin-v2/src/components/admin/online-store/type-preview-fonts.ts`); both files use the same font keys, so a new family fails the type check until both have its file.

## Craft

- Motion is 150 ms ease-out for hover and press, 250 ms for fades and panels, and none under `prefers-reduced-motion` (the duration tokens are zero).
- A store has one image aspect (`imageRatio`). A card photo zooms 1.03 on hover, or fades to the second photo where the card shows one. A pressed button scales to 0.98.
- Loading skeletons mirror the final layout (the same aspect ratios and rows).
