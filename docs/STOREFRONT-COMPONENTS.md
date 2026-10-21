# Storefront components

An app can redesign the storefront: skins of the header, footer, product card, product page, listings and any core section; new sections and product blocks with their own logic; a single-page order landing; and ready-made templates that apply the whole look in one click. The merchant installs the app, activates it, picks its template in Online Store → Theme, and edits every section and skin in the theme editor like the built-in ones. Nobody forks the storefront.

The reference app is `plugins/noor` (Noor: a complete theme with nine sections of its own, skins of the store's own header, footer, card, product page and fifteen core sections, one template, and a landing kit with a page preset for Bangladesh-style single-product campaign pages with a cash-on-delivery order form). The small worked example is `apps/api/src/plugins/testing/apps/studio`; `apps/api/src/plugins/testing/apps/compose` is a second app that composes into the store's and Studio's units (card slots, a header drawn from the header facts, a listing with child categories, the SKU code and EMI, deferred markup, the cart drawer and cart page), proved end to end in `apps/storefront/src/lib/route-tests/compose-app.render.test.ts`.

Source of truth:

| Part | Where |
| --- | --- |
| Contract (manifest, data shapes, render protocol, limits) | `packages/shared/src/plugins/storefront-components.ts`, `storefront-protocol.ts` (zod-free) |
| Skins (targets, core section projections) | `packages/shared/src/storefront-theme/skins.ts`, `apps.ts` (`apps.skins`, a section's `skin`) |
| Core embeds (`<scalius-embed>`) | `packages/shared/src/plugins/storefront-embeds.ts` (`splitStorefrontEmbeds`, `storefrontEmbedRule`) |
| Output check | `packages/shared/src/plugins/html.ts` (`sanitizePluginHtml`, `component` profile) |
| SDK | `@scalius/plugin-sdk/storefront`, `/storefront/testing`, `/island` (`packages/plugin-sdk/src/storefront/`) |
| Packer | `scripts/plugin-build.mjs` (`packStorefront`, `writeStorefrontGenerated`) |
| Host (storefront) | `apps/storefront/src/lib/extensions/` (projections in `data.ts`), `components/apps/{Skin,AppComponent,ComponentProductBlocks}.astro` |
| Data | `packages/core/src/modules/storefront/app-components.ts` (`readAppComponentData`) |
| Files | `GET /api/v1/storefront/extensions/{pluginId}/{release}`, served on the store's origin at `/_x/<plugin id>/<release>/<path>` |

## The model

An app's storefront module is compiled once, at pack time, and linked at activation.
It is not rebuilt per store. Its render contract is pure: data comes from the
host, not component fetches. The loaders have different trust boundaries below.

- **Server components.** JSX (or `html` templates) that build HTML strings. A component is a pure function of its input: the resolved settings, the data the page already read, and the render context. No network, no storage, no bindings, no clock beyond `context.now`.
- **Islands.** The only app JavaScript a buyer's browser runs. An island is a small client module that mounts on server-rendered markup when it becomes visible (or idle, on load, on first interaction). The page works before and without it.
- **One stylesheet.** Linked only on pages that show the app's components. It styles through the store's own tokens (`--color-*`, `--font-*`, `--radius-*`), so the merchant's colours and type still apply.
- **Public files.** Fonts and images, immutable, served from the store's own origin.

The storefront runs the module in one of two loaders, with the same input and the same output:

- **Bundled** (every plan). The module is compiled into the storefront Worker: `pnpm plugin add plugins/<dir>` writes `apps/storefront/src/extensions/bundled.gen.ts` and `bundled/<id>/`, and the next deploy ships it.
- **Isolate** (Workers Paid). An uploaded or registry app runs in a Dynamic Worker: `env.LOADER.get("storefront:<id>:<release>")` with `globalOutbound: null` (no network at all) and `limits.cpuMs` 50 per batch. Upload, activate, done: no deploy. `pnpm run deploy --plugin-sandbox` binds `LOADER` on both Workers. Worker Loader is a Cloudflare beta; the binding and compatibility date are pinned in `loaders.ts` (`STOREFRONT_ISOLATE_COMPATIBILITY_DATE`) and change in one place when it goes GA.

## Extension points

| Point | Declare (`storefront.*`) | Implement (`defineStorefront`) | The theme stores |
| --- | --- | --- | --- |
| Component section | `sections: [{ type, name, settings, reads? }]` (no `route`) | `sections[type]` | a section `{ type: "app", settings: { app: "<id>/<type>", values } }` |
| Component (slots, app pages) | `components: [{ type, name, targets, settings }]` (no `route`) | `components[type]` | product slots: `blocks.product.apps: [{ id, app: "<id>/<type>", values }]`; other slots: nothing (every active app's component, defaults) |
| Skin of a unit | `skins: [{ id, target, name, settings }]` (≤ 30) | `skins[id]` | `apps.skins.<target>: { app: "<id>/<skin id>", values }` |
| Skin of a core section | `skins: [{ id, target: "section:<type>", … }]` | `skins[id]` | the core section's `skin: { app, values }` |
| Template | `templates: [{ id, name, themeVersion?, theme }]` | | `apps.template` (a label) |
| Page preset | `pagePresets: [{ id, name, themeVersion?, sections }]` | | a new landing page's sections |
| Island | `islands: [{ name }]` | `src/islands/<name>.ts` with `defineIsland` | |
| Stylesheet | `stylesheet: true` | `src/storefront.css` | |
| Browser hosts | `connect: ["api.example.com"]` | | |

Component sections and components have no render route: they run at the edge with data supplied by the existing page batch. A section may declare bounded public object `reads`; these add data to its input, not network access to its renderer. Private buyer pages use declarative storefront extensions (`storefront.extensions`: the `ui` tree, buyer surface) rendered by core in their UI slots. No route returns HTML: a proxy page (`/apps/<id>/*`) answers `{ page: { title, component, props } }` and the store draws the app's `page` component from `props`.

## Slots

A slot is a named place where apps add their piece (`storefront-protocol.ts`). Component slots are on public pages: `header.actions`, `footer.columns` (every active app's component that targets them, with default values) and `product.buy_box.before`, `product.buy_box.after`, `product.below` (arranged by the merchant as the product page's app blocks), and on every product card `product_card.badges` (over the photo) and `product_card.meta` (under the price). Core's header, footer, product page and card place them; a skin of a unit places that unit's slots with `<Slot name="header.actions" />`, `<Slot name="footer.columns" />`, `<Slot name="product_card.badges" />` and `<Slot name="product_card.meta" />` (Noor's and Studio's do). So a second app adds its badge to cards another app's skin draws, from the card's own projection, without reading that app's fields. A component gets `{ target, settings, context }`, plus `data` and `instanceId` in a product slot, `data` (the card) in a card slot and `props` on `page`, and embeds nothing. A listing's card components join its one batch per app and are memoized per card like card skins. UI slots are on the buyer's pages (`cart.page.summary`, `cart.page.below`, `checkout.*`, `cart_drawer.footer`, `order.confirmation`, `account.*`): storefront extensions (`storefront.extensions`) fill them with a `ui` tree, drawn by the store from the answer the page already reads (the cart check or checkout quote; the cart drawer's own check), so a slot adds no request. An empty slot renders nothing and costs no read.

Islands on a product page get `context.product`: `state()` (`{ variantId, quantity, inputs }`) and `onChange(listener)`; `data.product.buyerInputs` lists the inputs.

A **page preset** is a ready-made landing page: when the merchant makes a new landing page (`/pages/<slug>`), the editor offers "a blank page" or the presets of the active apps, and asks for a product when a preset's sections have `product` settings, which it fills in. Noor's "Product campaign" preset builds a complete Facebook-ad page (offer, promises, features, steps, reviews, questions, order form) in one step; every section stays editable and reorderable.

A template or page preset is written for one theme document version (`themeVersion`, absent: 10). The store upgrades it through the stored documents' upgrade chain (`packages/shared/src/storefront-theme.md`, Compatibility) before listing it, so an app built for an older version keeps working. One that still does not fit is left out of the theme editor and named, with the reason, on the app's page.

A page may hold 24 app sections, all of them component sections.

## Skins

A **skin** is app markup for a core-owned unit. It gets the unit's public projection (the data the core renderer draws from, built by `apps/storefront/src/lib/extensions/data.ts`), and core draws the unit whenever the skin is missing, its app is inactive, or it draws nothing, fails, is late or misses a required embed. A theme never breaks.

| Target | `data` (protocol type) | Core embeds it may place | Fallback |
| --- | --- | --- | --- |
| `header`, `footer` | `StorefrontHeaderData`, `StorefrontFooterData` | their slot (search, cart and account are attributes) | empty → core |
| `product_card` | `StorefrontProductCardData` (`{ product, position, aboveFold }`) | its two slots (`quickAdd`) | empty → core |
| `product_main` | `StorefrontProductPage` | **`buy_form` (required, one)**, `gallery`, `reviews`, `recommendations` | no buy form → core |
| `listing_main` | `StorefrontListingPage` | `filters`, `toolbar`, `pagination` (appended when left out) | empty → core |
| `section:<type>` | `StorefrontSectionSkinData<StorefrontSectionSkinSettings[type]>` | none (`quickAdd`) | empty → the core section |

- `product_main` draws the product page's breadcrumbs, gallery and buy box. The buy form is `ProductBuyBox.astro`, the same component the core page draws: price, options, buyer inputs, quantity, buttons, delivery facts and the buy-box app blocks, kept current as the buyer chooses. The gallery (`<Gallery />`) is `ProductGallery.astro` with the theme's gallery setting: one main photo with thumbnails, previous/next and zoom on computers, a swipeable photo with its position on phones, and the chosen SKU's own photo when a variant is picked (exact SKU image, else the product photo); its first photo is preloaded as the LCP image. Prefer it to drawing `product.media` yourself, which stacks every photo above the buy form on phones. The skin owns the description (`descriptionHtml`). Reviews and related products a skin places replace the template's modules of the same.
- A buy column that should stay in view beside the gallery marks itself `data-sticky-column` and writes its top as `calc(<offset> + var(--sticky-column-shift, 0px))`; the store's product script shifts a column taller than the window so it scrolls until its end is in view and back (`sticky-column.ts`). Core's stacked and grid galleries use the same.
- `listing_main` draws the listing between the collection template's sections. The page links are numbered links on every listing, so crawlers reach every product.
- A core section's projection is declared in the protocol, one interface per type (`StorefrontSectionSkinSettings`, `StorefrontHeroSkinSettings`, ...), each with its own version (`STOREFRONT_SECTION_SKIN_PROJECTIONS`, the `version` in `data`); core's stored settings never reach a skin directly. The host maps a section to it in one place (`coreSectionSkinSettings`): `image`, `phoneImage` and `mediaId` → `image`/`phoneImage` as `StorefrontImage | null`; a product `source` → `products` (`StorefrontProductList`: `{ title, url, cards }`, as many cards as the core section shows); `categoryIds`/`collectionIds` → `categories`/`collections` (`StorefrontTile[]`); `promotionId` → `promotion` (`{ endsAt } | null`); a Specifications custom field → `objectFields`; a delivery-facts source → the store's facts; hidden blocks and the editor's `hidden`/`bindings` keys left out. A projection only gains optional fields; when core changes a section, the host adapts it so a skin's input stays the same. A brand wall's brands arrive in `tiles`, a collections section's fallback products in `cards`. `aboveFold` is true for the homepage's lead section (the first section with photos): load its first row of photos eagerly, the likely largest at high priority, as the core section does. `recently_viewed`, `endless_grid` and `objects` have no skin.
- The header gets what a header needs without a read of its own: menu items with their category's photo (`image`), `routes.orders` and `routes.trackOrder`, `searchScopes` (the top published categories) with `searchScopeParam`: a form that sends `category=<value>` to `routes.search` answers from that category's listing (`/categories/<handle>?q=…`, no JavaScript needed), and `market` (country, currency, language, and the country form's `selection` when the store sells at more than one URL). Signed-in state is not data, since one header serves every buyer: mark the two versions with `whenSignedIn()` / `whenSignedOut()` and the store shows the right one before first paint (`<html data-scalius-signed-in>`; islands read `context.signedIn()`).
- The product page projection carries `sku` (a product without options) and each variant's `sku` (a "Product code"), and `installments` (`{ provider, months, monthly }`, the store's cheapest EMI plan) or null. A category listing carries `children` (published child categories with their photos).
- JSON-LD stays core's on product and listing pages: the host strips app JSON-LD from `product_main`, `listing_main` and product blocks.
- **Product slots**: a component targeting `product.buy_box.before`, `product.buy_box.after` or `product.below` draws as a `component` job there, from the same `StorefrontProductPage`.

## Settings

Component sections, product blocks and skins use the app settings types (`text`, `textarea`, `number`, `boolean`, `select`, `color`) and five more:

| Type | Stored | The component gets |
| --- | --- | --- |
| `image` | a media id | `StorefrontImage` (`url`, `width`, `height`, `alt`, `srcset`) or `null` |
| `products` (`limit` ≤ 36) | a source: `newest`, `featured`, `collection:<id>`, `category:<id>`, … | up to `limit` `StorefrontProductCard`s, priced in the buyer's market |
| `product` | a product id | one card or `null` |
| `link` | a storefront path or an `https://` URL | the string |
| `list` (`fields`, `max`, `itemLabel`) | items of the fields above (no products) | items with their images resolved |

The editor shows a media picker, a product source or product picker, a link field and a repeatable item list. Values are resolved against the schema as it is now (`resolveStorefrontSettings`): a removed setting drops, a new one takes its default, a deleted image or product resolves to `null`. Skin and product block settings cannot use `products` or `product`: a skin draws from its unit's projection and must not add reads. A unit skin (header, footer, card, product page, listing) may declare up to 8 top-level `image` settings (a mega menu's promo, payment logos): they resolve in the statement that already reads the theme's logo in the layout batch, so they add no read, and their media keys join the layout's dependencies. Section skins, product blocks and images inside a skin's `list` still ship images in the app's public files.

The page reads every image, product list and picked product its component sections name in one batch (`readAppComponentData`), with the homepage limits (40 images, 8 product lists). That batch follows the apps' read, which names the settings schemas, so component sections add one wave to the page, and a `collection:` source one more (its rules are read first). `apps/api/src/storefront-render-budget.test.ts` measures both.

## Dynamic sources and Objects

A section, block value, skin or app placement may store `bindings` beside its literal settings. Each setting path maps to `{ source }`, for example `heading: { source: "resource.title" }` or `subtitle: { source: "object.custom.testimonials.featured.quote" }`. Sources cover resource title/description/image/URL, `resource.cf.<namespace>.<key>`, a published object field, or an object list. The literal value remains the fallback when a source is absent or incompatible. The builder's Connect picker writes this same contract.

Theme writes validate target paths and source types; stored documents of an older version read through the upgrade chain (`packages/shared/src/storefront-theme.md`, Compatibility). Objects resolve in the API's existing section read wave, with a bounded number of distinct types and `obj:<typeId>` dependency proofs. Public object rows must be published in a storefront-visible type. Unused sources add no database reads.

A component section may declare `reads: [{ object, where?, limit }]`. The host validates the declared type, visibility and indexed filter, resolves any setting-backed filter from the placement, and supplies the result as `objects` in its section props. An app cannot use this declaration to read private records or another app's namespace. Noor's testimonials exercise the Objects path.

## A storefront module

```tsx
// src/storefront.tsx (tsconfig: "jsxImportSource": "@scalius/plugin-sdk/storefront")
import { BuyForm, defineStorefront, editable, Image, Island, Price, quickAdd, raw, Reviews, type ProductMainProps, type SectionProps } from "@scalius/plugin-sdk/storefront";

function Featured({ settings, context }: SectionProps<{ heading: string; products: StorefrontProductCard[] }>) {
  return (
    <section class="acme-featured">
      <h2 {...editable(context, "heading")}>{settings.heading}</h2>
      <Island name="carousel" props={{ step: 1 }}>
        <ul>{settings.products.map((product, index) => (
          <li>
            <Image image={product.image} sizes="(min-width: 64rem) 25vw, 50vw" loading={index < 2 ? "eager" : "lazy"} />
            <a href={product.url}>{product.name}</a>
            <Price price={product.price} compareAt={product.compareAt} context={context} />
            <a {...quickAdd(product)}>Add to cart</a>
          </li>
        ))}</ul>
      </Island>
    </section>
  );
}

function ProductMain({ data }: ProductMainProps) {
  const { product } = data;
  return (
    <article class="acme-pdp">
      <div class="acme-pdp-media">{product.media.map((image, index) => <Image image={image} loading={index === 0 ? "eager" : "lazy"} />)}</div>
      <h1>{product.title}</h1>
      <BuyForm title={false} />
      <div class="acme-pdp-story">{raw(product.descriptionHtml)}</div>
      <Reviews />
    </article>
  );
}

export default defineStorefront({
  sections: { featured: Featured },
  skins: { "acme-card": Card, "acme-pdp": ProductMain },
});
```

The SDK's primitives:

- `Image`: responsive `<img>` with `srcset` and intrinsic size (no layout shift); lazy unless `loading="eager"`, which also sets `fetchpriority="high"` (`fetchpriority="auto"` keeps the rest of an eager first row at normal priority).
- `Price`: the market's formatted price with an accessible compare-at (`from` for "From …").
- `Island`: interactive markup (`hydrate`: `visible`, `idle`, `load`, `interaction`).
- `Deferred` (`hydrate`: `visible`, `idle`, `interaction`; `minHeight`): markup laid out only at its moment (below).
- `whenSignedIn()`, `whenSignedOut()`: the two versions of a signed-in part; the store shows the right one.
- `quickAdd(product)`, `openCart()`, `CartCount`: the core cart behaviour, no app JavaScript.
- `searchOpener()`, `accountLink()`: opt into the host's search and account actions; custom popovers remain valid.
- `menuDrawer()`: marks a header's menu drawer (a `popover` or `<dialog>`), which the store's phone tab bar opens.
- `stickyHeader()`: declare the actual sticky header box so core navigation and anchors reserve its space.
- `editable(context, key)`: marks the element that shows a text setting, so the editor edits it in place (preview only; the published page has no marks).
- `asset(context, "public/font.woff2")`: a public file's URL.
- `t(context, { en, bn, … })`: words in the page's language (exact BCP 47 tag, then its language, then English).
- `formatNumber`, `plural(context, count, { en: { one: "# review", other: "# reviews" } })`, `formatMoney(context, { amountMinor, currency })`, `formatDate`, `storeTime`: numbers, plurals, money and dates as the store writes them (`@scalius/shared/locale-format`); `context.store` carries the page's `language`, `locale` (language and the store's country), `currency` and `timeZone`, never a default.
- `BuyForm`, `Gallery`, `Reviews`, `Recommendations`, `Filters`, `Toolbar`, `Pagination`, `OrderForm`: core embeds (below).

JSX escapes every string. `raw(...)` passes HTML through; the output check still runs. Event handler attributes and functions as attributes are refused at render time.

### Section library previews

The editor renders a selected section through the same storefront renderer,
saved theme styles and active app assets, using the section's normal Add
defaults. There is no separate preview component for plugin authors to maintain.
The request carries the intended page context but fetches no buyer resource for
that path. Only the selected section renders; an empty result is shown as needing
content. Browsing is private and read-only: links, forms and network actions are
disabled, and the draft changes only when the merchant chooses Add. Test real
interaction in the main editor or storefront, not inside this library preview.

### Shared header behavior

Put `stickyHeader()` on the box with `position: sticky` or `fixed` and a top inset.
The host publishes its stuck height plus that inset as `--header-height`.
It selects the first visible eligible marker, so a responsive header can mark
both its outer box and a menu row that sticks only on desktop. Normal-flow,
hidden and `display: contents` boxes contribute nothing. Do not sum nested
markers or copy core header selectors. Transforms do not change the reservation;
keep visible header content within the declared box. Sliding it out may leave
a reserved gap. Use `--scalius-z-header` for its layer and
`--scalius-z-content-bar` for subordinate sticky content.

Core product navigation reserves its own height separately and prevents the
detail tab rail from stacking over it. A desktop buy bar reserves its height
before scrolling reveals it, so direct links stay clear; a phone bottom bar
never contributes to the top offset. Header geometry is observed on size,
breakpoint and markup changes, without a geometry read on every scroll.

A header gets the theme's phone navigation in `data.phoneNavigation`: `menu`
(`accordion` or `drill`, one level at a time) for its drawer, and `tabBar`.
With `tabBar` the store draws its own bottom tab bar under the skin on phones
(it reserves its height, and the product buy bar replaces it while shown); its
Categories tab opens the element marked `menuDrawer()`, and links to
/categories without one. Under a header skin the store also installs its menu
disclosure behaviour: a `button[data-disclosure="popup"][aria-controls]` in a
`[data-disclosure-item]` shows and hides its `hidden` panel with click, Enter,
Escape, a press outside and mouse hover intent, and a `ul[data-nav-overflow]`
row whose items carry `data-nav-index` (their top control `data-nav-link`)
gets arrow keys. `<html data-nav-disclosure>` appears once it runs, so CSS can
open menus on hover or focus only before then.

Search/account helpers attach optional attributes to your controls. Use native
buttons or links for keyboard behavior and supply a real link destination for
navigation without JavaScript. Modified clicks and events your code already
handled keep their native/custom behavior. Account authentication remains
server-authoritative; the cookie only chooses which UI to open.
Opening a host modal from a native popover closes that popover and restores
focus to its visible opener when the modal closes.

On the homepage, header jobs also receive `data.page.lead`: the first selected
render unit when desktop and phone ordering agree, otherwise `null`. App leads
include their identity; only a header from the same app receives normalized
settings with resolved media and empty product lists. This uses the existing
homepage read and affects only the header job's memo key. Other pages omit it.
An empty or failed leading component emits `data-scalius-lead-empty` on an inert
template. A header that overlays its lead must use this public marker to restore
solid styling and normal spacing. Noor demonstrates this without inspecting
private homepage wrappers or waiting for island hydration.

### Deferred markup

`<Deferred minHeight="28rem">…</Deferred>` renders `<scalius-deferred data-hydrate="visible" style="display:block;min-block-size:28rem"><template>…</template></scalius-deferred>`. The markup ships in the page and its cache, but the browser neither lays it out nor loads its images until its moment (`visible`: within 600px of the viewport; `idle`; `interaction`: the first hover, focus or tap in the element that holds it, such as a tab panel), when the store moves it into the page and mounts the islands inside. Use it for heavy parts below the fold (a review wall, a long rail, a map) so they never compete with the page's largest paint, and set `minHeight` to about their height so nothing shifts. Without JavaScript it never appears and crawlers read template content poorly: it is for enhancements, never for content crawlers or every buyer must see. Its content passes the same output check; core embeds and JSON-LD inside it render nothing (`renderSkin` and the packer report them). Deferreds may nest.

### Islands

```ts
// src/islands/carousel.ts
import { defineIsland } from "@scalius/plugin-sdk/island";

export default defineIsland<{ step: number }>((element, props, context) => {
  const list = element.querySelector("ul")!;
  const next = () => list.scrollBy({ left: list.clientWidth * props.step, behavior: "smooth" });
  element.querySelector("[data-next]")?.addEventListener("click", next);
  return () => element.querySelector("[data-next]")?.removeEventListener("click", next);
});
```

An island's module loads from `/_x/...` only when its moment comes, once per page however many times it appears. `context` carries the app's file base (`assets`), the store's `language` and `currency`, `formatMoney({ amountMinor, currency })`, the cart (`openCart`, `quickAdd(url)`, `onCart(listener)`, whose `total` is a `StorefrontMoney`) and `fetchApp(path)`, which reaches the app's public routes through the storefront proxy (`/apps/<id>/...`, same origin, no CSP host needed).

Return a cleanup for your listeners, timers and observers. The host cancels
pending hydration on removal, ignores imports from an old connection and
mounts again when the element reconnects. Host cart subscriptions are released
on removal or mount failure; your other resources still need that cleanup.

## Core embeds

`<scalius-embed kind="…">` hands a spot in the app's markup back to the store, which renders its own interactive piece there with its own data, rules, words and scripts. The markup around it is the app's. Each render allows its own kinds and counts (`storefrontEmbedRule`); any other embed renders nothing, and `renderSkin` and the packer reject it.

| Kind (SDK) | Where | Renders |
| --- | --- | --- |
| `buy_form` (`<BuyForm title={false} />`) | `product_main` (required, one) | `ProductBuyBox.astro`: the real buy form posting to `/buy/<slug>` |
| `gallery` (`<Gallery />`) | `product_main` (one) | `ProductGallery.astro`: the theme's gallery, kept in step with the buy form's variant |
| `reviews` (`<Reviews />`), `recommendations` (`<Recommendations />`) | `product_main` | the product's reviews and related products |
| `filters`, `toolbar`, `pagination` | `listing_main` | `CatalogEmbed.astro`: the GET filter form, sort and page size, page links |
| `order_form` (`<OrderForm product={…} />`) | component sections (two) | `OrderForm.astro`: the single-page order (below) |

### The single-page order

`<OrderForm product={settings.product} maxQuantity={5} />` places the store's own order form in the app's markup: option picker, quantity, name, phone, address. It is the Bangladesh-style landing page: the buyer orders without leaving the page.

- The embed names the product by id (`data-product`), and only a product the section's settings gave it orders: the storefront replaces the embed with `OrderForm.astro` (at most 2 per section).
  The server render input contains no buyer form data. The resulting form belongs
  to core; trusted browser islands share its page and can access its DOM.
- The form posts to `/checkout/quick`, the same cash-on-delivery pipeline as the product page's quick buy: stock, prices, the delivery quote, checkout functions and the order commit are the core's. The buyer confirms the total once and the order is placed.
- It renders only for products that can be ordered from a form (active, in stock, no customization, not a gift card); otherwise it links to the product page.
- The core styles it on the store's tokens (zero-specificity rules; `--of-radius`, `--of-line`, `--of-focus` change the basics), with sizes as compact chips and a price per option only when prices differ. Restyle it through `.scalius-order-form` and its parts.
- When the store cannot take the order there (cash on delivery off, checkout not ready, a product that needs input), buyers get a link to the product's page and the editor's preview says why.
- Noor's landing kit shows the pattern: `landing_hero` (photos, offer price, countdown, "Order now", call and WhatsApp), `landing_features` (cards, photo rows or numbered steps) and `landing_order` (the summary, assurances and the form at `#order`, with a sticky order bar on phones), arranged with any other section on a landing page. On landing pages Noor's header and footer switch to a campaign mode (logo and "Order now"; the legal line) unless the merchant keeps the full ones.

## Build, test, install

```sh
pnpm plugin create acme.studio      # scaffold, then add src/storefront.tsx and the manifest's storefront part
pnpm --filter ./plugins/studio test # vitest with @scalius/plugin-sdk/storefront/testing
pnpm plugin pack plugins/studio     # dist/ and, with --key, the signed upload ZIP
pnpm plugin add plugins/studio      # bundle into the fork (every plan)
```

`@scalius/plugin-sdk/storefront/testing` renders any section, block or skin with fixtures (`renderSection`, `renderBlock`, `renderSkin(module, id, target, settings?, data?)`, `renderHeader`, `renderFooter`, `renderProductCard`; `fixtureProductPage`, `fixtureListingPage`, `fixtureSectionSkinData`, `fixtureProductCard`, `fixtureContext`). `renderSkin` throws when the storefront would draw the core unit instead (`checkSkinHtml`: a missing buy form, an embed the target does not allow). The output runs through the same check the storefront applies.

`renderHeader` and the packer's header fixture render also check duplicate IDs,
declared form targets, unsafe action links, inert sticky markers and island
names/hydration. Pass `{ islands: ["menu"] }` to `renderHeader` to check names
against your manifest. `assertHeaderContract(html, { islands })` checks your own
rendered fixture. These are author diagnostics, not proof of visual correctness;
exercise the composed page in the gallery/browser too.

The packer (`packStorefront`):

1. Compiles `src/storefront.tsx` with esbuild (minified, one ES module) and checks it exports a definition whose sections, blocks and skins match the manifest.
2. Renders every section, block and skin once with fixture settings and its target's fixture projection (a smoke render), so a module that throws, or a skin that breaks its target's embed rule, fails the pack, not the store.
3. Compiles each island for browsers and checks it default-exports `defineIsland(...)`.
4. Copies the stylesheet (rewriting `url(../public/...)`) and the public files, checking their types by their bytes.
5. Checks the budgets and seals every file's SHA-256 into `plugin.js` (`//# scalius-storefront {...}`). The release signature covers `plugin.js`, so it pins every storefront file; install refuses a package whose files do not match.

## Budgets

| Limit | Value |
| --- | --- |
| Compiled module | 512 KiB |
| Stylesheet | 96 KiB |
| One island / all islands | 64 KiB / 192 KiB |
| Public files | 512 KiB each, 4 MiB and 40 files in all (woff2, woff, svg, png, jpg, webp, avif) |
| Markup per render | 256 KiB |
| Jobs per batch | 120 |
| Batch CPU (isolate) | 50 ms |
| Batch wall time | 250 ms, then the core units render |
| Sections, product blocks, skins, templates, page presets, islands, connect hosts | 32, 10, 30, 5, 8, 10, 10 |

Noor, a full theme, packs to a 40 KB module, 3.8 KB of islands and a 44 KB stylesheet.

## Performance

- **One call per app per page.** Every component an app draws on a page (header, footer, every card in a listing, every section) joins one batch, sent once (`ExtensionHost`). A product-main or listing_main skin is drawn first (the page needs to know whether core draws), so those pages make one more batch to the app.
- **Memo.** Each isolate keeps an LRU of rendered output (2,000 entries, 8 MiB) keyed by the app's release, the job and its context. A popular page's cards and chrome render once per isolate, not per request.
- **Bounded reads.** Skins and product blocks draw from data the page already has (the layout's menus and store info, the product part, the listing part, the homepage section data); their projections are built only when a skin draws. Component section data joins the page's existing batch. `apps/storefront/src/lib/route-tests/skins.render.test.ts` holds a skinned product page to one batch call.
- **Existing page cache.** Rendered pages use the storefront's dependency-validated
  HTML cache; do not add purge or generation-bump paths. Release files are
  immutable for a year (`/_x/<id>/<release>/`), so an update is a new URL. Installs
  live in the existing plugin tables and uploaded files in R2, keeping the data
  layer portable ([DATABASE-PORTABILITY.md](DATABASE-PORTABILITY.md)). Changes to
  plugin rendering inputs must participate in memo keys and cache dependencies.
- **Bounded fallback.** Caught render failures use the core block (a section renders
  nothing), with a bounded warning naming the app and reason. One failed job fails only
  itself; a module that cannot load, throws or answers after the 250 ms wall falls back
  for its whole batch, and the page is never stored (`compose-app.render.test.ts`,
  `host.test.ts`). An isolate also stops at its 50 ms CPU limit. This does not detect
  broken layout or incorrect interaction. A wall timeout cannot interrupt
  synchronous code blocking the bundled host's event loop (bundled apps are trusted
  deployment code).

## Security and transparency

The merchant owns their apps (private or uploaded). The platform makes what an app can do visible and bounded:

- Activation shows the access the app asks for. Drawing on the storefront is its own grant (`storefrontCode`), and every browser host its islands may reach (`storefrontConnect`) is listed; a Super Admin approves both. An update that asks for more waits for approval.
- The render input supplies settings, public page data and context, not buyer
  sessions or secrets. Uploaded modules run in a Dynamic Worker with no bindings,
  denied outbound network and a CPU limit. Bundled modules execute in the host
  Worker: they are trusted deployment code, not an equivalent security sandbox.
  Structured cloning protects the passed values; it does not isolate execution.
- Browser islands are trusted same-origin JavaScript. They can access page DOM
  (including embedded forms) and make requests permitted by browser policy.
  Activation approval, CSP and server authorization are boundaries; HTML
  sanitization does not sandbox an approved island. HttpOnly cookies prevent
  reading cookie values, not making otherwise-authorized same-origin requests.
- Output passes `sanitizePluginHtml` (`component` profile), an allowlist. It keeps content, list, table and form elements, `h1`, `video`, an SVG drawing subset, islands, deferred markup and core embeds; classes; `id`s that start with the app name (`noor-…` for `scalius.noor`); inline style without loading functions (`url()`, `image-set()`, …), escapes or comments; forms that post to a store path; and schema.org JSON-LD (dropped on `noindex` pages). It drops everything else: `<script>`, `<style>` (CSS belongs in the stylesheet), `<iframe>`, `<noscript>`, `<template>` (except as deferred markup's content), `<math>`, SVG animation and `foreignObject`, event handlers, `data-sx-*` (host attributes), and every URL that is not a store path, `http(s)` (the store's media origin is http on a local stack), `mailto`, `tel` or a fragment. Test with `storefrontShown(html, pluginId)` (`/storefront/testing`): `dropped` counts what it left out.
- App components, their islands, stylesheets and connect hosts never reach a buyer's page (cart, checkout, the receipt, account, payment recovery, order tracking; `appComponentsRenderOn` in `apps/storefront/src/lib/app-scripts.ts`): the core chrome renders there.
- Island code is served from the store's origin under its release; CSP `script-src` gains nothing. Connect hosts join `connect-src` and `img-src` only, on pages whose theme uses the app.
- A page drawn with a fallback (a component late, failed, refused, or a release the isolate cannot load) is never stored in the page cache.
- SVG files are served with a sandboxing CSP and `nosniff`.

## Stored themes

The document keeps skins under `apps.skins` (`header`, `footer`, `product_card`, `product_main`, `listing_main`) and a core section's own `skin`. Stored themes are never reset: a shape change ships an upgrade step (`packages/shared/src/storefront-theme.md`, Compatibility).

## Versioning

The component ABI (`STOREFRONT_COMPONENT_ABI`) and the data shapes are part of the plugin API (`PLUGIN_API_VERSION`): within a version they only gain optional fields. A breaking change bumps the ABI with a changelog entry; app authors repack, merchants update the app. Merchants never touch storefront code.

The ABI snapshot gate (`packages/shared/src/plugins/abi.snapshot.test.ts`) captures manifest JSON Schema, SDK declarations, protocol constants, events and public handler schemas. Stable HTTP operations have a separate compatibility gate. Review an additive change before updating a snapshot; a snapshot update cannot authorize a breaking change.

See [UI verification](UI-VERIFICATION.md) for the composed-journey release bar. `pnpm plugin preview <path>` and `pnpm plugin dev <path>` provide static fixture previews; core embeds are placeholders and require local-store verification of their real behavior.
