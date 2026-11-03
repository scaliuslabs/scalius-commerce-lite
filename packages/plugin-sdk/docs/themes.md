# Build a theme

A Scalius theme runs in every store that installs it, and you will never see most of those stores. A store you have never seen has another name, another logo, other products, maybe none yet, and buyers who read Bangla or English. This page is how to build a theme that works there, not only on the store you built it on.

If an AI agent writes your theme, give it this page and your app's `AGENTS.md` (the scaffold writes one).

[Storefront](storefront.md) is the full reference (every extension point, setting type, embed and budget). This page is the path through it and the rules that keep a theme portable.

## Start

```sh
pnpm plugin create acme.studio --theme --dir ~/code/acme-studio   # from a Scalius checkout
cd ~/code/acme-studio && npm install
npm test                                                          # the theme on three fixture stores
pnpm --dir ~/scalius plugin validate ~/code/acme-studio           # every store check, portability included
pnpm --dir ~/scalius plugin preview ~/code/acme-studio            # dist/preview.html: a sample, an empty and another store
```

The starter follows every rule on this page: a template, one section, header, footer and product card skins that draw the store's own identity, an island, a stylesheet, neutral placeholder art and tests. It validates with no warning. Change it from there.

## The mental model

A theme is an app. Its manifest declares storefront parts and nothing else; there is no backend unless you add one.

| Part | Declare (`storefront.*`) | What it is |
| --- | --- | --- |
| Template | `templates` | A ready-made look: tokens, blocks, which of your skins draw the header, footer, card, product page and listings, and the homepage sections. The merchant applies it once; from then on every value is theirs to edit. |
| Sections | `sections` | New sections the merchant adds in the theme editor, drawn by your module. |
| Skins | `skins` | Your markup for a core unit (header, footer, product card, product page, listing) or a core section, drawn from that unit's projection. |
| Islands | `islands` | The only JavaScript a buyer's browser runs: small modules that improve markup that already works. |
| Stylesheet | `stylesheet: true` | One CSS file on the store's tokens. |
| Public files | `public/` | Fonts and images you ship with the theme. |

Your module is compiled once, when you pack, and the same code runs in every store. Each part is a pure function of three inputs: the settings the merchant chose, the data the store hands it (the **projection**: `data` in a skin, resolved settings in a section) and the render context (`context.store`: name, language, locale, currency). Anything you write as a literal (a link, a name, a field key, a picture) is the same in every store. Anything that should differ per store comes from those inputs.

| You need | Read it from | Never |
| --- | --- | --- |
| The store's name and logo | `data.store.name`, `data.store.logo` and `data.store.darkLogo` (header and footer), `data.store.footerLogo`, `context.store.name` | A wordmark, your app's name |
| Navigation | `data.menu`, `data.categories` (header), `data.menus` (footer) | A link list of your own |
| Core routes | `data.routes` (`home`, `search`, `cart`, `account`, `orders`, `trackOrder`; footer `newsletter`) | Page paths such as `/about` |
| Products | A `products` or `product` setting, a section's product source, each card's own `url` | `/products/<slug>` |
| A category or collection a template names | A handle: `/categories/@<handle>`, `{ "kind": "category", "handle": "<handle>" }` | `/categories/<slug>`, `/collections/<id>` |
| Fields on a card | `product.fields` (the fields the merchant chose), your own `<app id>.<key>` fields | `custom.*` |
| Pictures | Image settings the merchant fills, your own neutral placeholders | Third-party art |
| Words | `t(context, { en, bn })` and the SDK formatters | English-only strings |

## The portability rules

`pnpm plugin validate` checks each rule it can detect and says the exact fix. A `✗` is broken on every store but yours; a `!` depends on the store or on your judgement.

### 1. The store's name and logo come from the projection

Every header and footer skin gets `data.store`: `name`, `logo` (`StorefrontImage | null`), `darkLogo` (the logo for dark pages, or `null`), `logoWidth` and, in the footer, `footerLogo`, `phone`, `email`, `address` and `social`. Draw the logo when there is one and the name when there is not. When there is a `darkLogo`, draw both and show it instead of `logo` under `:root[data-color-scheme="dark"]` (give it `loading="lazy"`: a hidden image never loads).

Wrong: every store that installs the theme shows your wordmark.

```tsx
const Header = () => <header><a href="/" class="logo">GAMING THEME</a></header>;
```

Right:

```tsx
const Header = ({ data }: HeaderProps) => (
  <header>
    <a href={data.routes.home}>
      {data.store.logo ? <Image image={data.store.logo} alt={data.store.name} loading="eager" /> : data.store.name}
    </a>
  </header>
);
```

The same holds for shop copy in templates and setting defaults. "How to order on Gaming Theme" tells another store's buyers to order from your app. Write copy any store can keep ("How to order"), or leave the text empty for the merchant. Validate renders your header and footer skins for two probe stores and warns when neither the store's name nor its logo appears, and warns when a template or default says your app's name.

### 2. Link by handle or by source, never by a literal product or page path

A product slug, a category slug and a collection id name records in your store. On another store they are dead links.

Wrong: a template section with your catalogue in it.

```json
{ "label": "Xbox", "link": "/categories/xbox", "artwork": "xbox.webp" }
{ "label": "GTA V", "link": "/products/grand-theft-auto-v-premium-edition", "artwork": "gta-wide" }
```

Right: a handle for a category or collection, and a product source for products.

```json
{ "label": "Xbox", "link": "/categories/@xbox" }
{ "id": "console", "type": "product_grid", "version": 1, "settings": { "title": "Xbox", "source": { "kind": "category", "handle": "xbox" } } }
```

How handles resolve:

- Three forms, anywhere in a template's or page preset's sections: a product source `{ "kind": "category" | "collection", "handle": "<handle>" }`, a string `@category:<handle>` or `@collection:<handle>` in an id list (`categoryIds`, `collectionIds`), and a link `/categories/@<handle>` or `/collections/@<handle>` (with an optional `?query` or `#fragment`).
- When the merchant applies the template, the store replaces each handle with its own record. **A section naming a handle the store lacks is left out**, and the rest of the template applies. Keep one category per section where you can, so one missing category costs one section, not a row of tiles.
- Outside the homepage sections (skin values, blocks) a missing handle makes the whole template unusable on that store. Do not put catalogue links there.
- Setting defaults are never resolved: a default `/categories/@xbox` is a dead link everywhere. Leave link defaults empty.

Products have no handle form. Drive every product row from a source (`newest`, `popular`, `on-sale`, a category or collection by handle, or a `products` setting the merchant fills) and link each card to its own `url`. Never pair bundled artwork with a product path: that pairing only exists in your store. If a row may show artwork, let the merchant pick the image, and never render a link for a slot that matched nothing.

Link only to the routes every store has: `/`, `/search` (with any query), `/cart`, `/account` and its pages, `/categories`, `/collections`, `/blog`, `/track-order`, `/compare`, `/gift-card-balance`, `/warranty-claims`, `/newsletter`, and your own `/apps/<your app id>/…` pages. Prefer the `data.routes` values where the projection carries them. A page such as `/about`, `/support` or `/free-games` exists only once a merchant makes it. If your look needs pages, say in your listing which pages to create, and let the merchant add them to the menu.

**Header links.** The header gets the merchant's own menu (`data.menu`, edited under Online store, Navigation). Draw it. Ship any link list setting of your own empty, so a new store shows no dead links.

### 3. Never depend on `custom.*` fields

`custom.<key>` is the merchant's own namespace. An app cannot create it, so no other store has your `custom.platform`. A template whose card fields (`blocks.card.fields`) name one applies without it on a store that lacks it; a card or section that reads one draws nothing there.

How an app creates and owns its fields:

1. Declare them in the manifest. Each is named `<app id>.<key>` in a store:

   ```ts
   customFields: [
     { ownerType: "product", key: "platform", name: "Platform", type: "single_line_text", storefrontVisible: true },
   ],
   ```

2. The merchant approves them when they activate the app.
3. Your code writes values with `ctx.customFields.set("product", productId, { platform: "PC" })`, for example from an admin page where the merchant fills them in, or from an event handler. A store has the field's definition from the first value your app writes. Installing alone creates nothing, so a template naming `acme.studio.platform` applies without it until then.
4. Read values on the storefront from `product.fields["acme.studio.platform"]` on cards and `product.fields` on the product page, and draw nothing when the value is missing.

The simplest portable card shows the fields the merchant chose in the theme editor: draw what `product.fields` holds and name none. Validate warns about every `custom.*` reference in your template, settings and compiled module, and about card fields no store is sure to have.

### 4. Expect an empty store and missing data

A store that just installed your theme may have no products, categories, collections, menu, logo, policies, contact details, reviews or brands. A product may have no photo, no price cut, no rating, no brand, no description and no options.

| In the projection | On a new store |
| --- | --- |
| `data.menu`, `data.categories`, footer `data.menus`, `data.policies`, `data.store.social` | `[]` |
| `data.store.logo`, `darkLogo`, `footerLogo`, `phone`, `email`, `address`, `data.announcement` | `null` |
| A `products` setting, a section's `products.cards`, a listing's `cards` | `[]` |
| An `image` setting | `null` |
| A card's `image`, `hoverImage`, `compareAt`, `rating` | `null` |
| A product page's `media`, `options`; `brand`, `rating` | `[]`; `null` |

Rules:

- A part with nothing to show returns `null`. A section then disappears, and a skin that draws nothing gives way to the store's own unit. Never draw an empty shell, a heading over nothing, or demo content in its place.
- Guard every nullable value. A skin that throws is replaced by the store's own unit, and a section that throws draws nothing, on every page that uses it.
- Wrong: `<img src={product.image.url} />` throws for a product without a photo. Right: `{product.image ? <Image image={product.image} /> : <img src={asset(context, "placeholder.svg")} alt="" />}`.

`pnpm plugin preview` renders every part on an empty store, and the starter's tests run on it too.

### 5. Ship only artwork you hold the rights to

A theme is copied to every store that installs it, and each merchant then publishes your images on their own site. Ship only pictures you made, or ones whose licence lets you give them to every store that installs your theme.

- Never bundle game covers or key art, console, publisher or platform logos, film stills, brand logos, celebrity photos, another shop's product photos, or stock photos without a redistribution licence.
- Ship neutral placeholders (your own SVG shapes) and give sections `image` settings, so merchants use their own photos. A unit skin may declare up to 8 top-level image settings at no extra read cost.
- Keep each image under 200 KiB (WebP or AVIF, at most 1600px wide). A public file is at most 512 KiB, and all of them 4 MiB and 40 files.

Validate warns about every bundled image over 200 KiB and every file name that suggests a third-party mark. A name proves nothing either way: the licence is yours to check.

### 6. Real buttons and links, and no-JavaScript fallbacks

- A control that goes somewhere is an `<a href>` with a real destination. A control that acts on the page is a `<button>`. Never an `<a href="#">` that only an island makes work.
- On the product page, buying happens only through the store's `<BuyForm />` (required, exactly one), which keeps price, options and stock current. To offer SKUs your own way (cards, a table), put `chooseVariant(variant)` on a link and `buyVariant(variant, "add" | "buy")` on a button: the store binds them to the form, and a buy button works without JavaScript too. Never script clicks on the form's own buttons or read its markup; read `context.product` instead. Style the form through its [`[data-buy-part]` hooks](storefront.md#styling-the-buy-form).
- The card quick add is the one link that acts: `<a {...quickAdd(product)}>` adds a simple product in place when JavaScript runs and opens the product page when it does not.
- Search is a `GET` form to `data.routes.search` with `name={data.searchParam}`. A menu that opens is a `<details>` or a `popover`, which open without JavaScript. Forms post to store paths.
- An island improves markup that already works: Escape to close, a carousel's arrows, a countdown. The page must read and work before the island loads and without it. Never put content buyers or crawlers need inside `<Deferred>`.

Wrong:

```tsx
<Island name="buy"><a href="#" class="add">Add to cart</a></Island>
```

Right:

```tsx
<BuyForm title={false} />                      // on the product page
<button {...buyVariant(variant, "add")}>Add</button>  // a SKU's own button, run by the form
<a {...quickAdd(product)}>Add to cart</a>       // on a card
```

### 7. Both languages, and logical CSS

- Every word your theme writes goes through `t(context, { en: "Sold out", bn: "বিক্রি শেষ" })`. Scalius stores ship in English and Bangla; a language you leave out falls back to English.
- Format with the SDK: `formatNumber`, `plural`, `formatMoney`, `formatDate`. Money arrives as `StorefrontMoney` (`{ amountMinor, currency, formatted }`); show `formatted` or `<Price />`, never arithmetic on floats.
- Write sides as logical properties so a right-to-left page mirrors without a second stylesheet: `margin-inline-start` (not `margin-left`), `padding-inline`, `inset-inline-start`, `border-inline-end`, `text-align: start`.
- Style on the store's tokens so the merchant's colours and type still apply: `var(--primary)`, `--primary-foreground`, `--foreground`, `--background`, `--border`, `--muted-foreground`, `--radius`, `--theme-font-body`, `--theme-font-heading`.
- The tokens already follow the store's colour scheme: on dark pages they hold the theme's dark colours, on every page, private ones included. Don't ship a second palette or your own light/dark switch. For what tokens can't say (a dark logo, an image swap), select on `:root[data-color-scheme="dark"]`; for a switch, put `colorSchemeToggle()` on a native button.
- Prefix every class with your app's name (`studio-header`); an `id` must start with it.

## Templates

A template sets tokens, blocks, which skins draw the units (`apps.skins`) and the homepage sections; the merchant's brand, menus, pages and other content stay. Write it for one theme document version (`themeVersion`, 13 today); stores upgrade it from there.

Its `tokens` can set the colour scheme too, checked like any theme when the merchant saves:

| Token | Values | What buyers see |
| --- | --- | --- |
| `colorScheme` | `light`, `dark`, `system` | `colors`, `darkColors`, or whichever the buyer's device asks for. |
| `darkColors` | the same keys as `colors`, or `null` | Required, and held to the same readable-text checks, while `colorScheme` isn't `light` or the switch is on. |
| `colorSchemeToggle` | `true`, `false` | A switch in the header; each buyer's choice is remembered on their device. |

A template that leaves dark off (`light`, no switch) keeps the merchant's own scheme, dark colours and switch when applied; one that shows dark brings its own. A template written for version 12 reads as `light`, no dark colours and no switch.

```ts
templates: [{
  id: "studio",
  name: "Studio",
  themeVersion: 13,
  theme: {
    apps: { skins: { header: { app: "acme.studio/header", values: {} }, product_card: { app: "acme.studio/card", values: {} } } },
    sections: [
      { id: "studio-new", type: "app", version: 1, settings: { app: "acme.studio/product_row", values: { products: "newest" } } },
      { id: "studio-xbox", type: "product_grid", version: 1, settings: { title: "Xbox", source: { kind: "category", handle: "xbox" } } },
    ],
  },
}],
```

- Header and footer skin values carry no links of your own; the store's menus fill them.
- Card fields: leave `blocks.card.fields` out, or name only your own declared fields.
- Homepage sections are where handles resolve, and where a missing one costs only its section.
- When a merchant applies the template again, a section whose id they already have keeps their values.

## Test on more than one store

`pnpm plugin preview <app>` renders every part on three fixture stores, one after the other in `dist/preview.html`:

| Store | What it has |
| --- | --- |
| `sample` | Acme Store: clothing, a menu, no logo, prices in BDT. |
| `empty` | New Store: no products, categories, menus, logo, policies or contact details; a bare product where a page needs one. |
| `other` | Harbor & Pine: kitchenware, a logo, a different menu and brand, prices in USD. |

`--store empty` renders one. Look at each: your header must show "New Store" on the empty store and the Harbor & Pine logo on the other, and nothing from your own demo catalogue may appear anywhere.

Render on all three in your own tests too. `fixtureStore(name)` gives each store's context, product cards, images and projections:

```ts
import { FIXTURE_STORES, fixtureStore, renderHeader } from "@scalius/plugin-sdk/storefront/testing";
import type { StorefrontHeaderData } from "@scalius/plugin-sdk/storefront";

describe.each(FIXTURE_STORES)("on the %s store", (name) => {
  const store = fixtureStore(name);
  it("draws the store's own logo or name", () => {
    const data = store.skinData("header") as StorefrontHeaderData;
    const html = renderHeader(storefront, "header", {}, data, { context: store.context() });
    expect(html).toContain(data.store.logo ? data.store.logo.url : data.store.name);
  });
});
```

What `pnpm plugin validate` checks for portability:

| Check | Catches | Level |
| --- | --- | --- |
| Catalogue links | `/products/<slug>`, `/categories/<slug>`, `/collections/<id>` in templates, presets and defaults; a handle where no store resolves it | `✗` |
| Page links, Header links | Paths that are not core routes (`/about`, `/support`), another app's pages | `!` |
| Merchant fields | `custom.*` in templates, settings and the compiled module | `!` |
| Template card fields | Card fields no store is sure to have | `!` |
| Store name and logo | Header and footer skins that draw neither; your app's name as shop copy | `!` |
| Artwork size, Artwork rights | Images over 200 KiB; file names that suggest a third-party mark | `!` |

## Before you release

- [ ] `pnpm plugin validate` shows no `✗`, and every `!` is either fixed or a choice you can explain.
- [ ] `pnpm plugin preview`: on the empty store the header shows "New Store" and parts with nothing to show draw nothing; on the other store the Harbor & Pine logo, menu and USD prices show; nothing from your own store appears on either.
- [ ] No literal `/products/…`, `/categories/<slug>` or `/collections/<id>` anywhere, and no page path that is not a core route. Header link lists ship empty.
- [ ] No `custom.*` in the template, the settings or the code. Your own fields are declared in `customFields`, and your code writes them.
- [ ] Every image is yours or licensed for redistribution to every store, and each is under 200 KiB.
- [ ] Every word has English and Bangla; the stylesheet has no `left` or `right`.
- [ ] Every control works with JavaScript turned off; the product page buys through `<BuyForm />`.
- [ ] In a fresh local store: install, apply the template, publish, then browse the home page, a category, a product, search and the cart on a phone and a computer. Repeat in a store with a full catalogue.
- [ ] Your listing says which pages or categories a merchant can create for the full look.

## More

- [Storefront](storefront.md): the full reference.
- [Apps](apps.md): the manifest, lifecycle, signing and limits.
- [Commerce hooks](commerce-hooks.md): scopes, events and the stable app API, when your theme has a backend.
- [llms.txt](llms.txt): a one-page index for AI tools.
