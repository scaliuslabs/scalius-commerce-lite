# Storefront components

An app can redesign the storefront: its own header, footer and product card, new sections with their own logic, a single-page order landing, and ready-made templates that apply the whole look in one click. The merchant installs the app, activates it, picks its template in Online Store → Theme, and edits every section and slot in the theme editor like the built-in ones. Nobody forks the storefront.

The reference app is `plugins/noor` (Noor: a complete theme with 20 sections, its own header, footer and card, one template, and a landing kit with a page preset for Bangladesh-style single-product campaign pages with a cash-on-delivery order form). The small worked example is `apps/api/src/plugins/testing/apps/studio`.

Source of truth:

| Part | Where |
| --- | --- |
| Contract (manifest, data shapes, render protocol, limits) | `packages/shared/src/plugins/storefront-components.ts`, `storefront-protocol.ts` (zod-free) |
| Output check | `packages/shared/src/plugins/html.ts` (`sanitizePluginHtml`, `component` profile) |
| SDK | `@scalius/plugin-sdk/storefront`, `/storefront/testing`, `/island` (`packages/plugin-sdk/src/storefront/`) |
| Packer | `scripts/plugin-build.mjs` (`packStorefront`, `writeStorefrontGenerated`) |
| Host (storefront) | `apps/storefront/src/lib/extensions/` and `components/apps/AppComponent.astro` |
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
| Component section | `sections: [{ type, name, settings }]` (no `route`) | `sections[type]` | a section `{ type: "app", settings: { app: "<id>/<type>", values } }` |
| Header | `slots: [{ id, slot: "header", settings }]` | `slots[id]` | `apps.header: { app: "<id>/<slot id>", values }` |
| Footer | `slots: [{ id, slot: "footer", settings }]` | `slots[id]` | `apps.footer` |
| Product card | `slots: [{ id, slot: "product-card", settings }]` | `slots[id]` | `apps.productCard` |
| Template | `templates: [{ id, name, theme }]` | | `apps.template` (a label) |
| Page preset | `pagePresets: [{ id, name, sections }]` | | a new landing page's sections |
| Island | `islands: [{ name }]` | `src/islands/<name>.ts` with `defineIsland` | |
| Stylesheet | `stylesheet: true` | `src/storefront.css` | |
| Browser hosts | `connect: ["api.example.com"]` | | |

A section with a `route` is the older kind: the API calls the app's public route and caches the HTML (docs in `packages/plugin-sdk/README.md`). Both kinds coexist; component sections are faster (no network hop) and can show product cards, images and the order form.

A **page preset** is a ready-made landing page: when the merchant makes a new landing page (`/pages/<slug>`), the editor offers "a blank page" or the presets of the active apps, and asks for a product when a preset's sections have `product` settings, which it fills in. Noor's "Product campaign" preset builds a complete Facebook-ad page (offer, promises, features, steps, reviews, questions, order form) in one step; every section stays editable and reorderable.

A page may hold 24 sections, all of them component sections; at most 8 route sections render on one page (each is a call to its app).

The card slot draws every product card the storefront shows: homepage rails, listings, search, related products. The header and footer slots replace the core header and footer on every page. When a slot's app is gone, inactive or fails, the core block renders: a theme never breaks.

## Settings

Component sections and slots use the app settings types (`text`, `textarea`, `number`, `boolean`, `select`, `color`) and five more:

| Type | Stored | The component gets |
| --- | --- | --- |
| `image` | a media id | `StorefrontImage` (`url`, `width`, `height`, `alt`, `srcset`) or `null` |
| `products` (`limit` ≤ 36) | a source: `newest`, `featured`, `collection:<id>`, `category:<id>`, … | up to `limit` `StorefrontProductCard`s, priced in the buyer's market |
| `product` | a product id | one card or `null` |
| `link` | a storefront path or an `https://` URL | the string |
| `list` (`fields`, `max`, `itemLabel`) | items of the fields above (no products) | items with their images resolved |

The editor shows a media picker, a product source or product picker, a link field and a repeatable item list. Values are resolved against the schema as it is now (`resolveStorefrontSettings`): a removed setting drops, a new one takes its default, a deleted image or product resolves to `null`. Slot settings cannot use `image`, `products` or `product`: the chrome renders on every page and must not add reads.

The page reads every image and product list its component sections name in one batch beside the page's own second batch (`readAppComponentData`), with the homepage limits (40 images, 8 product lists). A page with component sections adds no round trip to its critical path.

## A storefront module

```tsx
// src/storefront.tsx (tsconfig: "jsxImportSource": "@scalius/plugin-sdk/storefront")
import { defineStorefront, editable, Image, Island, Price, quickAdd, type SectionProps } from "@scalius/plugin-sdk/storefront";

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

export default defineStorefront({ sections: { featured: Featured }, slots: { "acme-card": Card } });
```

The SDK's primitives:

- `Image`: responsive `<img>` with `srcset` and intrinsic size (no layout shift); lazy unless `loading="eager"`, which also sets `fetchpriority="high"`.
- `Price`: the market's formatted price with an accessible compare-at (`from` for "From …").
- `Island`: interactive markup (`hydrate`: `visible`, `idle`, `load`, `interaction`).
- `quickAdd(product)`, `openCart()`, `CartCount`: the core cart behaviour, no app JavaScript.
- `searchOpener()`, `accountLink()`: opt into the host's search and account actions; custom popovers remain valid.
- `stickyHeader()`: declare the actual sticky header box so core navigation and anchors reserve its space.
- `editable(context, key)`: marks the element that shows a text setting, so the editor edits it in place (preview only; the published page has no marks).
- `asset(context, "public/font.woff2")`: a public file's URL.
- `t(context, { en, bn, … })`: words in the page's language (exact BCP 47 tag, then its language, then English).
- `formatNumber`, `plural(context, count, { en: { one: "# review", other: "# reviews" } })`, `formatMoney`, `formatDate`, `storeTime`: numbers, plurals, money and dates as the store writes them (`@scalius/shared/locale-format`); `context.store` carries the page's `language`, `locale` (language and the store's country), `currency` and `timeZone`, never a default.
- `Checkout`: the core order form (below).

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

An island's module loads from `/_x/...` only when its moment comes, once per page however many times it appears. `context` carries the app's file base (`assets`), the store's `language` and `currency`, `formatMoney`, the cart (`openCart`, `quickAdd(url)`, `onCart(listener)`) and `fetchApp(path)`, which reaches the app's public routes through the storefront proxy (`/apps/<id>/...`, same origin, no CSP host needed).

Return a cleanup for your listeners, timers and observers. The host cancels
pending hydration on removal, ignores imports from an old connection and
mounts again when the element reconnects. Host cart subscriptions are released
on removal or mount failure; your other resources still need that cleanup.

## Core embeds: the single-page order

`<Checkout product={settings.product} maxQuantity={5} />` places the store's own order form in the app's markup: option picker, quantity, name, phone, address. It is the Bangladesh-style landing page: the buyer orders without leaving the page.

- The marker names the product by id (`data-product`), and only a product the section's settings gave it orders: the storefront replaces the marker with `OrderForm.astro` (at most 2 per page).
  The server render input contains no buyer form data. The resulting form belongs
  to core; trusted browser islands share its page and can access its DOM.
- The form posts to `/checkout/quick`, the same cash-on-delivery pipeline as the product page's quick buy: stock, prices, the delivery quote, checkout functions and the order commit are the core's. The buyer confirms the total once and the order is placed.
- It renders only for products that can be ordered from a form (active, in stock, no customization, not a gift card); otherwise it links to the product page.
- The core styles it on the store's tokens (zero-specificity rules; `--of-radius`, `--of-line`, `--of-focus` change the basics), with sizes as compact chips and a price per option only when prices differ. Restyle it through `.scalius-order-form` and its parts.
- When the store cannot take the order there (cash on delivery off, checkout not ready, a product that needs input), buyers get a link to the product's page and the editor's preview says why.
- Noor's landing kit shows the pattern: `landing-hero` (photos, offer price, countdown, "Order now", call and WhatsApp), `landing-features` (cards, photo rows or numbered steps) and `landing-order` (the summary, assurances and the form at `#order`, with a sticky order bar on phones), arranged with any other section on a landing page. On landing pages Noor's header and footer switch to a campaign mode (logo and "Order now"; the legal line) unless the merchant keeps the full ones.

## Build, test, install

```sh
pnpm plugin create acme.studio      # scaffold, then add src/storefront.tsx and the manifest's storefront part
pnpm --filter ./plugins/studio test # vitest with @scalius/plugin-sdk/storefront/testing
pnpm plugin pack plugins/studio     # dist/ and, with --key, the signed upload ZIP
pnpm plugin add plugins/studio      # bundle into the fork (every plan)
```

`@scalius/plugin-sdk/storefront/testing` renders any section or slot with fixtures (`renderSection`, `renderHeader`, `renderFooter`, `renderProductCard`, `fixtureProductCard`, `fixtureContext`). The output runs through the same check the storefront applies.

`renderHeader` and the packer's header fixture render also check duplicate IDs,
declared form targets, unsafe action links, inert sticky markers and island
names/hydration. Pass `{ islands: ["menu"] }` to `renderHeader` to check names
against your manifest. `assertHeaderContract(html, { islands })` checks your own
rendered fixture. These are author diagnostics, not proof of visual correctness;
exercise the composed page in the gallery/browser too.

The packer (`packStorefront`):

1. Compiles `src/storefront.tsx` with esbuild (minified, one ES module) and checks it exports a definition whose sections and slots match the manifest.
2. Renders every section and slot once with fixture settings (a smoke render), so a module that throws fails the pack, not the store.
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
| Batch wall time | 250 ms, then the core blocks render |
| Sections, slots, templates, page presets, islands, connect hosts | 32, 10, 5, 8, 10, 10 |

Noor, a full theme, packs to a 40 KB module, 3.8 KB of islands and a 44 KB stylesheet.

## Performance

- **One call per app per page.** Every component an app draws on a page (header, footer, every card in a listing, every section) joins one batch, sent once (`ExtensionHost`).
- **Memo.** Each isolate keeps an LRU of rendered output (2,000 entries, 8 MiB) keyed by the app's release, the job and its context. A popular page's cards and chrome render once per isolate, not per request.
- **No new reads.** Slots draw from data the page already has (the layout's menus and store info, the cards the page lists). Section data joins the page's existing batch.
- **Existing page cache.** Rendered pages use the storefront's dependency-validated
  HTML cache; do not add purge or generation-bump paths. Release files are
  immutable for a year (`/_x/<id>/<release>/`), so an update is a new URL. Installs
  live in the existing plugin tables and uploaded files in R2, keeping the data
  layer portable ([DATABASE-PORTABILITY.md](DATABASE-PORTABILITY.md)). Changes to
  plugin rendering inputs must participate in memo keys and cache dependencies.
- **Bounded fallback.** Caught render failures use the core block (a section renders
  nothing), with a bounded warning naming the app and reason. This does not detect
  broken layout or incorrect interaction. A wall timeout cannot interrupt
  synchronous code blocking the bundled host's event loop.

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
- Output passes `sanitizePluginHtml` (`component` profile), an allowlist. It keeps content, list, table and form elements, `h1`, `video`, an SVG drawing subset, islands and core embeds; classes; `id`s that start with the app name (`noor-…` for `scalius.noor`); inline style without loading functions (`url()`, `image-set()`, …), escapes or comments; forms that post to a store path; and schema.org JSON-LD (dropped on `noindex` pages). It drops everything else: `<script>`, `<style>` (CSS belongs in the stylesheet), `<iframe>`, `<noscript>`, `<template>`, `<math>`, SVG animation and `foreignObject`, event handlers, `data-sx-*` (host attributes), and every URL that is not a store path, `http(s)` (the store's media origin is http on a local stack), `mailto`, `tel` or a fragment. Test with `storefrontShown(html, pluginId)` (`/storefront/testing`): `dropped` counts what it left out.
- App components, their islands, stylesheets and connect hosts never reach a buyer's page (checkout, the receipt, account, payment recovery, order tracking; `appComponentsRenderOn` in `apps/storefront/src/lib/app-scripts.ts`): the core chrome renders there.
- Island code is served from the store's origin under its release; CSP `script-src` gains nothing. Connect hosts join `connect-src` and `img-src` only, on pages whose theme uses the app.
- A page drawn with a fallback (a component late, failed, refused, or a release the isolate cannot load) is never stored in the page cache.
- SVG files are served with a sandboxing CSP and `nosniff`.

## Versioning

The component ABI (`STOREFRONT_COMPONENT_ABI`) and the data shapes are part of the plugin API (`PLUGIN_API_VERSION`): within a version they only gain optional fields. A breaking change bumps the ABI with a changelog entry; app authors repack, merchants update the app. Merchants never touch storefront code.

See [UI verification](UI-VERIFICATION.md) for the composed-journey release bar
and [extension hardening](STOREFRONT-EXTENSION-HARDENING.md) for the next contract
improvements. Proposed helpers there are not shipped SDK APIs.
