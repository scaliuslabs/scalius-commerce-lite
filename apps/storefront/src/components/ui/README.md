# Storefront UI primitives ("Scalius Base")

One component for each recurring piece of storefront UI. Header, footer, home sections, listing, product page and cart use these instead of drawing their own price, badge, rating, button, container or section title. Each primitive reads only theme tokens (`packages/shared/src/storefront-theme/tokens.ts`, written as CSS variables by the Layout) and takes its words from `src/lib/storefront-copy.ts` in the store's language (English or Bangla, `RequestTheme.language`). Its styles load only on pages that render it.

The React files in this folder (`button.tsx`, `input.tsx`, `label.tsx`, `sheet.tsx`, `textarea.tsx`) are for client islands. Astro pages and components use the `.astro` primitives below.

## Tokens they use

| Token (CSS variable) | Values |
|---|---|
| Spacing | Tailwind's 4px steps: 4, 8, 12, 16, 24, 32, 48, 64, 96 (`STOREFRONT_SPACE_SCALE`) |
| Type | `--theme-text-xs` to `--theme-text-5xl`: 12, 14, 16, 18, 20, 24, 30, 36, 48 px (`STOREFRONT_TYPE_STEPS`) |
| Radius | `--radius` (theme radius), `--theme-button-radius` (button shape: square, radius or pill) |
| Colour roles | `--foreground` (ink), `--muted-foreground`, `--background`, `--card`, `--border`, `--primary` (action), `--theme-sale` (discounted prices and the sale badge only), `--theme-success`, `--theme-rating` |
| Container | `--theme-container-width`; gutters `--theme-gutter-phone/tablet/desktop` (16, 24, 32) |
| Elevation | `--theme-surface-border`, `--theme-surface-shadow` (flat, hairline or raised: never both); padding `--theme-surface-pad-phone/desktop` (12, 16) |
| Motion | `--theme-duration-fast` (150ms), `--theme-duration-base` (250ms); zero under `prefers-reduced-motion` |
| Accessibility | `--focus-ring-*`, `--target-min` (theme-foundation.css) |

## Components

### `Price`
```astro
<Price amount="৳1,200" compareAt="৳1,500" from={false} saving={null} size="card" as="p" />
```
- `amount` (required): the price the buyer pays, formatted.
- `compareAt`: the regular price while discounted. It is struck after the price, and the current price turns the sale colour.
- `from`: the price varies by option ("From ৳1,200").
- `saving`: shows "Save ৳300" after the struck price. Use it on one surface per store, never next to a sale badge with the same discount.
- `size`: `card` (16/600) or `page` (24/700, the product page).
- Screen readers hear "Sale price ৳1,200, Regular price ৳1,500" or "Price ৳1,200".

### `Badge`
```astro
<Badge kind="sale" label="-15%" />  <Badge kind="sold-out" />  <Badge kind="new" />  <Badge kind="custom" label="Pre-order" />
```
- One shape (the theme radius, at most 12px). `sale` is the sale colour, `sold-out` ink on the page colour, `new` the action colour, `custom` the secondary surface.
- `label` is optional for `sale`, `sold-out` and `new` (their words come from the copy). `custom` renders nothing without a label.
- On a photo, badges stack top-start. Do not repeat the same discount elsewhere on the card.

### `Stock`
```astro
<Stock state="in-stock" />  <Stock state="low" count={3} />  <Stock state="sold-out" />  <Stock state="pre-order" />
```
- One line with a decorative dot; the words carry the meaning. The same component goes on cards and the product page.

### `Rating`
```astro
<Rating average={4.6} count={212} size="sm" />
```
- Amber stars, the average and the count in brackets. Screen readers hear "Rated 4.6 out of 5 from 212 reviews".
- Renders nothing with no reviews (never "(0)"). `size`: `sm` (cards) or `md` (the product page).

### `Button`
```astro
<Button variant="primary" size="md" href="/cart">Checkout</Button>
<Button variant="secondary" size="sm" full type="submit">Subscribe</Button>
<Button variant="tertiary">Read more</Button>
<Button as="span" aria-hidden="true" variant="secondary">Choose options</Button>
```
- `variant`: `primary` (solid action colour), `secondary` (outline), `tertiary` (underlined link). `size`: `md` (the density's control height) or `sm` (36px). Touch screens always get 44px.
- `href` renders a link; otherwise a `button` (`type="button"` by default). `as="span"` draws the look for a decorative hint under a stretched link.
- `full` fills the container width. Slots: default (the words), `start` and `end` (icons).
- The visible words are the accessible name (WCAG 2.5.3). Add context in a `sr-only` span after them, never an `aria-label`.

### `Container`
```astro
<Container as="section" width="page">…</Container>
```
- The theme's container width with the system gutters. Use it instead of `max-w-7xl` so every edge on a page lines up.
- `width="text"` is a 48rem reading column (CMS pages, policies). Any other attribute passes through.

### `SectionHeader`
```astro
<SectionHeader title="New arrivals" subtitle="Fresh from the loom" href="/collections/new" level={2} id="new-title">
  <Fragment slot="actions"><!-- carousel arrows, shown from 1024px by the caller --></Fragment>
</SectionHeader>
```
- The title (with the theme's heading font, case and section size), an optional subtitle, and one trailing "View all" link (`linkLabel` replaces the words). The link's name is "View all: New arrivals".
- No decorative bars or chips. Carousel arrows go in the `actions` slot after the link.

## The product card

`components/cards/ProductCard.astro` is built on `Price`, `Badge`, `Rating` and `Button`. It has three settings (`blocks.card.settings`):

- `facts`: `none`, `key-specs` (two on phones, three from 640px), `swatches` or `delivery`. Each shows only when the product has the data.
- `action`: `none`, `quick-add` (a round add button on the photo for simple products; a chevron hint for products with options) or `full` (a button under the price on every card: Add to cart, Choose options or View product).
- `hoverImage`: the second photo fades in on hover.

The photo ratio and fit, radius and surface are theme tokens. Card titles are h3 (the listing adds a visually hidden "Products" h2). In a grid every card fills its row, and the price and action sit at the bottom.
