# Volt Gadgets: burst notes

Built in one burst (2026-10-20) as a reference product: an exact-UX replica
of applegadgetsbd.com under the name "Volt Gadgets" (`scalius.volt`), as a
theme app plus a removable demo store. Research: `RESEARCH.md`.

## What exists

- `src/storefront.tsx`: skins of the header (logo, wide search, quick links
  with icons, cart, account; a category bar with mega panels and an optional
  promo photo per panel; a phone drawer and bottom bar), footer (dark;
  contact, app badges, outlets, menus, social, WhatsApp live chat), product
  card (saved-amount pill "৳ X OFF", struck regular price), product page
  (gallery, price/status/code/brand chips, EMI line, key features, the
  store's buy form, WhatsApp and delivery lines, a tab bar over the
  specification table, description, warranty and reviews), listing (filters
  sidebar, "Showing: (N Items)", toolbar, Shop Now cards, pagination), and
  ten core section skins (hero slider with side banners, usp strip,
  featured categories, product tabs/grid/row, deals, brands, banners, store
  text). Three sections: `trust_strip` (five facts), `offer_cards`,
  `promo_banner`. Two islands: `slider`, `tabs`. One template `volt`.
- `demo-pack/index.ts`: the copied content (52 categories in the source
  tree, 26 brands, 48 products, two with option matrices and spec tables,
  4 collections, 9 hero banners), never imported by the storefront module.
- `src/demo/*`: the `demo_content` feature. Admin page "Demo store":
  "Import demo store" runs a bounded slice (36 platform calls), the
  every-minute cron continues it, each created item is recorded in the
  `demo_items` Object, and "Remove demo content" trashes exactly those, at
  the revision they were created with (a product the merchant edited is
  kept, with its photos, brand and category chain). Every demo item is
  `noIndex` and excluded from sitemaps. Retry keys carry a job id, so a
  slice that died after a create replays instead of duplicating.

## Gates run (plugin-local only, under the host lock)

- `tsc --build` for `plugins/volt`: clean.
- `pnpm plugin validate plugins/volt`: ready to pack.
- `pnpm plugin pack plugins/volt`: packed (smoke-renders every section and
  skin): 45.6 KB module, 26 KB stylesheet, 63 KB backend bundle.
- `vitest run` in `plugins/volt`: 20 of 20 pass (template applies to a valid
  theme document; header, card, product page, listing, hero, tabs, trust,
  offers, footer render with zero sanitizer drops; demo plan order; import
  in slices with no duplicate creates after a rate limit; removal trashes
  only what it created and keeps an edited product with its dependencies;
  cron continues; admin page).
- `grep applegadgetsbd dist/storefront/*`: 0. The copied content is only in
  the backend bundle (`plugin.js`, the demo feature), never in the theme.

## Unverified (the lead must check)

- **Nothing was seen in a browser.** WebFetch reads markdown, not CSS: the
  colours (orange #f26522, grey page, dark footer), spacing, radii, the mega
  menu's image placement and the slider's aspect ratio are from the markup
  order and the brand's known look, not measured. Put the replica beside the
  source at 1440 px and 390 px and fix the deltas before calling it exact.
- **The importer never ran against a real API.** Tests use a fake store that
  answers the documented response shapes. Unchecked in reality:
  `products.create` accepting `optionMatrix` draft ids (`draft_option_*`,
  `draft_value_*`, `draft_variant_*`) and `stock` on new variants without
  `expectedStockVersion`; `categories.create` accepting the image object
  built from an `import_url` answer; `media.import_url` reaching
  `adminapi.applegadgetsbd.com` (hotlink protection, `(`/`&` in names);
  the app scope check letting `write_products` call `brands.*`
  (`categories.create` permission) and `ctx.customFields.set` on products;
  `media.trash` of a file a trashed product still references; trashing a
  parent category whose children are already trashed.
- The packer's SVG check for `public/logo.svg` and `public/logo-light.svg`
  (they use `<text>`): pack passed, but the logos were not looked at.
- Storefront render inside the real store (one batch per page, the 250 ms
  wall, the memo) and the island behaviour (slider autoplay, tabs) in a
  browser.
- `pnpm-lock.yaml` gained the `plugins/volt` importer from `pnpm install`;
  it is left uncommitted (outside `plugins/volt/**`). The lead must commit
  it, and run `pnpm plugin add plugins/volt` to bundle the app.

## Platform gaps (the important output)

Each gap names the contract that would close it. None was worked around in
core; the closest current mechanism is noted.

1. **Menu items carry no image** (mega menu with images).
   `StorefrontMenuItem` is `{ title, url, children }`. Wanted:
   `image?: StorefrontImage | null` on every item: the linked
   category/collection/brand's image, or the menu item's own media.
   Closest now: a header skin setting `mega_promos` (category name + a Files
   URL), matched by title, drawn with a bare `<img>` (no renditions, no
   srcset, fragile on rename).
2. **Skin settings cannot hold images.** "Skin settings cannot use image" is
   documented; a header/footer that needs merchant photos (mega menu promo,
   app-store badges, payment logos) falls back to `url` strings. Wanted: an
   `image` setting type on skins, resolved in the same batch read the
   header already makes (bounded: N images per skin).
3. **No scope to write the theme or the menus.** `dashboard.theme.*`
   needs `settings.general.edit` and `dashboard.navigation.*` needs
   `settings.header.edit`; no plugin scope confers either. A demo pack (or
   any theme app's onboarding) cannot place its home layout, point product
   tabs at its collections, fill the hero slides or create the footer menus
   (About Us, Policy). Wanted: `write_themes` (theme draft save, not publish
   unless asked) and `write_navigation` scopes, or a declarative
   `storefront.demo` manifest block the platform applies.
   Closest now: the admin page lists the created ids for the merchant to
   wire by hand ("Finish the home page").
4. **Templates cannot reference resources by handle.** A product source is
   `category:<id>` / `collection:<id>`; a template is written before any id
   exists. Wanted: `{ kind: "category", handle: "laptops" }` and
   `{ kind: "collection", handle: "hot-deals" }` (resolved at read time like
   ids; unresolved shows nothing), and media references by app asset path
   for hero slides. Collections also have no slug/handle at all
   (`/collections/<id>`), so banners cannot link to a collection
   predictably.
5. **No permanent delete for apps.** `write_products` "never deletes
   permanently"; removal can only trash. A removed demo leaves trashed
   products, categories and brands whose slugs stay taken, so a re-import
   gets `-2` slugs and banner links break. Wanted: an app may permanently
   delete resources it created itself (an ownership mark set at create,
   e.g. `createdByApp`), or a `restore` path the importer can use.
6. **No background job for long admin actions.** An import is ~200 calls;
   Free allows 50 platform calls per run and 60 API calls a minute, and an
   admin button runs once. Closest now: a resumable slice per click plus an
   every-minute cron (which itself only ticks every 15/23 minutes), so a
   one-click import takes many minutes or many clicks. Wanted:
   `ctx.jobs.start(name, state)` drained by the platform's durable
   background rows with progress the admin page can poll (`ui.progress`),
   or a `ui.result({ continue: true })` that re-posts while work remains.
7. **No batch create operations.** Each product, category and media import
   is one call. Wanted: `dashboard.resources.products.bulk_create` (and
   categories) with per-item results, under the same idempotency key rules.
8. **No stable product create.** `dashboard.products.create` is beta and
   takes decimal major units (`price`, `discountAmount`), unlike the stable
   tier's integer minor units. A third-party theme cannot ship a demo pack.
9. **The product page projection lacks the SKU and per-variant codes.** The
   source shows "Product Code"; `StorefrontProductPage.product.variants`
   has no `sku`. Closest now: an app custom field `product_code`.
   Wanted: `sku: string | null` per variant (and the selected one).
10. **Product tabs hold 2-4 tabs; the source shows up to 12.** And
    `usp-strip` custom items max 4; the source has 5 (Volt ships its own
    `trust_strip`). App component sections cannot use a list of product
    sources either ("list items: no products"), and the homepage allows 8
    app product lists. Wanted: product-tabs up to 12 tabs with lazy
    loading of non-first tabs (a part read on tab open, cached by DVC).
11. **The listing projection has no subcategory links or banner control.**
    The source shows a category banner and its children; `StorefrontListingPage`
    has `image` but no `children: StorefrontLink[]`. Wanted: the published
    child categories of a category listing.
12. **No "Compare" or "Pre-order" primitives.** The source header links
    Compare and Pre-order; the platform has neither a compare list nor a
    pre-order availability state. Volt links to pages the merchant makes.
13. **No EMI facts in the product projection.** The source shows "EMI
    Available / View Plans"; core has `emiEligible` on products but the
    projection does not carry it. Wanted: `emi: { eligible: boolean,
    fromMinor?: number } | null`. Closest now: a skin text setting shown on
    every product.
14. **Card projection has no brand or key specs per card.** Fine for this
    source; noted for the Star Tech style (`facts` exists but is
    store-controlled, not app-requested).
15. **The source's brand orange cannot be the primary token.** The theme
    contrast rule needs 4.5:1 for primary on the background; #f26522 on the
    grey page is 2.86:1, so the template uses #c2410c (darker orange). An
    exact replica needs either a separate fill-only brand token (pills,
    large buttons, the active tab) or a large-text contrast tier (3:1).
16. **Header data has no "Offers" or "Blog" routes.** Quick links are
    settings with typed paths; a store without `/offers` gets dead links
    until the merchant edits them. Wanted: `routes.blog` when the store has
    a blog, and a pages lookup for skins.

## Not done (deferred)

- An offers page preset (`pagePresets`) using `offer_cards`; the section
  exists, the preset does not.
- Bangla words for every buyer-facing string exist via `t()`; the admin
  page has `bn`, the manifest settings labels do not.
- Screenshots for the app listing.
