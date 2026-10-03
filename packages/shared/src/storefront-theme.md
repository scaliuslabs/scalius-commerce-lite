# Storefront theme document (version 7)

One JSON document describes how the storefront looks: the template label, tokens, brand, one variant per block with its settings, the homepage sections, up to 20 landing pages and what `/` shows. The dashboard drafts, previews, publishes (atomically) and restores it. An agent can write it through the API, and installed apps add sections and product blocks. The storefront and the dashboard resolve it against the store with the same function. This file is the contract for contributors and coding agents.

Store identity (name, phone, email, address, social profiles) is not in the theme. The business document (Settings > Store details) owns it, and every buyer surface reads it only from there.

Source of truth: `packages/shared/src/storefront-theme/*.ts`, re-exported as `@scalius/shared/storefront-theme`. `document.ts` holds the schema and the read upgrade entry points ([upgrade.md](storefront-theme/upgrade.md)). The registries are `blocks.ts` (block variants) and `sections.ts` (20 section types), and `apps.ts` holds the sections and product blocks that installed apps draw (`<plugin id>/<type>`). `tokens.ts` and `contrast.ts` hold the tokens, the 19 colour keys and the AA pairs. `fit.ts` (`StoreShape`) and `resolve.ts` (`resolveStorefrontTheme(document, storeShape)`) fit a document to a store. `templates.ts` holds the 10 templates and `DEFAULT_STOREFRONT_THEME`. `content.ts`, `home-data.ts`, `pages.ts` and `compare.ts` (`compareThemeDocuments`, the typed changes stored with each version) hold the rest.

## Shape

```jsonc
{
  "version": 7,                        // literal; a new shape means a new version
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

## Rules

### Content, brand and what `/` shows

- **One draft for the look.** A save writes the draft only. A preview renders the draft. A publish makes all of it live at once. A version restores all of it. Header and footer menus stay navigation menus with their own publish. The theme only chooses where their links come from (`blocks.navigation`).
- **Announcement and footer words.** The `topBar` variant is the only switch for the announcement: `none` is off. The other three variants carry `text` (160 characters at most) and an optional `link`. Every footer variant carries `tagline` (160), `about` (1,000; plain text, a blank line between paragraphs) and `copyright` (120; the name after "©"). An empty `copyright` shows the store name.
- **Brand.** `brand.logo`, `brand.footerLogo` and `brand.favicon` are media ids. `null` shows the store name in text, or the platform tab icon. `brand.logoWidth` is the header logo width on computers (80 to 240 px, steps of 10; phones cap it at 160 px). A preview resolves the draft's own images (`POST /api/v1/storefront/theme-preview/resolve` returns `brand`).
- **Saves check what the document names.** A save rejects a media id that is not a ready or trashed image in Files, and a product home mode whose product is gone or in trash. Each error names its document path (`brand.logo`, `pages.home.2.settings.slides.0.image`). A link is a canonical, navigation-safe href: a same-store path, a `?query`, a `#fragment` or an https URL. Files refuses to delete an image that the published theme or the draft still shows.
- **Content survives a template.** Choosing a template copies its look and keeps the merchant's content (`storefrontThemeWithContent`): the brand, the home mode, the landing pages, the announcement and footer words where the new variants carry them, each hero's slides and side banners, and the category tiles' and collections' picks. Picks go to the first section of the same type, then the second. "Matches a template" compares looks only (`storefrontThemeLook`). Switching a block variant, and a resolver fit fallback, keeps the settings both variants declare (`storefrontBlockSwitch`).
- **What `/` shows.** `pages.homeMode` is `sections`, or `product` with a `productId`. While that product is public (the homepage read returns it as `sections.homeProduct`), `/` answers 302 to the product page. That page keeps its canonical URL and SEO and never redirects back. A product that stops being public leaves `/` on the sections. A preview follows the draft's mode.
- **The template is a label.** `template` feeds the dashboard's "based on" line and its reset-to-template defaults. No storefront component and not the resolver read it for behaviour: every behaviour is a block variant, a setting or a token, so blocks from any template mix freely. `apps/storefront/src/lib/theme-contract-consumers.test.ts` fails when a component branches on the template, or when an enum value has no consumer. A choice with no renderer is removed.
- **Per-resource overrides.** `products.page_template` names a template (or `classic`, the Department mall product page). The product page then uses that template's `blocks.product` and keeps the store's own header, footer, tokens and card. `categories`, `collections` and `brands` have `listing_template`: a listing layout or a filter style. It replaces the theme's own for that listing when the store fits it (`catalogListingPresentation`). `null` uses the theme.
- **Strict writes, upgraded reads.** Writes accept only the current version, known keys and valid registry settings. Stored reads run the pure step-wise `upgradeThemeDocument` before the same validation, in memory, without writes or resets. An invalid or unknown future document fails closed: the dashboard reports it unreadable and the storefront renders the default theme.

### Tokens, cards and contrast

- **Tokens are global; blocks choose structure.** A variant never carries its own colour, so any mix of variants stays coherent. One card per store. Cards are the exception for shape and type (below).
- **Readable text.** Every pair in `STOREFRONT_THEME_TEXT_PAIRS`, plus the `contrastPairs` of every chosen variant and of every variant it can fall back to, must reach WCAG AA (4.5:1). The header roles (`header-background`, `header-foreground`) follow `headerTone`: `dark` takes the darker of ink and page, `brand` takes the action colour. A write that breaks a pair is rejected. `muted-foreground` must also be near-neutral (Lab chroma 25 or less) and at least 40 CIE76 units from `destructive`, so helper text never looks like an error.
- **Colours.** Every colour a block paints is a theme token. The footer tones re-point the footer's surface tokens to an AA pair. The banded `directory` footer uses the header tone with two derived bands, `theme-header-raised` (at most 14% toward the header text, never below AA) and `theme-header-deep`. Stars and review bars use `theme-rating`, always beside the rating number in text.
- **Cards.** The registry has 12 card variants. `standard` follows the template's tokens and type scale. Every other card owns its measured look (`STOREFRONT_CARD_LOOKS`): photo ratio and fit, radius in px, surface, and title and price size and weight per viewport. A template's radius, surface and photo tokens never flatten it. Density still owns the grid (card minimum, gaps) and the card padding.
  - A card's anatomy is data in `renders`. Any two cards differ in at least three anatomy fields on a product with every fact (render test). The storefront renders `standard` from its own file and every other card from `apps/storefront/src/components/cards/variants/anatomy.astro`.
  - The `showcase` card shows Add only for a product that needs no buyer input (no options, customization or gift card; in stock; a fixed positive price). Other in-stock products open their page.
  - Facts (brand, key specs, rating, sold, pack size, delivery, EMI, swatches, options) render only when the product has the data. There are no zero states. Sold counts show from 10 units in 30 days. Swatches come from the first colour axis (at most 5). Key specs show at most 4. The `emi` fact needs `emiMonthlyFrom`, which no API read sends, so it never renders. Only `spec` has `compare`.
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

- **Layout.** `grid`, `list`, `shelves` (one shelf per sub-category or collection, at most 8; needs category depth 2 or a collection, else `grid`) and `quick-grid` (needs the `quick-add` card, else `grid`). Shelves show only on the plain first page: no search, refinement, sort or later page.
- **Starting views.** `searchLayout` sets how search results start and `phoneLayout` sets the phone view. The buyer's grid/list switch (`grid-list-toggle`) is stored in the browser, separately for browsing and for searching. `paging` is `numbered`, `load-more` or `infinite`. The last two keep crawlable `?page=n` links.
- **Description.** `descriptionPlacement` puts a category, collection or brand description `above` the results (clamped to two lines with "Read more") or `below`. The merchant's buying guide always renders below the results.
- **Filter styles.** `filters.style` places the facets: `sidebar-dense` (a 240 px column), `sidebar-comfortable` (270 px), `bar-dropdowns` (up to 4 facet dropdowns in a bar, the rest in a drawer) and `drawer` (a Filter button and a drawer). On phones every style opens the facets from a Filter button in a sheet. `openByDefault` opens the facet groups (never for `bar-dropdowns`). A template may set `column` (180 to 340 px), `rowPitch` (16 to 36 px) and `label` (12 to 18 px) over the style's numbers. A facet shows 10 values in the HTML. "See more" fetches the rest.
- **Filter order and placement.** `order` reorders whole groups (unset keeps the style's arrangement). `searchPlacement: drawer` moves a sidebar's facets into the drawer on search, so the results take the width (up to five columns). `ruled` draws a sidebar's groups as one flat, ruled list that scrolls on its own. A sidebar stays sticky on computers (from 1024 px).
- **Small catalogues.** Filters need 8 results and a facet with two values, unless the buyer already refined (`storefrontListingFiltersShown`). A store with fewer than 8 products resolves `shown: false`. Sort needs two results.
- **Toolbar pieces.** The pieces are in `blocks.ts`. A piece without data is left out: `subcategory-pills` needs category depth 2 and `popular-filter-chips` needs key specs. `facet-value-chips` shows one row of 2 to 8 values of the first option or attribute facet. The editor has a switch for every piece except `popular-filter-chips` and `aspect-chips`, which follow the layout.
- **Page chrome.** Template data sets `surface`, `gutter`, `phoneBar`, `links` (`chips`, or a `tabs` strip that starts with "All"; not on search), `phoneBanner` and `maxColumns` (3 to 6 or `null`; the `spec` and `mall` cards cap at four). `band` is `standard`, `inline` (needs the bar placement) or `beside-filters` (needs a sidebar). Otherwise `standard` renders.

### Product page

`blocks.product` is the page template for every product. A product's `page_template` can swap it (see above).

- **Gallery.** `classic`, `thumbs-below`, `thumbs-left` (`phoneSideThumbnails` keeps the rail beside phone photos), `stacked`, `portrait` and `image-grid`. `stacked` and `image-grid` keep their details column sticky by layout.
- **Buy box.** There are 12 variants (`classic` and 11 others). Each but `classic` has a measured look (`STOREFRONT_BUY_BOX_LOOKS`).
  - `spec` and `tech` take `emi` (shown only when the store has EMI plans). `tech` also takes `whatsapp` (shown only when the store has a WhatsApp number). `fashion` and `heritage` start with one purchase button, and `showBuyNow` adds Buy now.
  - `digital` needs a digital SKU, else `classic`.
  - `classic`, `boutique`, `showcase`, `heritage` and `fashion` keep the description beside the gallery. Other buy boxes render it as the `description` module.
- **Modules.** `below` lists the modules in page order. Each renders only when this product has its data, from reads the page already makes. Rules: `frequently-bought-together` shows the first half of the recommendations (two at most) when they are mostly real co-purchases. `key-attributes` shows at most 8 key-spec rows and needs key specs in the store, as does `compare-similar`. `about-bullets` is left out when the buy box already lists the features. `spec-table` never shows a brand as a row. `reviews` carries "Write a review" in its zero state. `recently-viewed` is this browser's own list, filled before paint, and shows nothing without JavaScript.
- **Sticky bars.** At most one at the top and one at the bottom on phones. `phoneBottom: buy-bar` and `desktop: product-bar` show the price and Add to cart once the buy buttons scroll away.
- **App blocks.** `blocks.product.apps` lists blocks that installed apps draw (`{ id, app, values }`, at most 10, in the merchant's order). Each renders in the buy box or after the modules, as its app declares.

### Sections, landing pages and apps

- **Registry.** Each `type` is an entry in `STOREFRONT_SECTION_REGISTRY` with its own `version` and strict settings. There are 20 types (`hero`, `product-rail`, `category-tiles`, `editorial`, `faq`, `newsletter` and more: `sections.ts`). An app section has type `app` (`settings.app` is `<plugin id>/<type>`). Sections are optional, repeatable and reorderable. Ids are unique. A page holds at most 24. A hidden section (`hidden: true`) stays saved and media-validated but makes no public reads.
- **Renderers.** `STOREFRONT_SECTION_RENDERERS` lists the types the storefront renders: one component each under `apps/storefront/src/components/homepage/`. An app section that is gone, inactive or no longer declared renders nothing.
- **Sections without data.** A section without data renders nothing, with no placeholder. `storefrontSectionNeedsContent` flags a section whose own settings leave nothing to show, and the dashboard shows the flag. Examples are a hero without a slide whose image resolves, category tiles with fewer public categories than their style needs, and an empty testimonial list or FAQ. Templates ship the story, highlights, quotes and FAQ sections empty, so they stay hidden until the merchant fills them in. A collections section without a collection that has products shows the newest products. The storefront reads shipping and checkout facts only when a `usp-strip` section shows them (`homeSectionsShowDeliveryFacts`).
- **Hero slides.** A hero has at most 10 slides. A slide has a computer image and an optional `phoneImage`, each with a focal point (`phoneFocalPoint` falls back to `focalPoint`). It also has alt text (never drawn over the image) and an optional link, and the button shows only with a link. `sideBanners` (at most 2) show only with `contained-banners`.
- **Newsletter.** The signup form asks for the phone always and the e-mail as `optional`, `required` or `hidden`. It posts to the storefront's `/api/newsletter/subscribe` and works without JavaScript (`apps/storefront/src/lib/newsletter-server.ts`). It reads no data, so it always renders. The `newsletter-grey` footer carries the same form, left out on a page that already shows one.
- **Home data.** `homeSectionRequests(home, homeMode)` derives what the page reads, so callers never name reads. The limits are 8 product lists of 36, 40 images, 24 category tiles, 8 collections, 4 deal promotions and 8 app sections. The homepage batch part serves them for the published theme (a fixed read that rejects any query string). A preview reads the saved draft's sections on the private, never-cached, token-verified `POST /api/v1/storefront/theme-preview/homepage`.
- **Landing pages.** `pages.landing` holds at most 20 pages at `/pages/<slug>`. A handle is one lowercase CMS-style segment that is not a reserved route and not `pages`. A page has a `title` (120), a `description` (320) and its own sections (same registry and 24 cap as home). `noIndex` keeps it public with `noindex,follow` and out of the sitemap, and `excludeFromSitemap` only leaves it out of the sitemap. It renders from the same single batch as home (the layout plus `GET /api/v1/storefront/landing/<slug>`). Its canonical is always the absolute `/pages/<slug>` address. The pages sitemap lists the live theme's landing pages without a lastmod.
- **No per-page templates.** A product, collection, category, brand or search page has no page entry: its structure is `blocks.product` or `blocks.listing`. A CMS page keeps its own content, framed by the theme.

## Draft, preview, publish and versions

The service is `packages/core/src/modules/settings/site-settings.service.ts`. The rows are `theme_settings` (live), `theme_settings_drafts` (the one shared draft) and `theme_settings_versions` (immutable published versions).

- **One shared draft per store.** Every write is one guarded D1 batch on revisions. The draft revision only grows. Save, page edit, restore, discard and publish each carry the revisions they read. A stale revision answers 409.
- **Restore and discard replace the draft only.** Publish is the one way anything goes live. One batch writes the live row, a version row and the rebased draft, and prunes history to the newest 20 versions.
- **Version rows.** A row holds `{ meta: { changes, moreChanges, note }, theme }`. `changes` has at most 20 typed entries, `note` at most 500 characters, and a document at most 512 KiB.
- **Missing images.** A version that names images deleted from Files since is refused with `THEME_VERSION_IMAGES_MISSING` (`details.missingImages`). Restoring it with `withoutMissingImages` leaves out the slides, cards and tiles that showed one and empties single images.
- **Preview.** `POST /api/v1/admin/settings/theme/preview-session` mints a one-time continuation code (`tpc_`, valid 5 minutes) for the saved draft or one published version. The browser posts it to the storefront `/theme-preview/continue` (`/theme-preview/embed` in the editor frame). The storefront exchanges it for a `tpv_` token in the HttpOnly cookie `stp_theme_preview` (valid 30 minutes). The database stores only the SHA-256 of each token. The session stores no theme: every preview read resolves the saved draft or version as it is then. A pruned version stops previewing. Preview needs a valid HTTPS Storefront URL in the Platform settings (Settings > Store details > Web addresses).
- **Permissions.** Reads need `settings.general.view`. Writes need `settings.general.edit`. Staff with view only open the editor read-only.

## Editor

Online store > Theme (`/admin/online-store/theme`) shows the current theme, whether its draft has unpublished changes and who published last, with Customize, Preview and Publish, and the template library below. Choosing a template restyles the draft and keeps the merchant's content. Customize opens the editor at `/admin/online-store/theme/editor`.

- **Layout.** The page's tree is on the left, the real storefront in a frame in the middle and the selected part's settings on the right (they replace the tree below 1280 px). Edits autosave to the draft 800 ms after the last one, against the draft revision. A conflict keeps the edits and offers reload or an explicit overwrite.
- **Theme settings.** Six colours (background, text, buttons, button text, highlight, highlight text) each write every token of their role and show the readable-text problems they cause. Typography, brand images, logo width and product cards have their own settings.
- **Generated forms.** Section and block settings forms come from the registry's zod schemas (`apps/admin-v2/src/components/admin/online-store/schema-form/`). A new setting needs a label in `apps/admin-v2/src/i18n/theme-settings.ts` (English and Bangla) and no form code.
- **The frame.** The frame is a normal preview session redeemed by `/theme-preview/embed`: the code arrives by `postMessage` and the cookie is `SameSite=None; Partitioned`. Only a page that rendered a valid preview carries the section marks (`data-theme-section-id`), the inline bridge (`apps/storefront/src/lib/theme-preview-bridge.ts`) and a `frame-ancestors` that names the dashboard origin. Both sides check the other's exact origin and window (`@scalius/shared/theme-editor-bridge`). A settings change re-renders its section from the private, never-stored `/theme-preview/section?id=`. A buyer's homepage is byte-identical with or without the editor (`theme-editor-preview.render.test.ts`).

## API and agents

The routes are in `apps/api/src/routes/admin/settings/site.ts` under `/api/v1/admin/settings/theme/`. Their operation ids start with `dashboard.theme.`.

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

The commands answer revision receipts only. The curated workflow `theme.draft-landing-page.v1` drafts one landing page and verifies it through `workspace_get`. It never publishes.

The OpenAPI contract states shared shapes once as named components (`StorefrontThemeDocument`, `StorefrontSectionList`, `StorefrontLandingPage`, `StorefrontHomepageSections`, `ErrorResponse`). Write a nullable use of a named schema as `z.union([Named, z.null()])`, because `.nullable()` would make the component itself nullable (`apps/api/src/openapi/component-schema-refs.test.ts`).

## Templates

`templates.ts` holds every template's data: header, menus, card, listing and filter style, gallery, buy box, footer, tokens, top bar, navigation source, product modules, sticky bars and a starting homepage.

The templates are `boutique`, `heritage-editorial`, `fashion-value`, `spec-catalogue`, `rounded-tech`, `marketplace`, `mass-retail`, `department-mall` (the default), `daily-essentials` and `showcase-landing`. The dashboard's template library describes each one (`template_<id>Help` in `apps/admin-v2/src/i18n/online-store.ts`).

Where a template departs from its reference:

- **Department mall** is the default: every store with no saved theme renders it (`DEFAULT_STOREFRONT_THEME`). It keeps the `classic` gallery, with its own `mall` buy box, radius buttons and hairline cards in a 1200 px container. Its utility top bar, department search header and "All departments" rail (open on the home page) take departments from the tree (`tree+menu`).
- **Showcase landing** shows its collection links as a tab strip starting with "All", and one row of real option or attribute values from the listing facets (`facet-value-chips`). The editor can hide either row.
- **Card minimums** are grid minimums, not the measured card widths: an auto-fill grid stretches cards, and two cards must fit a 360 px phone. `dense` shares compact's type scale (the 14 px phone floor) and uses a 12 px desktop gap, so columns never drop when the page gutter grows at 1024 px.

## Changing the contract

1. To add a block variant, add a registry entry (strict settings, defaults, `requires`, `fallback`, `contrastPairs`, `renders`) and a storefront renderer. `matrix.test.ts` covers the new variant against every other block, palette and density. To add a section type, add a registry entry (strict settings, defaults, `requires`), its data reads in `home-data.ts`, its renderer and its type in `STOREFRONT_SECTION_RENDERERS`.
2. To change a section's settings incompatibly, bump that entry's `version`. An optional field (the hero's `sideBanners`) keeps stored sections valid without one.
3. For any other shape change, bump `STOREFRONT_THEME_DOCUMENT_VERSION`, add one upgrade step from the previous version in `upgrade.ts` and capture the previous version's golden fixture. Never reset older stored themes: reads upgrade in memory.
4. Add a label for every new setting in `apps/admin-v2/src/i18n/theme-settings.ts`.
5. Run `pnpm generate:sdk` after any change to the document schema, because the API contract embeds it.
6. Release the API and the storefront together. An older storefront cannot read a future document. Unknown store-shape keys still fail closed to fit fallbacks.

`pnpm fidelity:check` measures the built storefront against the reference sites for every template.

## Palettes

A template chooses one palette. Merchants recolour it with six colour roles. Every palette passes every AA pair and the helper-versus-error rule (tested). Neutrals tint toward the palette's hue, never raw grey on a warm page. A card surface uses a border or a shadow, never both. The values are in `STOREFRONT_THEME_PALETTES` (`tokens.ts`).

- `retail` (department-mall, rounded-tech, showcase-landing): white page, charcoal ink and buttons, sand neutrals.
- `marketplace` (spec-catalogue, mass-retail): white page, near-black ink, cool neutral panels, one saturated orange for buying.
- `marketplaceAmazon` (marketplace): the marketplace buying hierarchy with ink #1c2530, terracotta #b84724 and gold #f1c65a.
- `boutique` (boutique): linen page, espresso ink, no colour.
- `fresh` (daily-essentials): white with a leaf green for buying and green-tinted panels.
- `beauty` (fashion-value): black type and buttons on white, a blush accent on surfaces and never on text.
- `heritage` (heritage-editorial): paper, umber ink, madder terracotta actions.
- `midnight` (no template): layered near-blacks, white ink and buttons, zinc helper text.

## Typography

The font families are Google Fonts, self-hosted by the storefront (`STOREFRONT_FONTS`, `apps/storefront/src/lib/theme-fonts.ts`). The seven pairings are `retail`, `market`, `editorial`, `fresh`, `beauty`, `heritage` and `tech`. Each sets the heading and body families and a Bengali family (Noto Sans Bengali, Noto Serif Bengali or Hind Siliguri). It also sets heading weight, tracking and leading, body leading and label tracking (`STOREFRONT_TYPE_PAIRING_SPECS`).

Each Latin face carries a Latin `unicode-range`, so Bangla text falls through to the pairing's Bengali family. A metric-matched fallback face (`<Family> Fallback`) keeps the swap from shifting layout. The storefront preloads only the heading face's Latin subset. The dashboard's Typography card uses the same font files (`apps/admin-v2/src/components/admin/online-store/type-preview-fonts.ts`); both files use the same font keys, so a new family fails the type check until both have its file.

## Craft

- Motion is 180 ms ease-out for hover, press and reveal, and none under `prefers-reduced-motion`.
- A store has one image aspect (`imageRatio`). A card photo zooms 1.03 on hover, or fades to the second photo where the card shows one. A pressed button scales to 0.98.
- Loading skeletons mirror the final layout (the same aspect ratios and rows).
