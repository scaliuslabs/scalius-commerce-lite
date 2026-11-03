# Storefront

An app can redesign a store without a fork: new sections, components in slots and app pages, skins of the header, footer, product card, product page, listings and any core section, a single-page order landing, and ready-made templates that apply a whole look in one click. The merchant activates the app, picks its template in the theme editor and edits every part like the built-in ones.

This page is the storefront reference. Building a theme? Read [Build a theme](themes.md) first: it is the path through this page and the rules that make a theme work on any store, not only yours. [Apps](apps.md) covers the manifest and lifecycle; Buyer UI on private pages (cart, checkout, account) is in [Commerce hooks](commerce-hooks.md#buyer-ui-extensions). The reference theme is `plugins/noor` in the Scalius repository.

The contract is `@scalius/shared/plugins/storefront-protocol` (data shapes, render protocol, limits) and `@scalius/shared/plugins/storefront-components` (manifest declarations). The SDK entries are `@scalius/plugin-sdk/storefront`, `@scalius/plugin-sdk/storefront/testing` and `@scalius/plugin-sdk/island`.

## The model

Your storefront module is compiled once, when you pack the app. It is not rebuilt per store.

- **Server components.** JSX (or `html` templates) that build HTML strings. A component is a pure function of its input: the resolved settings, the data the page already read, and the render context. No network, no storage, no bindings, no clock: time-bound markup (a countdown) takes its end time from data and counts down in an island.
- **Islands.** The only app JavaScript a buyer's browser runs. An island mounts on server-rendered markup at its moment (visible, idle, load or first interaction). The page works before and without it.
- **One stylesheet.** Linked only on pages that show your components. Style through the store's tokens (`--color-*`, `--font-*`, `--radius-*`) so the merchant's colours and type still apply.
- **Public files.** Fonts and images, immutable, served from the store's own origin under `/_x/<app id>/<release>/`.

The store runs your module in one of two loaders, with the same input and output:

- **Bundled** (every plan): compiled into the storefront Worker and shipped by the store's next deploy.
- **Isolate** (Workers Paid): an uploaded or registry app runs in a Dynamic Worker with no network at all and a 50 ms CPU limit per batch. Upload, activate, done.

Set `"jsxImportSource": "@scalius/plugin-sdk/storefront"` in your `tsconfig.json` (the scaffold does).

## Extension points

| Point | Declare (`storefront.*`) | Implement (`defineStorefront`) | Limit |
| --- | --- | --- | --- |
| Section | `sections: [{ type, name, settings, reads? }]` | `sections[type]` | 32 |
| Component (slots and app pages) | `components: [{ type, name, targets, settings }]` | `components[type]` | 16 |
| Skin of a unit or a core section | `skins: [{ id, target, name, settings }]` | `skins[id]` | 30 |
| Template | `templates: [{ id, name, themeVersion?, theme }]` | | 5 |
| Page preset | `pagePresets: [{ id, name, themeVersion?, sections }]` | | 8 |
| Island | `islands: [{ name }]` | `src/islands/<name>.ts` with `defineIsland` | 10 |
| Stylesheet | `stylesheet: true` | `src/storefront.css` | 1 |
| Browser hosts for islands | `connect: ["api.example.com"]` | | 10 |
| Scripts | `scripts: [{ src, placement, pages }]` | | 5 |
| Head tags | `head: true` | | |
| Proxy pages | `proxy: true` | public routes answering `{ page }` | |

Sections and components have no render route: they run at the edge with data the page batch already supplied. No route returns HTML. A proxy page (`/apps/<id>/*`) answers `{ page: { title, component, props } }` and the store draws your `page` component from `props`.

**Scripts** load over https, non-blocking, on `all`, `home`, `product` or `listing` pages only. Their hosts join the storefront CSP. **Head tags** add up to 10 meta tags and 3 JSON-LD blocks (16 KiB each) to public pages; the page keeps its own `robots`, `description`, `og:` and `twitter:` tags.

A **template** holds theme values (`tokens`, `blocks`, `apps` and homepage `sections`, at most 64 KiB) that the theme library applies, keeping the merchant's content. A **page preset** is a ready-made landing page (1 to 24 sections, 64 KiB): when the merchant makes a new landing page, the editor offers a blank page or the active apps' presets, and fills `product` settings with a product the merchant picks. Both are written for one theme document version (`themeVersion`, absent means 10). The store upgrades them through its upgrade chain before listing; one that still does not fit is left out and named, with the reason, on the app's page.

A template's product card fields (`blocks.card.fields`) are store data: a store applies the template keeping only the ones that are storefront-visible product fields there, and tells the merchant which it left out. `custom.<key>` is the merchant's namespace, which an app cannot create; your own `<app id>.<key>` field exists in a store once your app writes a value. `pnpm plugin validate` warns about each card field no store is sure to have.

## Slots

A slot is a named place where apps add their piece.

**Component slots** are on public pages:

| Slot | Where | What the component gets |
| --- | --- | --- |
| `header.actions` | The header, beside search, account and cart | settings, context |
| `footer.columns` | Footer columns, after the store's menus | settings, context |
| `product.buy_box.before` | The buy box, before price and options | the product page (`data`), `instanceId` |
| `product.buy_box.after` | The buy box, after the buttons | the product page, `instanceId` |
| `product.below` | After the product page's modules | the product page, `instanceId` |
| `product_card.badges` | Every product card, over the photo | the card (`data`) |
| `product_card.meta` | Every product card, under the price | the card (`data`) |
| `page` | An app page the proxy answers | `props` |

- The product slots are placed by the merchant in the theme's product page (at most 10 app components on one product page), with their own values. A component has at most one product slot among its targets.
- Every other slot draws every active app's component that targets it, with default values.
- Card slots render on every card, whoever draws it: core or another app's card skin. So your badge appears on cards another app's skin draws, from the card's own projection.
- Core's header, footer, product page and card place their slots. A skin of a unit places that unit's slots with `<Slot name="header.actions" />`, `<Slot name="footer.columns" />`, `<Slot name="product_card.badges" />` and `<Slot name="product_card.meta" />`. A footer's `footer.columns` also carries the store's country and language forms; a footer skin that places no slot gets them right after it. A header's `header.actions` also carries the merchant's light or dark switch when the theme offers one, so a header skin never drops it; a header skin that places no slot gets it right after it. If your skin (or an app in the slot) draws its own `colorSchemeToggle()` button, the store's yields to it: a header never shows two.
- An empty slot renders nothing and costs no read.

**UI slots** are on the buyer's own pages (cart, checkout, receipt, account, order tracking, payment recovery, warranty claims, the gift-card balance), filled by storefront extensions (`storefront.extensions`) with a `ui` tree that core draws. No app HTML or JavaScript runs there.

| Page | UI slots |
| --- | --- |
| Cart page (checkout's first step) | `checkout.contact.after`, `checkout.delivery.after`, `cart.page.summary`, `cart.page.below` |
| Payment step | `checkout.payment.after`, `checkout.actions.before`, `checkout.summary.after` |
| Cart drawer (every page) | `cart_drawer.footer` |
| Thank-you and order status | `order.confirmation`, `account.order` |
| Account | `account.overview`, `account.profile` |

## Components

A component renders at each of its `targets`. Its props depend on the target, so narrow them with `switch (props.target)`:

```tsx
import { defineStorefront, type ComponentProps } from "@scalius/plugin-sdk/storefront";

function Points(props: ComponentProps<{ label: string }>) {
  switch (props.target) {
    case "product.buy_box.after":
      return <p class="acme-points">{props.settings.label}: {props.data.product.title}</p>;
    case "product_card.meta":
      return <span class="acme-points">{props.settings.label}</span>;
    case "page":
      return <section class="acme-points-page">{String(props.props.balance ?? 0)}</section>;
    default:
      return null;
  }
}

export default defineStorefront({ components: { points: Points } });
```

Or let the SDK type the props by the targets you list. `componentFor(targets, render)` types `render`'s props by those targets and throws for any other target, so `pnpm plugin validate`'s smoke render catches a manifest that names a target your code does not handle:

```tsx
import { componentFor, defineStorefront } from "@scalius/plugin-sdk/storefront";

const Points = componentFor(["product.buy_box.after", "product_card.meta"], (props) =>
  props.target === "product_card.meta"
    ? <span class="acme-points">{props.data.product.title}</span>
    : <p class="acme-points">Earn points on {props.data.product.title}</p>);

export default defineStorefront({ components: { points: Points } });
```

The per-target prop types are `ProductSlotComponentProps`, `ProductCardSlotComponentProps`, `LayoutSlotComponentProps` (the header and footer slots) and `PageComponentProps`; `ComponentPropsFor<Target>` maps a target to its props. Type a component's settings from your manifest with `StorefrontSettingsOf<typeof manifest, "component", "points">`.

Like a skin, a component reads nothing of its own: its settings name no images or products.

## Skins

A skin is app markup for a core-owned unit. It gets the unit's public projection, the same data the core renderer draws from. Core draws the unit itself whenever the skin is missing, its app is inactive, or it draws nothing, fails, is late or misses a required embed. A theme never breaks.

| Target | `data` | Core embeds it may place | Fallback |
| --- | --- | --- | --- |
| `header`, `footer` | `StorefrontHeaderData`, `StorefrontFooterData` | its slots | empty: core |
| `product_card` | `StorefrontProductCardData` (`{ product, position, aboveFold }`) | its two slots | empty: core |
| `product_main` | `StorefrontProductPage` | `buy_form` (required, exactly one), `gallery`, `reviews`, `recommendations`, `product_module` (each module once) | no buy form: core |
| `listing_main` | `StorefrontListingPage` | `filters`, `toolbar`, `pagination` (only an omitted `pagination` is appended; place `filters` and `toolbar` yourself) | empty: core |
| `section:<type>` | `StorefrontSectionSkinData<StorefrontSectionSkinSettings[type]>` | none | empty: the core section |

- **`product_main`** draws the product page's breadcrumbs, gallery and buy box. `<BuyForm />` is the store's real buy form: price, options, buyer inputs, quantity, buttons, delivery facts and the buy-box app components, kept current as the buyer chooses. `<Gallery />` is the theme's gallery (thumbnails and zoom on computers, a swipeable photo on phones, the chosen SKU's photo); its first photo is preloaded. Prefer it to drawing `product.media` yourself. To offer the SKUs your own way, see [Your own SKU controls](#your-own-sku-controls). The skin owns the description (`descriptionHtml`). Reviews and related products a skin places replace the template's modules of the same.
- **Product modules in a skin.** `<ProductModule name="spec_table" />` draws one of the theme template's product modules where the skin puts it, with the store's own renderer, words and scripts, and leaves it out from below. Each renders once, and only when the template has it and the product has something for it; otherwise nothing renders there. Never move the store's markup with an island. The names (`STOREFRONT_PRODUCT_MODULE_EMBEDS`, exported by the SDK) are the theme's own module ids, as a template's `blocks.product.below` lists them:

  | Name | Draws | Renders when |
  | --- | --- | --- |
  | `description` | The store's details tabs: the description, the merchant's extra tabs and the key features (when the buy form does not list them). A skin that places it does not draw `descriptionHtml` itself. | The product has any of them, even where the theme's template lists no description module |
  | `spec_table` | The specification table | The product has specifications |
  | `key_attributes` | The key-spec highlights | The table has more rows than key specs, and the theme's buy box lists no facts column |
  | `about_bullets` | "About this item": the key features | The theme's buy box does not list the features (`<BuyForm />` does then) |
  | `content_blocks`, `compare_similar`, `policies` | The content blocks, compare with similar items, the store's policies | The product or store has them |
  | `recently_viewed` | This browser's recently viewed products | The template lists it; it holds no space until the browser fills it, so place it below the fold |

  Reviews and related products have their own embeds. The warranty is part of `<BuyForm />`, never a module. A placed module keeps its heading.
- A buy column that should stay in view beside the gallery marks itself `data-sticky-column` and writes its top as `calc(<offset> + var(--sticky-column-shift, 0px))`.
- **`listing_main`** draws the listing between the collection template's sections. Page links are numbered links on every listing, so crawlers reach every product.
- **Filter placement is the merchant's.** `<Filters />` draws the form in the placement the listing resolves (the theme's filter style, or the category's own): a sidebar (`sidebar-dense`, `sidebar-comfortable`) or a bar of dropdowns (`bar-dropdowns`). A skin cannot pick another one. A `drawer` style draws as a sidebar in the embed, since an embed cannot host the drawer's dialog. Below 64rem the form stays inline in every placement; there is no phone sheet. Without JavaScript a bar shows all its groups.
  - Style the wrapper with `[data-catalog-embed="filters"][data-placement="sidebar"]` and `[data-catalog-embed="filters"][data-placement="bar"]`. A bar spans its row: a skin that puts `<Filters />` in a fixed-width column needs a `[data-placement="bar"]` rule that lets it run across the results.
  - The wrapper carries the style's measured numbers as `--catalog-filter-column` (a sidebar's width), `--catalog-filter-row` (a row's height) and `--catalog-filter-label` (the label size). Read or override them; a missing property means the theme's density token applies.
- **Core sections.** Each skinnable section type has its own sealed projection (`StorefrontSectionSkinSettings`, `StorefrontHeroSkinSettings`, …) with its own version. Core's stored settings never reach a skin. Images arrive as `StorefrontImage | null`, product sources as `products` (`{ title, url, cards }`), categories and collections as tiles, a promotion as `{ endsAt } | null`. A projection only gains optional fields; when core changes a section, the host adapts it so your input stays the same. `aboveFold` is true for the homepage's lead section: load its first row of photos eagerly. `recently_viewed`, `endless_grid` and `objects` have no skin.
- **The header** gets menu items (three levels, at most `STOREFRONT_COMPONENT_LIMITS.menuItems`: the store's header menu and category cut fit whole, a larger tree is cut top levels first and a parent's page lists the rest) with their category's photo, `routes.orders` and `routes.trackOrder`, `searchScopes` (the top published categories) with `searchScopeParam` (a form sending `category=<value>` to `routes.search` searches that category, no JavaScript needed), `market` (country, currency, language and the country form's selection), and the theme's phone navigation (`phoneNavigation.menu`: `accordion` or `drill`; `tabBar`). Signed-in state is not data, since one header serves every buyer: mark the two versions with `whenSignedIn()` and `whenSignedOut()` and the store shows the right one before first paint. On the homepage the header also gets `data.page.lead`, the first section when desktop and phone order agree.
- **The product page** carries `sku` (a product without options), each variant's `sku`, `installments` (`{ provider, months, monthly }`, the cheapest EMI plan) or null, and `specifications`: the specification table's rows in its order (`{ group, label, value, unit, keySpec }`, plain text). `value` is the stored text, canonical data (ASCII digits, a "." decimal): a number already carries its unit ("15.6 inch"), and `unit` names that unit ("inch"; null for other attributes), so never append it again. The store's own table writes a number in the page's digits ("১৫.৬ inch" on a Bangla page). A category listing carries `children` (published child categories with photos).
- **A card** carries `keySpecs` (`{ label, value, unit }`, the same shape), the key specs among its `facts` lines, which the card writes from these rows as `label: value` (a number in the page's digits; the rows stay canonical). Read them instead of splitting `facts`.
- **Every unit's context** carries `context.store.logo` (`StorefrontImage | null`), the logo the store's header draws, and `context.store.darkLogo`, its version for dark pages (swap them as the header data's `darkLogo` says).
- JSON-LD stays core's on product and listing pages: the host strips app JSON-LD from `product_main`, `listing_main` and product-slot components.

### Header behaviour

- Put `stickyHeader()` on the box with `position: sticky` or `fixed`. The host publishes its stuck height as `--header-height`. Use `--scalius-z-header` for its layer and `--scalius-z-content-bar` for subordinate sticky content.
- `menuDrawer()` marks the header's menu drawer (a `popover` or `<dialog>`); the store's phone tab bar opens it.
- `searchOpener()` and `accountLink()` opt your controls into the host's search and account actions. Use native buttons or links with real destinations.
- `colorSchemeToggle()` makes a native `<button type="button">` the buyer's light or dark switch. It shows only when the theme offers the switch and JavaScript runs; the host flips `<html data-color-scheme>` and remembers the choice on the buyer's device.
- Under a header skin the store installs its menu disclosure behaviour: a `button[data-disclosure="popup"][aria-controls]` inside `[data-disclosure-item]` shows and hides its `hidden` panel (click, Enter, Escape, a press outside, hover intent), and a `ul[data-nav-overflow]` row whose items carry `data-nav-index` gets arrow keys. `<html data-nav-disclosure>` appears once it runs.
- A header that overlays an empty or failed lead must restore solid styling when it sees `data-scalius-lead-empty`.

## Settings

Sections, components and skins use the app settings types (`text`, `textarea`, `number`, `boolean`, `select`, `url`, `color`) and five more, up to 40 settings each:

| Type | Stored | The component gets |
| --- | --- | --- |
| `image` | a media id | `StorefrontImage` (`url`, `width`, `height`, `alt`, `srcset`) or `null` |
| `products` (`limit` up to 36) | a source: `newest`, `on-sale`, `popular`, `collection:<id>` or `category:<id>` | up to `limit` `StorefrontProductCard`s, priced in the buyer's market |
| `product` | a product id | one card or `null` |
| `link` | a store path or an `https://` URL | the string |
| `list` (`fields` up to 12, `max` up to 24, `itemLabel`) | items of the fields above (no products, no lists) | items with their images resolved |

- Values resolve against the schema as it is now: a removed setting drops, a new one takes its default, a deleted image or product resolves to `null`.
- Skins and components cannot use `products` or `product`. A unit skin (header, footer, card, product page, listing) may declare up to 8 top-level `image` settings, which resolve with the layout read at no extra cost. Section skins, components and images inside a skin's `list` ship their images in your public files.
- The page reads every image, product list and picked product its sections name in one batch, within the homepage limits (40 images, 8 product lists).

## Bindings and Objects

A section, component placement or skin may store `bindings` beside its literal settings: each setting path maps to `{ source }`, for example `heading: { source: "resource.title" }` or `subtitle: { source: "object.custom.testimonials.featured.quote" }`.

- Sources cover the resource's title, description, image and URL, `resource.cf.<namespace>.<key>` custom fields, a published object field, or an object list.
- The literal value is the fallback when a source is missing or incompatible.
- Unused sources add no reads.

A section may declare `reads: [{ object, where?, limit }]` (at most 2; `limit` up to 24; up to four indexed filters, each a literal or `{ setting }`). The host checks the type, its visibility and the indexed filter, and passes the records as `objects` in the section's props. A section never reads private records or another app's namespace.

## A storefront module

```tsx
// src/storefront.tsx
import {
  BuyForm, defineStorefront, editable, Image, Island, Price, quickAdd, raw, Reviews, Slot,
  type ProductCardProps, type ProductMainProps, type SectionProps, type StorefrontProductCard,
} from "@scalius/plugin-sdk/storefront";

function Featured({ settings, context }: SectionProps<{ heading: string; products: StorefrontProductCard[] }>) {
  return (
    <section class="acme-featured">
      <h2 {...editable(context, "heading")}>{settings.heading}</h2>
      <Island name="carousel" props={{ step: 1 }}>
        <ul>{settings.products.map((product, index) => (
          <li>
            <Image image={product.image} sizes="(min-width: 64rem) 25vw, 50vw" loading={index < 2 ? "eager" : "lazy"} />
            <a href={product.url}>{product.title}</a>
            <Price price={product.price} compareAt={product.compareAt} context={context} />
            <a {...quickAdd(product)}>Add to cart</a>
          </li>
        ))}</ul>
      </Island>
    </section>
  );
}

function Card({ data }: ProductCardProps) {
  return (
    <article class="acme-card">
      <Slot name="product_card.badges" />
      <Image image={data.product.image} loading={data.aboveFold ? "eager" : "lazy"} />
      <a href={data.product.url}>{data.product.title}</a>
      <Slot name="product_card.meta" />
    </article>
  );
}

function ProductMain({ data }: ProductMainProps) {
  const { product } = data;
  return (
    <article class="acme-pdp">
      <h1>{product.title}</h1>
      <BuyForm title={false} />
      <div class="acme-pdp-story">{raw(product.descriptionHtml)}</div>
      <Reviews />
    </article>
  );
}

export default defineStorefront({
  sections: { featured: Featured },
  skins: { acme_card: Card, acme_pdp: ProductMain },
});
```

The keys of `sections`, `components` and `skins` match the manifest's section types, component types and skin ids.

### Primitives

- `Image`: a responsive `<img>` with `srcset` and intrinsic size (no layout shift). Lazy unless `loading="eager"`, which also sets `fetchpriority="high"`; pass `fetchpriority="auto"` for the rest of an eager first row.
- `Price`: the market's formatted price with an accessible compare-at (`from` for "From …").
- `Island`: interactive markup (`hydrate`: `visible` (default), `idle`, `load`, `interaction`). Its `props` are JSON in the page, at most 16 KiB (`islandPropsBytes`).
- `Deferred`: markup laid out only at its moment (below).
- `Slot`: a unit's component slot, in place.
- `whenSignedIn()`, `whenSignedOut()`: the two versions of a signed-in part.
- `quickAdd(product)`, `openCart()`, `CartCount`: the store's cart behaviour with no app JavaScript.
- `chooseVariant(variant)`, `buyVariant(variant, "add" | "buy")`: your own SKU controls on the product page, run by the store's buy form (below).
- `searchOpener()`, `accountLink()`, `colorSchemeToggle()`, `menuDrawer()`, `stickyHeader()`: header behaviour (above).
- `editable(context, key)`: marks the element that shows a text setting, so the editor edits it in place. Preview only; the published page has no marks.
- `asset(context, "fonts/display.woff2")`: the URL of a file in your package's `public/` folder. The helper adds `public/` itself, so pass the path inside it.
- `t(context, { en, bn, … })`: words in the page's language (the exact BCP 47 tag, then its language, then English).
- `formatNumber`, `plural(context, count, { en: { one: "# review", other: "# reviews" } })`, `formatMoney(context, money)`, `formatDate`, `storeTime`: numbers, plurals, money and dates as the store writes them. `context.store` carries the page's `language`, `locale`, `currency` and `timeZone`, and the store's `logo`.
- `BuyForm`, `Gallery`, `Reviews`, `Recommendations`, `ProductModule`, `Filters`, `Toolbar`, `Pagination`, `OrderForm`: core embeds (below).

JSX escapes every string. `raw(...)` passes HTML through; the output check still runs. Event handler attributes and functions as attributes are refused at render time. Money on the storefront is `StorefrontMoney`: `{ amountMinor, currency, formatted }`.

### Deferred markup

`<Deferred minHeight="28rem">…</Deferred>` ships the markup in the page and its cache, but the browser neither lays it out nor loads its images until its moment: `visible` (within 600px of the viewport, the default), `idle`, or `interaction` (the first hover, focus or tap in its container). The store then moves it into the page and mounts the islands inside.

- Use it for heavy parts below the fold (a review wall, a long rail, a map) and set `minHeight` (a CSS length) to about their height so nothing shifts.
- Without JavaScript it never appears, and crawlers read it poorly. Never put content crawlers or every buyer must see in it.
- Core embeds and JSON-LD inside it render nothing. Deferreds may nest.

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

- An island's module loads from the store's origin only when its moment comes, once per page however often it appears.
- `context` carries your file base (`assets`), the store's `language` and `currency`, `formatMoney`, `signedIn()`, the cart (`openCart`, `quickAdd(url)`, `addLine({ variantId, quantity?, purchaseOption? })` for a SKU without buyer inputs, one-time or under one of your own purchase options, and `onCart(listener)`, whose `total` is `StorefrontMoney`), and `fetchApp(path)`, which reaches your public routes through the storefront proxy (same origin, no CSP host needed).
- An island's `props` are at most 16 KiB of JSON (`STOREFRONT_COMPONENT_LIMITS.islandPropsBytes`). Larger props are left out and the island mounts with `props` undefined; `storefrontShown`, `checkSkinHtml` and `pnpm plugin validate` name it. Load more with `fetchApp`, never by hiding data in extra markup.
- On a product page, `context.product` gives `state()` and `onChange(listener)`, with or without buyer inputs. The state is `{ variantId, quantity, inputs, purchaseOption, available, busy, error }`: `available` means the chosen SKU can be bought now, `busy` that an add or Buy now is running, and `error` why the form refused the last one (`StorefrontProductError`, one of `STOREFRONT_PRODUCT_ERRORS`: `option_required`, `input_invalid`, `unavailable`, `quantity_limit`, `failed`; null otherwise). The list only grows, at its end: treat a code you don't know as `failed`. `option_required` and `input_invalid` go when the buyer gives the option or fixes the field; the others go as soon as the buyer changes the SKU, quantity, an answer or the purchase option. A listener runs after the store has applied the change: the form, its SKU field and the gallery already show it, and `state()` equals the listener's state. Between a click and that moment, `state()` still returns what the page shows. To choose or buy from your own markup, use `chooseVariant` and `buyVariant`, not clicks on the form's elements.
- Return a cleanup for your listeners, timers and observers. The host cancels pending hydration on removal and mounts again when the element reconnects.

## Core embeds

`<scalius-embed kind="…">` hands a spot in your markup back to the store, which renders its own interactive piece there with its own data, rules, words and scripts. The SDK components write the tags. Each render allows its own kinds and counts; any other embed renders nothing.

The store adds kinds, module names and error codes over time: `StorefrontEmbedKind`, `StorefrontProductModuleEmbed` and the product error codes are unions read from lists that only grow. Never switch over one exhaustively (a `Record<StorefrontEmbedKind, …>` or a `never` check stops compiling when the list grows); handle the values you know and ignore the rest.

| Kind (SDK) | Where | Renders |
| --- | --- | --- |
| `buy_form` (`<BuyForm title={false} options={false} />`) | `product_main` (required, one) | The real buy form |
| `gallery` (`<Gallery />`) | `product_main` (one) | The theme's gallery, in step with the chosen variant |
| `reviews`, `recommendations` | `product_main` | The product's reviews and related products |
| `product_module` (`<ProductModule name="…" />`) | `product_main` (each name once) | One of the template's product modules, left out from below |
| `filters`, `toolbar`, `pagination` | `listing_main` | The filter form, sort and page size, page links |
| `order_form` (`<OrderForm product={…} />`) | sections (up to two each) | The single-page order form |
| `slot` (`<Slot name="…" />`) | header, footer and card skins | A component slot |

### Your own SKU controls

A product page skin can offer the SKUs its own way (denomination cards, a comparison table, a row per plan). The store's buy form still does the buying.

```tsx
{data.product.variants.map((variant) => (
  <li class="acme-plan">
    <a {...chooseVariant(variant)}>{variant.title} <Price price={variant.price} context={context} /></a>
    <button {...buyVariant(variant, "add")}>Add to cart</button>
    <button {...buyVariant(variant, "buy")}>Buy now</button>
  </li>
))}
<BuyForm title={false} options={false} />
```

- `chooseVariant(variant)` chooses that whole SKU (every option axis at once) through the form, so price, stock, buttons, gallery and `context.product` follow. It needs JavaScript. Put it on an `<a>`: the host makes it a link to the product with that SKU (`?variant=`), which the store's script opens on, so a press before the script has bound the click still lands on the SKU. Without JavaScript the link only opens the same page, where the form's own picker chooses; your buy buttons still buy.
- `buyVariant(variant, "add" | "buy")` goes on a `<button>`. It chooses the SKU, then, once the page shows it, runs the form's own Add to cart or Buy now. Inside a choice card (`<a {...chooseVariant(v)}>… <button {...buyVariant(v, "add")}>`) the button buys. That run uses the form's checks, buyer inputs, purchase options, quantity and one-at-a-time guard. A problem shows inside the form, which takes focus. Without JavaScript the button submits the form with its own SKU.
- The host binds these attributes after it checks your markup; you never write `form=` or a handler. It does so in product_main skins only; elsewhere they do nothing.
- The host owns these attributes on your controls:
  - `data-availability` (`available`, `sold-out`) on both.
  - On a choice: `data-state` (`selected`, `unselected`), plus `aria-current` on a link or `aria-pressed` on a button. The SKU the page opens on (or a `?variant=` link names) is drawn chosen before the first paint; a link that also carries `buyVariant` only chooses. Controls inside `<Deferred>` take the form's state when they enter the page.
  - On a buy button: `type`, `disabled`, `hidden` and `aria-busy`. It is off while its SKU is sold out or the product cannot be bought here, as the form's own buttons are (a `"buy"` button is then gone), busy while it adds, and hidden while the buyer edits a cart line (the form's "Update cart" replaces that line).
- `<BuyForm options={false} />` leaves out the form's option buttons only when your controls cover every SKU that can be bought. Otherwise the store draws them, so no buyer is stuck. Buyer inputs, purchase options, quantity, messages and the form's own buttons always stay. So does the no-JavaScript picker.
- `data.product.variants` lists every SKU, up to the catalog's 150.

### Styling the buy form

The form's parts carry `data-buy-part`:

| Part | `data-state` |
| --- | --- |
| `price` | |
| `options` | |
| `inputs` | |
| `purchase-options` | |
| `quantity` | |
| `actions` | `ready`, `busy`, `unavailable` |
| `status` | `idle`, `error` |

`status` holds the form's message when it refuses an add. The part names and states are permanent. Their nesting and the classes inside them are not, so never depend on them.

### The single-page order

`<OrderForm product={settings.product} maxQuantity={5} />` places the store's own order form in your markup: option picker, quantity, name, phone, address. The buyer orders without leaving the page.

- Only a product the section's own settings gave it orders.
- It posts to the store's cash-on-delivery pipeline: stock, prices, the delivery quote, checkout functions and the order commit are the store's.
- It renders only for products a form can order (active, in stock, no customization, not a gift card). When the store cannot take the order there, buyers get a link to the product page and the editor's preview says why.
- Restyle it through `.scalius-order-form` and its parts; `--of-radius`, `--of-line` and `--of-focus` change the basics.

## Build, test, preview

```sh
pnpm plugin create acme.studio --theme --dir ~/code/acme-studio   # the theme starter (drop --theme for a general app)
npm test                                              # vitest with @scalius/plugin-sdk/storefront/testing
pnpm plugin validate ~/code/acme-studio               # every store check, including a smoke render and portability
pnpm plugin preview ~/code/acme-studio                # dist/preview.html on a sample, an empty and another store
pnpm plugin pack ~/code/acme-studio --key <folder>    # dist/ and the signed upload ZIP
```

### Test helpers

`@scalius/plugin-sdk/storefront/testing` renders through the same batch protocol the store uses, and holds the output to the same rules:

- `renderSection(module, type, settings?, options?)`: a section's HTML.
- `renderComponent(module, type, target, settings?, options?)`: a component's HTML at one target. In a product slot it draws over the fixture product page (or `options.data`); on `page` it takes `options.props`. It throws when the component places an embed a component may not place.
- `renderSkin(module, id, target, settings?, data?, options?)`: a skin's HTML over its target's fixture projection (or yours). It throws on every problem `checkSkinHtml` names, and on invalid header markup.
- `renderHeader`, `renderFooter`, `renderProductCard`: `renderSkin` for those units, merging your partial data over the fixture. `renderHeader` also checks duplicate ids, form targets, unsafe action links, sticky markers and island names; pass `{ islands: ["menu"] }` to check names against your manifest.
- `assertHeaderContract(html, { islands })`: the same header checks on your own markup.
- `checkSkinHtml(target, html)`: the problems the store would find in a skin's markup: a missing required embed (it then draws the core unit instead), an embed the target does not allow (it renders nothing), and an island whose props are over 16 KiB (it mounts with none).
- `storefrontShown(html, appId)`: what the store shows of your markup after its output check, and how many elements and attributes it `dropped`. Assert `dropped` is 0. `oversizedProps`, present only then, names the islands whose props are over 16 KiB.
- Fixtures: `fixtureContext`, `fixtureProductCard`, `fixtureProductPage`, `fixtureListingPage`, `fixtureHeaderData`, `fixtureFooterData`, `fixtureSkinData(target)` and `fixtureSectionSkinData(type)`. `fixtureSectionSkinData` returns a complete projection matching the sealed `StorefrontSectionSkinSettings[type]` for that section type, so a correctly typed section skin passes `validate`. `fixtureProductCard()` and `fixtureProductPage()` stay bare (no key specs or specifications); the sample fixture store carries them (`fixtureStore("sample").productPage().product.specifications`, its card's `keySpecs` and `facts`), as the other store does. Optional fields can be added to fixtures as the store gains them, so compare fixture output with `toMatchObject` rather than exact equality.
- Fixture stores: `fixtureStore(name)` for each of `FIXTURE_STORES` (`sample`, `empty`, `other`) gives that store's `context()`, `productCards()`, `image()`, `productPage()` and `skinData(target)`, the data `pnpm plugin preview` renders with. Loop your skin and section tests over all three ([Build a theme](themes.md#test-on-more-than-one-store)).

These are author checks, not proof of visual correctness. Exercise the composed page in a local store too.

### Preview

`pnpm plugin preview <app> [--store sample|empty|other] [--out <html>] [--fixture <json>]` packs the app and writes a static preview with SDK fixtures and the real output check, on three fixture stores by default: a sample shop, an empty new store (no products, categories, menus, logo, policies or contact details) and another shop with its own name, logo, catalogue, brand and currency. `--store` renders one. `pnpm plugin dev <app>` watches, repacks and refreshes it. A view that renders nothing says so, per store. The fixture fills what defaults leave out, keyed by view: `section:<type>`, `component:<type>`, `skin:<id>`.

```json
{
  "product": { "fields": { "engraving": true } },
  "settings": { "component:points": { "label": "Points" } },
  "objects": { "section:lookbook": { "looks": { "records": [], "fields": {} } } }
}
```

`product` is merged over the fixture product page. Core embeds appear as placeholders: the preview checks markup and styles, not checkout actions or island behaviour.

### The packer

`pnpm plugin pack`:

1. Compiles `src/storefront.tsx` into one minified ES module and checks that its sections, components and skins match the manifest.
2. Renders every section, component (at each target) and skin once with fixture settings and its target's fixture projection, so a module that throws, or a skin that breaks its target's embed rule, fails the pack, not the store.
3. Compiles each island for browsers and checks it default-exports `defineIsland(...)`.
4. Copies the stylesheet (rewriting `url(../public/...)`) and the public files, checking their types by their bytes.
5. Checks the budgets and seals every file's SHA-256 into the bundle. The release signature covers the bundle, so it pins every storefront file; install refuses a package whose files do not match.

## Budgets

`STOREFRONT_COMPONENT_LIMITS` (from `@scalius/plugin-sdk/storefront`) carries these numbers, so a test or an island can check against the store's own.

| Limit | Value |
| --- | --- |
| Compiled module | 512 KiB |
| Stylesheet | 96 KiB |
| One island / all islands | 64 KiB / 192 KiB |
| Public files | 512 KiB each, 4 MiB and 40 files in all (woff2, woff, svg, png, jpg, jpeg, webp, avif) |
| Markup per render | 256 KiB, nesting depth 48, 6,000 elements |
| One island's props | 16 KiB of JSON, inside the markup's 256 KiB; any other attribute 2,000 characters |
| Items in one menu a skin gets | 300 (links and headings; a larger tree is cut top levels first, every level kept) |
| Jobs per batch | 120 |
| Batch CPU (isolate) | 50 ms |
| Batch wall time | 250 ms, then the core units render |
| App sections on one page | 24 |
| App components on one product page | 10 |
| Image settings per unit skin | 8 |
| Proxy page props | 64 KiB |

Noor, a full theme, packs to a 40 KB module, 3.8 KB of islands and a 44 KB stylesheet.

## Performance

- **One call per app per page.** Every part an app draws on a page (header, footer, every card in a listing, every section) joins one batch. A `product_main` or `listing_main` skin is drawn first, so those pages make one more batch to the app.
- **Memo.** Each isolate keeps rendered output keyed by your release, the job and its context, so a popular page's cards and chrome render once per isolate, not per request.
- **Bounded reads.** Skins and components draw from data the page already has. Section data joins the page's existing batch.
- **Cache.** Rendered pages use the store's dependency-validated page cache. Release files are immutable for a year; an update is a new URL.
- **Fallback.** One failed job fails only itself. A module that cannot load, throws or answers after the 250 ms wall falls back for its whole batch, and that page is never stored in the cache.

## Security

- Drawing on the storefront is its own grant, and every browser host your islands reach is listed. A Super Admin approves both. An update that asks for more waits for approval.
- The render input supplies settings, public page data and context, never buyer sessions or secrets.
- Output passes the store's allowlist. It keeps content, list, table and form elements, `h1`, `video`, an SVG drawing subset, islands, deferred markup and core embeds; classes; `id`s that start with your app's name (`noor-…` for `scalius.noor`); inline style without loading functions (`url()`, `image-set()`), escapes or comments; forms that post to a store path; and schema.org JSON-LD (dropped on `noindex` pages). It drops `<script>`, `<style>` (CSS belongs in the stylesheet), `<iframe>`, `<noscript>`, `<template>` (except as deferred content), `<math>`, SVG animation and `foreignObject`, event handlers, host `data-sx-*` attributes, and every URL that is not a store path, `http(s)`, `mailto`, `tel` or a fragment.
- App components, islands, stylesheets and browser hosts never reach a buyer's own page: cart, checkout, the receipt, account, payment recovery, order tracking, warranty claims and the gift-card balance. Core chrome renders there.
- Island code is served from the store's origin; CSP `script-src` gains nothing. Browser hosts join `connect-src` and `img-src` only, on pages whose theme uses the app.
- Approved islands are trusted same-origin JavaScript: they can read the page's DOM, including embedded forms, and make requests the browser allows. Activation approval, CSP and server authorization are the boundaries; HTML sanitizing does not sandbox an island.
- SVG files are served with a sandboxing CSP and `nosniff`.

## Stored themes and versioning

- A theme stores skins under `apps.skins` (`header`, `footer`, `product_card`, `product_main`, `listing_main`) and a core section's own `skin`. Your parts are named `<app id>/<id>`. Stored themes are never reset: a shape change ships an upgrade step, so a template written for an older theme version keeps working.
- Core section types, skin units, `section:<type>` targets and embed kinds are snake_case (theme document v12).
- The component ABI (`STOREFRONT_COMPONENT_ABI`) and the data shapes are part of the plugin API. Within a version they only gain optional fields. A breaking change bumps the ABI with a changelog entry: you repack, and merchants update the app.
- Publishing a theme that draws with parts of an inactive app is refused (`theme_apps_unavailable`), so the storefront never silently falls back.
