# Design the buyer's private pages

The cart, checkout, payment, receipt and account pages are a buyer's own pages: they hold a cart, an address, a phone number and a code. No theme or app script runs there, and no theme markup or CSS. You design them with data the store draws:

- you **arrange** the store's parts and the apps' targets, and choose each part's variant;
- you give the store's parts, and the apps' blocks the store draws, their **look through typed tokens** (colours per scheme, sizes, radii, fonts, columns);
- you **choose** the store's words for its actions and amounts, **write** its headings and empty states, and swap its icons;
- you **place** the store's controls: the light or dark switch and the market and language forms.

The store writes every CSS rule from your values, checks every colour a buyer reads, and keeps what a buyer must see and do. A rendered gate ([below](#the-rendered-gate)) draws themes in a real browser and fails when anything a buyer must read or use is lost.

This page covers the cart page, the payment step and the cart drawer, and the look of the receipt and the account. A private page takes no sections: `pages.templates` has no cart template (one with sections is refused with reason `private_page_template`), and no section of the homepage, a landing page or another template draws there. The drawer opens over public pages and is part of each of them: its arrangement, words and icons come from here, and its look comes from your public stylesheet through the same hooks. The receipt and the account take their look from tokens here too ([below](#the-receipt-and-the-account)); their parts keep the store's order, and their card order, receipt width and account menu are still the closed choices in [themes.md](themes.md#templates). Quick checkout (the page that places an order without scripts) takes the store's look and the closed choices there.

Each page is compiled and served on its own: a page is in token mode only where you gave it tokens (or your theme has a page paint), and it serves only its own look.

## What you set

A template sets them under `privatePages`. The merchant's theme document holds the same object, so a merchant or an agent can edit it too.

| Field | What it is |
| --- | --- |
| `controls` | Where the store's controls sit: `header` (the store's checkout header; unset means this), `footer` (a strip at the page's end) or `none`. See [the store's controls](#the-stores-controls). |
| `pages.cart`, `pages.checkout`, `pages.cartDrawer` | An arrangement per page (`checkout` is the payment step). Leave a page out to keep the store's own. |
| `tokens` | The look of the store's parts, per page and style target: `{ "cart": { "summary": { "background": "card", "radius": 0 } } }`. |
| `labels` | The store's word you choose for an action or an amount (`{ "dialog.confirm": "continue-checkout" }`), your own words per language for a heading or an empty state (`{ "cart.heading": { "en": "Your Cart", "bn": "আপনার কার্ট" } }`). |
| `icons` | Your image for a store icon: `{ "cart.empty": { "app": "acme.studio", "file": "icons/bag.svg" } }`, a file in your `public/`. `app` is the app your template comes from (`foreign_asset` otherwise). Applying a template that sets `privatePages` replaces the store's whole object; one that sets none drops any icon of another app. |

The store checks all of it when the theme is saved or published, and stores the result in `compiled` (never set it yourself). A refusal names its `reason` ([below](#refusals)). A buyer's request never compiles anything. After a store update with a newer checker, a page shows the store's default look (its arrangement, words, icons, controls and colours) until the next save, or, for the published theme, until the first maintenance run after the update compiles it again (a draft waits for its save).

## Not available yet

A theme arranges the store's parts and gives them tokens. It writes no markup and no CSS on these pages in this release, so these are refused:

| You set | Refused |
| --- | --- |
| `chrome: "theme"` (your own header and footer) | `not_available` |
| `search` (the store's search in your header) | `not_available` |
| `css` (a stylesheet) | `not_available` |
| `assets` (files for a stylesheet) | `not_available` |
| A `{ "type": "content" }` node in an arrangement (your words or picture) | `not_available` |

Each refusal says "… is not available yet: a theme arranges the store's parts and gives them tokens." The empty values an earlier build wrote (`chrome: "core"`, `css: ""`, `assets: {}`) say nothing and are dropped. A stored theme that already holds any of these (an earlier build's) still reads, on the storefront and in the dashboard: the store drops them and every content block, and that theme's private pages draw the store's default look until your next save compiles them again; the rest of the theme stays as it is. The save itself still refuses them.

## Arrangements

An arrangement is `{ frame?, layout?, items? }`:

- `frame`: the page's closed variant. The cart page and the payment step: `standard` or `narrow`. The drawer: `standard` (380px) or `wide` (440px).
- `layout`: the page as a tree of nodes. Leave it out to keep the store's layout.
- `items.line`: the layout of one cart line, repeated for every line.

| Node | Shape | Draws |
| --- | --- | --- |
| Layout | `{ "type": "layout", "layout": "stack", "hook": "side", "children": [...] }` | A box the store draws: `data-layout` with your hook on `data-hook`. |
| Part | `{ "type": "part", "part": "summary", "variant": "with-items" }` | One of the store's parts ([anatomy](#anatomy-reference)); `variant` is optional. |
| Target | `{ "type": "target", "target": "cart.page.summary" }` | Where apps draw their blocks. |

| Layout | Draws |
| --- | --- |
| `stack` | One column. |
| `columns` | One column, side by side where the box it sits in is 48rem wide (never the screen's width). |
| `grid` | A grid you shape with its hook's `columns` tokens. |
| `group` | A box with no layout of its own. |
| `fold` | Cart page only, once: on phones its children fold behind a bar that states the total. A phone opens with them hidden: a cart whose lines carry something the buyer must act on (an add-on offer under a line) keeps `lines` outside it. |
| `scroll` | Drawer only, once: the region that scrolls between the drawer's fixed parts. |

A hook is lowercase words joined by hyphens (`cart-columns`), at most 40 characters. A unit's layouts nest at most 6 deep, hold at most 24 nodes each and 80 in all.

### Variants

| Page | Part | Variants (the first is the default) |
| --- | --- | --- |
| Cart page | `lines` | `heading-inside`: the heading, your intro and the way back to the store inside the lines card. `heading-above`: the same above the card, on what the card stands on (`lines-header`). |
| Cart page | `summary` | `totals`: the money rows. `with-items`: an Items row first (`data-summary-row="items"`, the number of items). |
| Cart line | `details` | `lines`: each fact on its own labelled line. `values`: the chosen values only, on one line ("Rockstar Launcher / Account"). `chips`: each fact as a chip (`line-chip`). |
| Cart line | `remove` | `icon`: the × button. `words`: the word Remove (সরান in Bangla). Both are 44px to tap. |
| Payment step | `summary` | `open-wide`: folded behind its bar (the total) on phones, open from 64rem. `folded`: behind its bar at every width. |
| Payment step | `payment` | `list`: one row per method, the chosen method's details under it. `tiles`: a grid of tiles, the chosen method's details under the grid (one method is always a row). |

The drawer's parts have no variants. A variant a part does not have is refused (`unknown_variant`).

### What must stay

Every arrangement holds each **mandatory** part and every target exactly once. You may leave out the **optional** parts. Reading order is your order at every width, so put what a buyer needs first in a sensible place; the cart page's `notices` (cart-wide alerts) always come before its `details` (the form), so a buyer on a phone reads them first (`part_order` otherwise). Only what the store's default puts ahead of the cart's lead parts (`progress`, `notices`) may come before the first of `lines`, `summary` and `details`, so a buyer's first screen reaches one of them (`lead_order`). A layout holds at least one part or target (`empty_layout`). The page keeps one `h1`: the lines' heading.

| Unit | Mandatory | Optional |
| --- | --- | --- |
| Cart page | `notices`, `lines`, `summary`, `details`; targets `cart.page.summary`, `cart.page.below` | `progress`, `discount`, `empty` |
| Cart line | `title`, `details`, `inputs`, `quantity`, `price`, `remove`, `limit`, `issue`, `rule`; target `cart.line.after` | `image` |
| Drawer | `header`, `lines`, `undo`, `summary`, `actions`; target `cart_drawer.footer` | `added`, `recommendations`, `offers` |
| Drawer line | as the cart line | `image` |
| Payment step | `empty` (no checkout to pay for), `heading`, `notices`, `summary` (its target `checkout.summary.after` sits inside it), `gift-card`, `payment`; targets `checkout.payment.after`, `checkout.actions.before` | `progress` |

The payment step reads `notices` before `payment`, as the cart reads them before `details`. `payment` is one part: the methods, the chosen method's details, the payment provider's own surface (its card form or frame), Pay and the terms beside it stay together in the store's order whatever you arrange. A theme with an arrangement for the payment step draws it from that; with tokens and no arrangement, from the arrangement its `blocks.checkout` chose (`top`: a `narrow` frame and the summary `folded`; `tiles`), so the look is checked on the page buyers get.

The phone fold starts closed on phones, so it holds only `lines`, `summary`, `discount` and the `cart.page.summary` target; the drawer's `scroll` holds only `added`, `lines`, `recommendations`, `undo` and `offers`, so its summary and the way to check out stay in view (`layout_holds` otherwise).

When the store later makes another part mandatory, a saved arrangement without it shows it in its default place; a saved arrangement with `notices` after `details` reads with `notices` moved just before them (before the side-by-side layout that holds them, never into a column of its own); a part or target saved ahead of the lead parts reads just after the first of them, and an empty layout is dropped. A store upgrade never breaks your page.

Example: the heading above the lines, an Items row in the summary, the summary beside the form, and a line with its price column.

```json
{
  "pages": {
    "cart": {
      "layout": [
        { "type": "part", "part": "notices" },
        { "type": "layout", "layout": "columns", "hook": "cart-columns", "children": [
          { "type": "layout", "layout": "stack", "children": [
            { "type": "part", "part": "lines", "variant": "heading-above" },
            { "type": "part", "part": "summary", "variant": "with-items" },
            { "type": "target", "target": "cart.page.summary" },
            { "type": "target", "target": "cart.page.below" }
          ] },
          { "type": "part", "part": "details" }
        ] }
      ],
      "items": {
        "line": [
          { "type": "layout", "layout": "grid", "hook": "line-grid", "children": [
            { "type": "part", "part": "image" },
            { "type": "layout", "layout": "stack", "children": [
              { "type": "part", "part": "title" }, { "type": "part", "part": "details", "variant": "values" }, { "type": "part", "part": "inputs" }
            ] },
            { "type": "layout", "layout": "stack", "children": [{ "type": "part", "part": "price" }, { "type": "part", "part": "quantity" }, { "type": "part", "part": "remove", "variant": "words" }] }
          ] },
          { "type": "target", "target": "cart.line.after" },
          { "type": "part", "part": "limit" }, { "type": "part", "part": "issue" }, { "type": "part", "part": "rule" }
        ]
      }
    }
  }
}
```

## Tokens

Each page names its **style targets**, the elements of its parts that take a look, and the tokens each one takes. You set values; the store writes every CSS rule from them. The [anatomy reference](#anatomy-reference) lists each target as `style <name> <selector> tokens=…`.

**Token mode.** A page with any token is drawn in token mode (`data-private-tokens` on `<html>`), and so is the cart page of a theme with a page paint (`tokens.pagePaint`, [themes](themes.md)), tokens or not. Every colour a buyer reads there comes from one **colour table** the store resolves when you save:

- the table has a row for every style target at every place your arrangement puts it, for each palette a buyer can see (light, dark or both): each app node kind and tone at each of the page's targets, and again inside each app box that paints a surface; the store's dialogs; every filled button; a field and a field label in every box that holds fields; the store's chrome and its controls;
- a row holds a solid surface (or a gradient's points), the colour of the target's own words, its muted, link and error words, its border and focus ring, its hover surface (a step from the surface that its words still read on), and for a field its placeholder and error border;
- each is your token where you set one, else a default that reads on the surface beneath: a dark box gives its untouched children readable words, a field keeps its own surface, and Place order or Confirm left at the palette's fill on a box where it would not show takes one that does;
- the page stands on the theme's page paint unless your `page` tokens give it a surface, so every row on the page, the store's defaults included, is checked along the whole paint;
- the store writes exactly those rows as CSS and checks exactly those rows ([floors](#floors)). Inside the page, the store's own palette classes read the nearest row, so no translucent tint and no palette colour decides a colour there. The page is drawn from its arrangement (the store's default one if you set none), so the table's places are the page's.

A page with no token, in a theme with no page paint, is drawn exactly as the store draws it. The drawer takes no tokens (`unknown_style`): it opens over public pages and takes their look.

**A colour per scheme.** Every colour token (`background`, `text`, `muted`, `link`, `error`, `border`, `ring`, `placeholder`, `invalid`, and a gradient's `from` and `to`) takes one colour for both schemes, or `{ "light": <colour>, "dark": <colour> }` with both keys. A colour is a palette role (`card`, `primary`, `muted-foreground`, …) or an opaque lowercase `#rrggbb`. Each palette buyers can see draws its own value and is checked on its own; a refusal names the scheme. A scheme your theme never shows is never drawn, so its value is not checked.

| Token | Value | Writes |
| --- | --- | --- |
| `background` | A colour | The row's surface |
| `gradient` | `{ "shape": "linear" \| "radial", "angle"?: 0–360, "from": colour, "to": colour }` (linear defaults to 180; radial is a circle from the top) | The row's surface, checked at every point |
| `text` | A colour | The target's own words (and plain words inside it) |
| `muted`, `link`, `error` | A colour | Its muted, link and error words |
| `border` | A colour | Its border (a field's, the stepper's, the fold bar's and Go back's at 3:1 on what is around it) |
| `ring` | A colour | The focus ring of what is inside it; a field's or a button's own |
| `placeholder`, `invalid` | A colour | A field's placeholder and error border |
| `border-width`, `radius` | Whole pixels: 0–4, 0–32 | Those properties; `border-width: 0` draws no border, so a field or an outlined control is then found by its own fill (3:1); 2 or more, solid, may find Place order or Confirm by its edge (see Floors) |
| `border-style` | `solid`, `dashed`, `dotted`, `none` | `border-style`; `none` as `border-width: 0` |
| `shadow` | `none`, `sm`, `md`, `lg` | A fixed `box-shadow` |
| `padding`, `gap` | 0–48 px | Those, at most 4% of the screen's width on a phone; a padding is never under 4px nor under 30% of the radius, so focus rings and rounded corners stay on the box's surface |
| `inset` | 0–32 px | A button's room at its sides; the store keeps its height (44px to tap on a phone) |
| `font` | `body`, `heading` (the theme's typography), `mono` (the system's monospace face) | `font-family` |
| `size` | 12–40 px | `font-size`, at most 7% of the box it sits in (a line, a layout node, else the screen; never under 12px) |
| `leading` | `tight` (1.25), `snug` (1.375), `normal` (1.5), `relaxed` (1.625) | `line-height`, on the words inside too |
| `weight` | `400`, `500`, `600`, `700`, `800` | `font-weight`, on the words inside too |
| `case` | `none`, `uppercase` | `text-transform` |
| `tracking` | `normal`, `wide`, `wider` | `letter-spacing` |
| `align` | `start`, `center`, `end` | `text-align` |
| `clamp` | `none`, `2`, `3` (lines of a title) | A line clamp on the title's link, so its focus ring is never clipped |
| `columns`, `columns-wide` | 1 to 4 tracks: `auto`, `min-content`, `1fr`–`4fr`, or 24–480 px | A layout node's columns, only where the box holding it fits them (below) |
| `width`, `height`, `width-wide`, `height-wide` | 40–240 px (at most 30% of its line), 40–320 px | An image's size; `-wide` from 40rem |
| `fit` | `contain`, `cover` | The image's `object-fit` |
| `max-width` | 480–1600 px | The page frame's width |

No value is text CSS reads as code: no `var()`, no `calc()`, no `url()`, no font name.

### Style targets

A target is a **box** (a surface that holds other things), a **field** (its own surface and words; its border, focus ring and error border read on the box around it), a **control** (a button, a stepper, a toggle: its focus ring reads on what is around it) or **text** (words on a surface). It stands on the row of the place it is drawn.

A buyer must find each control and field where it stands (WCAG 1.4.11, 3:1 on what is around it), and the anatomy says how (`boundary=` in the [anatomy reference](#anatomy-reference)): a **filled** button (Place order, Confirm) by its fill, or by a drawn edge where its fill does not read there (a brand yellow on a light card: `"border": "#111111", "border-width": 2`, solid, at 3:1, over a fill still clearly a colour of its own); an **outlined** one (the stepper, the fold's bar, Go back) and every field by its border, or, where your tokens draw none (`border-width: 0`, `border-style: none`), by its own fill. A field drawn as a box around its input (the phone number with its country code) is that box. The check reads the edge the page draws, never one it does not.

| Target | What it is | Kind | Stands on |
| --- | --- | --- | --- |
| `page` | The page itself | box (`background`) | the page paint, when it paints nothing |
| `frame` | The page frame (its width) | box | `page` |
| `action` | Every filled button the store draws without a target of its own | control (`primary`) | every box |
| `input` | Every field on the page and in its dialogs | field (`background`) | each box that holds fields: the discount part, the details form, a line's inputs, a dialog, the market and language forms, an app's target |
| `field-label` | Every field's label, and a group of fields' legend | text | each box that holds fields |
| `notice` | Each notice | box | where `notices` sits |
| `lines` | The lines card | box (`card`) | where `lines` sits |
| `lines-heading` | The page's `h1` | text | `lines`; with `heading-above`, what the card stands on |
| `lines-intro` | Your `cart.intro` sentence under the heading | text (muted) | as `lines-heading` |
| `cart-empty` | The empty cart's words | text | `lines` |
| `line` | One cart line | box | `lines` |
| `line-image`, `line-title`, `line-details`, `line-price` | A line's image, title (a link), facts and price | text | the line |
| `line-chip` | A fact as a chip (`chips`) | text on a surface of its own | `line-details` |
| `line-quantity`, `line-remove` | A line's stepper and remove | control | the line |
| `fold-toggle` | The phone fold's bar | control (`card`) | where the fold sits |
| `summary` | The summary box | box (`card`) | where `summary` sits |
| `summary-heading` | Your `cart.summaryHeading` at its top | text | `summary` |
| `summary-rows` | Every money row but the total (items, subtotal, add-ons, delivery, discount, tax) | text (muted, 14px, its amounts 500) | `summary` |
| `summary-total` | The total row: its amount (20px, 600) | text | `summary` |
| `summary-total-label` | The total's label, apart from its amount (a `size` or `weight` on the total reaches it unless you set its own) | text | `summary-total` |
| `summary-add-on` | An add-on row's bar, which opens to the app's lines | control (muted) | `summary-rows` |
| `summary-add-on-detail` | Each of those lines | box | `summary-rows` |
| `details-form` | The details form; it holds the targets `checkout.contact.after` and `checkout.delivery.after` | box (`card`) | where `details` sits |
| `section-heading` | The form's Contact and Delivery headings | text | `details-form` |
| `dock` | The page's last box: Place order, the total, the terms and why Place order may be off. It always paints its own surface ([below](#what-the-store-guarantees-and-what-is-yours)) | box (`background`) | `page` |
| `submit` | Place order (16px, 600; `action`'s `size` and `weight` reach it unless you set its own) | filled control (`primary`) | `dock` |
| `legal` | The terms sentence or the required tick box (its tick drawn in the row's link colour, read at 4.5:1 on the dock) | text (muted) | `dock` |
| `dialog` | The store's dialogs: the confirmation an app's choice asks for, sign-in | box (`card`), holds fields | `page` |
| `dialog-title` | A dialog's title | text | `dialog` |
| `dialog-text`, `dialog-agree` | What the buyer agrees to, and the row with the tick box saying so: side by side, neither inside the other | box | `dialog` |
| `dialog-back` | Go back: outlined, never filled (it takes no `background`) | outlined control | `dialog` |
| `dialog-confirm` | Confirm (14px; `action`'s `size` and `weight` reach it unless you set its own) | filled control (`primary`) | `dialog` |
| `chrome` | The store's checkout header and the controls strip | box (`background`) | `page` |
| `scheme` | The light or dark switch | control | `chrome` |
| `localization` | The market and language forms | box, holds fields | `chrome` |

**The payment step** takes the same names for the same things: `page`, `frame`, `action`, `input`, `field-label`, `notice`, `chrome`, `scheme`, `localization`; the order summary's `summary`, `summary-heading`, `summary-rows`, `summary-total` (with what is left to pay after a gift card or a deposit, which ranks with the total), `summary-total-label`, `summary-add-on`, `summary-add-on-detail` and its phone bar `fold-toggle`; Pay is `submit` and the terms beside it `legal`. Its own:

| Target | What it is | Kind | Stands on |
| --- | --- | --- | --- |
| `checkout-empty` | No checkout to pay for: the way back to the store | box (`card`) | where `empty` sits |
| `heading` | The page's `h1` | text | where `heading` sits |
| `gift-card` | The gift card form | box (`card`), holds fields | where `gift-card` sits |
| `payment-method` | One payment method's card | box (`card`) | where `payment` sits |
| `payment-chosen` | The method the buyer chose (drawn over `payment-method`) | box | `payment-method` |
| `payment-details` | The chosen method's details: its notice, the provider's surface, the terms and Pay | box | `payment-chosen`; with `tiles`, where `payment` sits |

The payment provider's own surface (`data-part="gateway"`: its card form, its frame) has no target, and token mode never reaches into it: it keeps the store's colours whatever you set, and nothing of yours covers or reorders it. The provider's mark on a method keeps its white badge. A total smaller than a money row, or a Pay or a word that does not read, is refused as on the cart.

**Layout nodes.** A layout node takes `background`, `gradient`, `border`, `border-width`, `border-style`, `radius`, `shadow`, `padding`, `gap`, `columns` and `columns-wide` through its hook: `"@line-grid": { "columns": [64, "1fr", 88] }`. A hook with a colour is a row of the table. Its `columns` apply only where the box holding it fits every track at its floor (20rem for a track that holds the page's parts, 4rem inside a line) and the gaps between; `columns-wide` from 40rem. Elsewhere the store's one column draws, so a part is never squeezed. The store's own layouts split by the width of the box they sit in, never the screen's: a `columns` draws its children side by side from 48rem, and only as many in a row as keep each at least 20rem wide.

### Apps' blocks

The store draws an app's block from typed nodes ([commerce hooks](commerce-hooks.md#buyer-ui-extensions)), so it is one of the store's parts. You give it a look by node kind, under `ui.<kind>`, narrowed by tone, app and target: `"ui.stack.warning@acme.protection/cart.line.after": { "background": "#3a2a0a", "text": "#fde68a" }`. A row reads every key that matches it, the most specific last. Every kind and tone has a row at each of the page's targets (`cart.page.summary`, `cart.page.below`, `cart.line.after`, and `checkout.contact.after`, `checkout.delivery.after` inside the details form; on the payment step `checkout.summary.after` inside the summary, `checkout.payment.after` and `checkout.actions.before`), on whatever that target sits on, whether you name it or not. A key names a target of its own page: `"ui.badge.success@acme.protection/checkout.summary.after"` styles a "✓ Protection added" badge in the payment step's summary, and the same key with `/cart.line.after` the badge under a cart line.

| Kind | Draws | Tones | Tokens |
| --- | --- | --- | --- |
| `ui.banner` | A banner; it holds only its own buttons | each | `background`, `text`, `border`, `border-width`, `radius`, `shadow`, `padding` |
| `ui.stack` | A toned stack: an offer row, a status box | each | `background`, `text`, `border`, `border-width`, `radius`, `shadow`, `padding`, `gap` |
| `ui.button` | A button or a button-like link | `primary`, `secondary`, `critical` (the button's own; untoned is `secondary`) | `background`, `text`, `border`, `border-width`, `radius`, `ring`, `inset`, `weight`, `size`, `case` |
| `ui.badge` | A badge | each | `background`, `text`, `border`, `radius`, `padding`, `inset`, `weight`, `size` |
| `ui.mark` | A tone's glyph in a circle (the circle is twice its `size`) | each | `text`, `border`, `size` |
| `ui.text` | Words | each | `text`, `font`, `size`, `weight`, `leading` |
| `ui.heading` | A heading | | `text`, `size`, `weight`, `font`, `case` |
| `ui.link` | A link, on a line of its own or inside a sentence (`ui.text` pieces); the store always underlines it. `size` styles a link on its own line: one inside a sentence keeps the sentence's size | | `text`, `size`, `weight` |
| `ui.keyvalue` | Label and value rows: the labels are its muted words, the values its text | | `text`, `muted`, `size`, `weight` |
| `ui.disclosure` | A disclosure the buyer opens | | `background`, `text`, `border`, `radius` |
| `ui.row` | A plain stack or columns (no colour, no row of the table) | | `gap` |

The tones are `neutral`, `info`, `success`, `warning` and `critical`; critical words default to the error colour.

A button's tones are its own: fill `ui.button.primary` ("Add Now") and a protected line's `critical` "Remove" keeps its own look. Each tone reads on the surface it sits on, and no `ui.button` key, in any tone, is drawn larger or heavier than the store's own action on the page (Place order on the cart): `prominence` otherwise. The cart drawer's buttons carry the same `data-tone` for your public stylesheet.

**What a box holds.** A banner, a toned stack and a disclosure draw their children on their own surface. When you give one a surface (`background` or `gradient`), every kind and tone it can hold gets a row inside it (a banner: its buttons only; an app's box: that app's nodes only), checked on that box in each scheme: a link or a price inside an amber offer row is checked on amber, not on the line, and so is a link inside a sentence there (the sentence paints nothing of its own). A box that paints nothing adds no rows. A node writes only the colours you set for it and reads the rest from the row it stands on, so its rule is the same in every box at any depth. A field or a field label drawn in an app's painted box is checked on it too.

### Floors

The check reads every row of every palette's table:

| What | Must read at | On |
| --- | --- | --- |
| Every word (text, muted, link, error, placeholder) | 4.5:1 | its surface and every point of a gradient; a row's words also on its hover surface |
| A field's border and error border | 3:1 | the box around the field |
| A filled button's fill (Place order, Confirm), or its drawn edge: a solid border of at least 2px (`border-width` set, `border-style` unset or `solid`) over a fill clearly a colour of its own (CIE76 40 from every point around it: a fill near the dock with an edge is Go back's look and is refused); an outlined control's or a field's border, or its own fill where no border is drawn | 3:1 | what is around it |
| Every focus ring | 3:1 | what is around the control or field; a box's rings on the box |
| The total's amount | its size at least every money row's, every add-on line's, its own label's, a line price's and an app's words drawn in the summary (`ui.*` at `cart.page.summary`, or naming no target); its weight at least the rows'; its words' contrast on the summary at least the strongest of the rows' words (their own, their amounts', a discount's). Its size is drawn at least at the largest of those, so a narrow summary never shrinks it under rows the store keeps at their size | the summary |
| The total's label | its size at least every money row's | the summary |
| Place order | its size and weight at least the store's other filled buttons' (`action`) | the page |
| Confirm | its size and weight at least Go back's | the dialog |

A refusal names the theme key and the pair that set it, and the scheme: `summary-rows: text #eeeeee on #ffffff is 1.16:1 in the light colours, under the 4.5:1 a buyer needs.` A theme key's bad pair is refused once, however many rows read it.

### Refusals

| Reason | Means |
| --- | --- |
| `not_available` | A stylesheet, files for it, your own chrome, the store's search in it, or a content block ([above](#not-available-yet)). |
| `missing_part`, `missing_target` | A mandatory part or a target is not in the arrangement. |
| `duplicate_part`, `duplicate_target` | A part or a target appears twice. |
| `unknown_part`, `unknown_target`, `unknown_layout`, `unknown_variant`, `unknown_frame`, `unknown_item` | No such name on that page or unit. |
| `layout_once` | A second `fold` or `scroll`. |
| `layout_holds` | The fold holds what a buyer fills in or must read first. |
| `part_order` | The cart's `notices` come after its `details` in reading order. |
| `lead_order` | A part or target other than `progress` and `notices` comes before the first of `lines`, `summary` and `details`. |
| `empty_layout` | A layout holds nothing. |
| `invalid_hook` | A hook that is not lowercase words joined by hyphens, or over 40 characters. |
| `too_deep`, `too_many_nodes` | Layouts nested over 6 deep, a layout with over 24 nodes, or a unit with over 80. A document nested over 12 deep is refused before it is read (`too_deep`). |
| `unknown_style` | No such style target, node kind, tone or target on the page, no layout node with that hook, or any token on the drawer. |
| `unknown_token` | The target does not take that token. |
| `token_value` | Not a value of the token's type, outside its bounds, or a colour per scheme without both keys. |
| `contrast` | A row reads under its floor in a scheme a buyer sees, or the chosen payment method's edge and dot (its card's `link`) are not clearly apart from an unchosen card's `border`. |
| `prominence` | The total drawn smaller than a money row, an add-on line or its own label, lighter than the rows, or with fainter words than theirs; its label smaller than the rows; Place order smaller or lighter than the other filled buttons; Confirm smaller or lighter than Go back. |
| `no_row` | The page draws a target the colour table has no row for (a store defect; it never draws unchecked). |
| `too_large` | A page's tokens name over 160 style keys or over 4 apps, would make over 6000 rows of its colour table (refused before anything is resolved), or its compiled look is over 64 KiB (each page has its own bound: it serves only its own look). |
| `unknown_app` | A `ui.*@<app>` token names an app that is not installed. |
| `label_variant` | A label that names an action or an amount set to something other than one of its variants, or a variant where your words go. |
| `label_too_long`, `markup`, `label_figures` | Words over the label's bound, words with HTML, or a digit, a currency sign, a name of money or one of the store's amount words in a heading, title or empty state (only `cart.intro` and `cart.emptyText` may hold them). |
| `foreign_asset` | An icon from an app other than your theme's. |

A value that is not of the document's shape (a wrong type, an unknown field) is refused by the schema, naming its path.

`validate` runs these same checks on every template you ship, through the store's own code, and prints each with its place and reason (`✗ Theme templates: storefront.templates[0] (studio).theme.privatePages.tokens.cart.summary-total: … [contrast]`), so a template that validates is one the store applies and saves. An icon names a file your release carries in `public/`; the install refuses a release without it, and `validate` names the missing file.

## Words and icons

A label that names an action or an amount takes one of the store's **variants**, which the store words in each language it translates (English, Bangla), so "Go back" never confirms and a subtotal never reads as the total. A heading, an intro or an empty state takes **your own words**, per language: plain text, a page shows its language, then English. Invisible characters, direction overrides and tag characters outside a flag are removed. A heading, a title or an empty state holds no digit or currency sign in any script, and none of the store's amount words or names of money as whole words, in English or Bangla ("Total", "Subtotal", "Amount due", "taka", "BDT", "dollar", "সর্বমোট", "মোট", "টাকা"; `PRIVATE_LABEL_AMOUNT_WORDS`), so no label reads as an amount (`label_figures`); only the sentences `cart.intro` and `cart.emptyText` may hold them. Words that read like an action ("Pay now" as a heading) are a known limit: they carry no figure and do nothing, but the store cannot tell what they say.

| Label | Where | Value |
| --- | --- | --- |
| `cart.continue` | Cart page | `continue-shopping`, `keep-shopping`, `back-to-store` |
| `cart.subtotal` | Cart page | `subtotal`, `items-total` |
| `cart.showSummary`, `cart.hideSummary` | Cart page, phones | `show-summary`, `show-cart`; `hide-summary`, `hide-cart` |
| `dialog.goBack` | The confirmation an app's choice asks for | `go-back`, `cancel` |
| `dialog.confirm` | Same | `confirm`, `continue-checkout`, `agree-and-continue` |
| `drawer.checkout` | Drawer | `checkout`, `proceed-to-checkout` |
| `drawer.viewCart` | Drawer | `view-cart`, `go-to-cart` |
| `drawer.continue` | Drawer | `continue-shopping`, `keep-shopping` |
| `drawer.startShopping` | Drawer, empty | `start-shopping`, `browse-products`, `continue-shopping` |
| `cart.heading` | Cart page, the `h1` | Your words, at most 60, no figure |
| `cart.intro` | Cart page, one sentence under the heading (drawn only when set) | Your words, at most 200, figures allowed |
| `cart.summaryHeading` | Cart page, the summary's `h2` (drawn only when set) | Your words, at most 40, no figure |
| `cart.empty`, `cart.emptyText` | Cart page, empty | Your words, at most 80 (no figure), 200 (figures allowed) |
| `drawer.title`, `drawer.empty` | Drawer | Your words, at most 40, 80, no figure |

The words a part's variant draws are the store's: "Remove" (সরান) for `remove: words`, "Items" (পণ্য) for `summary: with-items`. Icons: `cart.empty`, `drawer.empty`.

## The receipt and the account

The receipt (`/order-success`: the confirmation and the order's status view, and the theme editor's sample receipt) and the account's dashboard and order page take **tokens** (`tokens.receipt`, `tokens.account`), checked by the same colour table and floors as the cart: contrast per scheme, and the total never drawn smaller than another money row. They are not arranged yet: an arrangement other than the store's own for `pages.receipt` or `pages.account` is refused (`not_available`). Their parts are named in the [anatomy](#anatomy-reference) so the names stay when arranging comes.

A thing that is the same thing as on the cart has the cart's name: `page`, `frame`, `action`, `input`, `field-label`, the dialogs (`dialog`, `dialog-title`, …), the money rows (`summary`, `summary-heading`, `summary-rows`, `summary-total`, `summary-total-label`, `summary-add-on`, `summary-add-on-detail`), and an order's line (`line`, `line-image`, `line-title`, `line-details`, `line-price`; the receipt's line image takes no `fit`: it is the image itself, with no box around it). Both pages draw the store's public header and footer (the store's own markup in its closed variants and the palette's colours; on a buyer's page no app's header skin, component, stylesheet or script draws there) and, on phones, the theme's tab bar where it has one. That chrome is outside the page's root and takes the palette, not these tokens, so `chrome`, `scheme` and `localization` are not theirs.

| Page | Target | What it is | Kind |
| --- | --- | --- | --- |
| Receipt | `status`, `status-mark`, `status-title`, `status-message`, `status-steps` | The order's state: its mark, its title (the page's `h1`), its message and next steps | box, text on its own surface, text, text (muted), box |
| Receipt | `tracking` | Where the order is (the status view) | box (`background`) |
| Receipt | `order`, `order-facts`, `status-badge` | The order card; its facts (the order number, placed, state, payment); a state's pill | box (`background`), text, text on its own surface |
| Receipt | `delivery`, `section-heading`, `delivery-contact` | Where it goes, its heading, the buyer's own name, address and contact | box, text, text |
| Receipt | `lines`, `lines-heading` | What was bought, its heading; each line under it | box, text |
| Receipt | `conversation` | The order's conversation with the store (it holds the reply form) | box (`card`) |
| Receipt | (none) | The recommendations: public product cards on the store's own look and the palette's page, never in token mode and no row of the table | |
| Account | `navigation`, `nav-item`, `nav-current`, `sign-out` | The menu, each page in it, the current page (its marker is its `link` colour), Sign out | box, control (muted), control, control (muted) |
| Account | `heading-title`, `heading-intro`, `heading-back` | The page's `h1`, its intro, the way back | text, text (muted), control |
| Account | `content` | The page's content; it holds the apps' targets `account.overview`, `account.order`, `account.profile`. It takes no tokens: most account pages draw no box around it, so what stands in it stands on the page | box (no tokens) |
| Account | `card`, `card-title`, `status-badge` | Every account card, its heading, a state's pill | box (`card`), text, text on its own surface |
| Account | `delivery-message`, `delivery-reveal` | A line's delivery message and the button that reveals it (with no border drawn, its fill reads 3:1 on the message, as Sign out's does) | box, control |

The money summary sits in the receipt's `order` card and in an account order's `card`. An order's `line` holds the apps' `order.line.after` (drawn under a line only where an app answered for it). The apps' blocks take the same `ui.<kind>…` rows as on the cart, at these pages' targets (`order.confirmation`, `account.order`, `order.line.after` on the receipt; `account.overview`, `account.order`, `account.profile`, `order.line.after` in the account).

What a theme cannot lose: the receipt's state, order card (its number, its state, every money row and the total), delivery card (the buyer's contact), lines, actions and conversation, and the account's menu with Sign out, its heading and its content are mandatory parts; no token hides anything (every word reads at its floor, sizes are at least 12px). Nothing here changes what a page reads or who may read it: a delivery message is still revealed only on the signed-in account's order page. The other account pages (profile, reviews, warranties, gift cards, downloads, inbox) carry the shell's hooks but not the look yet.

## The add-on row

An app's `cart.line_prices` add-on shows as its own money row (`data-summary-row="add-on"`, one per app and title) on six surfaces: the cart page, the drawer, the payment step, quick checkout, the receipt and the account order. A row whose add-on carries `details` lines ([line add-ons](commerce-hooks.md#line-add-ons)) opens to them:

- it is the browser's own disclosure (`<details data-part="add-on-details">`), so it opens with no script, on the server-drawn receipt too;
- its bar (`<summary>`) holds the title, a chevron and the amount, so the amount shows once, open or closed; the bar is 44px tall on a phone;
- under it, each line is `data-part="add-on-detail"`, in line order, as plain text (at most 50 a row on the cart page, the drawer, the payment step and quick checkout; at most 10 a row and 50 in all on the receipt and the account order, as in the emails and the invoice);
- it starts closed. The cart page and the drawer redraw the summary as the cart changes: a row the buyer opened stays open, and a row that first appears after the buyer adds the add-on opens by itself (never on the page's first answer).

A row with no details is a plain row of its title and amount. On the cart page and the payment step the bar takes the `summary-add-on` tokens and each line `summary-add-on-detail`, on the `summary-rows` row; elsewhere the row takes the look of the money rows around it.

## The store's controls

The cart page and the payment step draw only the store's chrome: its checkout header, no theme or app header or footer. The receipt and the account draw the store's public header and footer ([below](#the-receipt-and-the-account)). The phone tab bar never draws where the buyer is paying (the cart, the checkout and quick checkout, buy now, payment recovery); the receipt and the account pages keep it. `controls` places the store's controls:

| `controls` | Where |
| --- | --- |
| `header` (unset) | In the store's checkout header (`data-private="core-header"`). |
| `footer` | In a strip at the page's end (`data-private="core-footer"`), drawn only when it has a control to show. |
| `none` | Neither. |

The controls are the light or dark switch (`data-host="scheme"`), when the theme offers it (`tokens.colorSchemeToggle`), and the market and language forms (`data-host="localization"`, the same plain forms as the public footer's), when the store sells in several. Their look is the `chrome`, `scheme` and `localization` rows. Under the store's default look (a look not yet compiled by this build) they sit in the header.

## What the store guarantees, and what is yours

| The store guarantees | Yours |
| --- | --- |
| No theme markup and no theme CSS: every rule is written from typed values, and in token mode every colour comes from the one table the save checks. | Choosing tokens that read well together beyond the floors. |
| Place order with its total is always on screen: it is the page's last box (`dock`), docked at the bottom edge while its place is not in view, at every width and under every arrangement, with no script. | Its look: the `dock`, `submit` and `legal` tokens. |
| The terms sit in the dock beside Place order: the sentence, or the required tick box, which posts with the details form it sits outside of. | |
| Every row of the table reads at its floor, in every scheme a buyer sees. Place order and Confirm are found by their fill or by a solid edge of at least 2px over a fill of their own, never drawn as plain words or as an outlined button. | Which of the two: a fill that reads, or your brand's fill with an edge. |
| The total is never drawn smaller than another money row, and a label that names an action or an amount is one of the store's variants. | Your words for headings and empty states: say what they are. |
| One of the cart's lead parts (the lines, the summary, the details form) starts inside the first screen. | |
| A buyer's request never compiles; a look an older checker wrote is not served. | Re-saving after a store update if you want your look before the next maintenance run. |
| | The drawer's look on public pages (your public stylesheet). |

## The reference cart

The customer's prototype (a dark purple game store with a light scheme) expressed with this model alone: an arrangement with variants, tokens per scheme for the store's parts and the protection app's offer row, badge and status boxes, the store's controls in its header, and labels. Where the prototype's own colour reads under a floor, the nearest colour that passes stands in; the store's tests compile it against its light and dark palettes and show the prototype's own values refused.

```json
{
  "controls": "header",
  "pages": {
    "cart": {
      "layout": [
        { "type": "part", "part": "notices" },
        {
          "type": "layout",
          "layout": "columns",
          "hook": "cart-columns",
          "children": [
            {
              "type": "layout",
              "layout": "stack",
              "children": [
                { "type": "part", "part": "lines", "variant": "heading-above" },
                {
                  "type": "layout",
                  "layout": "fold",
                  "children": [
                    { "type": "part", "part": "summary", "variant": "with-items" },
                    { "type": "target", "target": "cart.page.summary" }
                  ]
                },
                { "type": "target", "target": "cart.page.below" }
              ]
            },
            { "type": "part", "part": "details" }
          ]
        }
      ],
      "items": {
        "line": [
          {
            "type": "layout",
            "layout": "grid",
            "hook": "line-grid",
            "children": [
              { "type": "part", "part": "image" },
              {
                "type": "layout",
                "layout": "stack",
                "children": [
                  { "type": "part", "part": "details", "variant": "values" },
                  { "type": "part", "part": "title" },
                  { "type": "part", "part": "inputs" },
                  { "type": "part", "part": "limit" },
                  { "type": "part", "part": "issue" },
                  { "type": "part", "part": "rule" }
                ]
              },
              {
                "type": "layout",
                "layout": "stack",
                "hook": "line-side",
                "children": [{ "type": "part", "part": "price" }, { "type": "part", "part": "quantity" }, { "type": "part", "part": "remove", "variant": "words" }]
              }
            ]
          },
          { "type": "target", "target": "cart.line.after" }
        ]
      }
    }
  },
  "tokens": {
    "cart": {
      "page": { "gradient": { "shape": "radial", "from": { "light": "background", "dark": "#2b2d6e" }, "to": "background" } },
      "frame": { "max-width": 1400 },
      "notice": { "background": { "light": "#f2ebd9", "dark": "#35282c" }, "text": { "light": "#000000", "dark": "#fef3c6" }, "radius": 0, "border-width": 0 },
      "lines": { "background": "card", "border": "#524179", "border-width": 0, "radius": 0, "shadow": "lg" },
      "lines-heading": { "size": 36, "weight": "600", "text": "foreground" },
      "lines-intro": { "text": "muted-foreground", "size": 14 },
      "line-image": { "width": 64, "height": 80, "width-wide": 92, "height-wide": 112, "radius": 0, "fit": "cover", "background": "popover" },
      "line-details": { "text": "muted-foreground", "size": 12 },
      "line-title": { "weight": "600", "clamp": "2", "text": "foreground", "leading": "tight" },
      "line-price": { "size": 18, "weight": "600", "align": "end", "text": { "light": "#000000", "dark": "#5ee9b5" }, "muted": { "light": "#111111", "dark": "#83838d" } },
      "line-quantity": { "background": "muted", "border": { "light": "#7b7b7b", "dark": "#8575ae" }, "radius": 0, "text": { "light": "#111111", "dark": "#d4d4d8" } },
      "line-remove": { "text": "destructive", "size": 14, "weight": "400" },
      "summary": { "background": "card", "text": { "light": "#000000", "dark": "#d1d1d5" }, "border": "#524179", "border-width": 0, "radius": 0, "padding": 20, "gap": 12, "shadow": "lg" },
      "summary-heading": { "size": 20, "weight": "600", "text": "foreground" },
      "summary-rows": { "text": { "light": "#000000", "dark": "#d1d1d5" }, "size": 14 },
      "summary-total": { "text": { "light": "#000000", "dark": "#5ee9b5" }, "size": 20, "weight": "600" },
      "summary-total-label": { "text": "foreground", "size": 16, "weight": "600" },
      "summary-add-on": { "text": { "light": "#000000", "dark": "#5ee9b5" } },
      "summary-add-on-detail": {
        "background": { "light": "#dff7e8", "dark": "#10161e" },
        "border": { "light": "#b7e6c9", "dark": "#10161e" },
        "border-width": 1,
        "radius": 0,
        "padding": 8,
        "size": 12,
        "text": { "light": "#000000", "dark": "#d4d4d8" },
        "muted": { "light": "#111111", "dark": "#7e7e88" }
      },
      "details-form": { "background": "card", "padding": 20, "radius": 0, "border-width": 0 },
      "section-heading": { "size": 20, "weight": "600" },
      "input": {
        "background": "muted",
        "text": "foreground",
        "border": { "light": "#7b7b7b", "dark": "#8575ae" },
        "radius": 0,
        "ring": { "light": "#907a00", "dark": "#a397ff" }
      },
      "field-label": { "size": 12, "weight": "600" },
      "dock": { "background": "card", "border": "#524179", "border-width": 1 },
      "submit": {
        "background": { "light": "#fed700", "dark": "primary" },
        "text": { "light": "#000000", "dark": "primary-foreground" },
        "border": { "light": "#000000", "dark": "primary" },
        "border-width": 2,
        "radius": 0,
        "weight": "600",
        "size": 14,
        "inset": 20
      },
      "cart-empty": { "text": "foreground", "muted": "muted-foreground" },
      "dialog": {
        "background": "#171124",
        "text": "#ffffff",
        "muted": "#d4d4d8",
        "border": { "light": "#eaeaea", "dark": "#49396d" },
        "border-width": 1,
        "radius": 0,
        "shadow": "lg"
      },
      "dialog-title": { "size": 24, "weight": "800", "leading": "tight", "text": "#ffffff" },
      "dialog-text": { "background": "#110d1e", "border": "#443567", "border-width": 1, "radius": 0, "padding": 16, "text": "#d4d4d8", "muted": "#d4d4d8" },
      "dialog-agree": { "background": "#241b39", "border": "#49396d", "border-width": 1, "radius": 0, "padding": 16, "text": "#e4e4e7" },
      "dialog-back": { "text": "#e4e4e7", "border": "#8575ae", "border-width": 1, "radius": 0, "weight": "700", "inset": 20 },
      "dialog-confirm": {
        "background": { "light": "#fed700", "dark": "primary" },
        "text": { "light": "#333e48", "dark": "primary-foreground" },
        "radius": 0,
        "weight": "800",
        "inset": 20
      },
      "ui.stack.warning@arcade.protection/cart.line.after": {
        "background": { "light": "#f2ebd9", "dark": "#35282c" },
        "text": { "light": "#000000", "dark": "#fef3c6" },
        "border-width": 0,
        "radius": 0,
        "padding": 8,
        "gap": 8
      },
      "ui.mark.warning@arcade.protection/cart.line.after": {
        "text": { "light": "#000000", "dark": "#fee685" },
        "border": { "light": "#f7e195", "dark": "#866c2e" },
        "size": 12
      },
      "ui.text@arcade.protection/cart.line.after": { "text": { "light": "#000000", "dark": "#fef3c6" }, "size": 14, "weight": "500" },
      "ui.text.success@arcade.protection/cart.line.after": { "text": { "light": "#000000", "dark": "#5ee9b5" }, "size": 14, "weight": "600" },
      "ui.link@arcade.protection/cart.line.after": { "text": { "light": "#000000", "dark": "#5ee9b5" }, "size": 12, "weight": "500" },
      "ui.button@arcade.protection/cart.line.after": {
        "background": { "light": "#fed700", "dark": "primary" },
        "text": { "light": "#333e48", "dark": "primary-foreground" },
        "border": { "light": "#fed700", "dark": "primary" },
        "border-width": 0,
        "radius": 0,
        "weight": "600",
        "size": 12,
        "inset": 16
      },
      "ui.badge.success@arcade.protection/cart.line.after": {
        "background": "card",
        "text": { "light": "#000000", "dark": "#5ee9b5" },
        "border": "card",
        "radius": 0,
        "padding": 0,
        "weight": "600",
        "size": 12
      },
      "ui.stack.warning@arcade.protection/cart.page.summary": {
        "background": { "light": "#f2ebd9", "dark": "#35282c" },
        "text": { "light": "#000000", "dark": "#ffffff" },
        "border-width": 0,
        "radius": 0,
        "padding": 12,
        "gap": 12
      },
      "ui.stack.success@arcade.protection/cart.page.summary": {
        "background": { "light": "#fed700", "dark": "#1b2839" },
        "text": { "light": "#000000", "dark": "#ffffff" },
        "border-width": 0,
        "radius": 0,
        "padding": 12,
        "gap": 12
      },
      "ui.mark.warning@arcade.protection/cart.page.summary": {
        "text": { "light": "#000000", "dark": "#fee685" },
        "border": { "light": "#f7e195", "dark": "#786231" },
        "size": 14
      },
      "ui.mark.success@arcade.protection/cart.page.summary": {
        "text": { "light": "#000000", "dark": "#a4f4cf" },
        "border": { "light": "#bede48", "dark": "#36756b" },
        "size": 12
      },
      "ui.text@arcade.protection/cart.page.summary": { "text": { "light": "#000000", "dark": "#ffffff" }, "size": 14, "weight": "600" },
      "ui.link@arcade.protection/cart.page.summary": { "text": { "light": "#000000", "dark": "#5ee9b5" }, "size": 12, "weight": "500" },
      "ui.button@arcade.protection/cart.page.summary": {
        "background": { "light": "#fed700", "dark": "muted" },
        "text": { "light": "#000000", "dark": "#a4f4cf" },
        "border-width": 0,
        "radius": 0,
        "weight": "600",
        "size": 12,
        "inset": 8
      },
      "@line-grid": { "columns": [64, "1fr", 88], "columns-wide": [92, "1fr", 150], "gap": 12 },
      "@line-side": { "gap": 8 },
      "@cart-columns": { "gap": 24 }
    }
  },
  "labels": {
    "cart.heading": { "en": "Your Cart", "bn": "আপনার কার্ট" },
    "cart.intro": { "en": "Review your items before checkout.", "bn": "চেকআউটের আগে পণ্যগুলো দেখে নিন।" },
    "cart.summaryHeading": { "en": "Order Summary", "bn": "অর্ডারের সারাংশ" },
    "cart.empty": { "en": "Your cart is empty.", "bn": "আপনার কার্ট খালি।" },
    "cart.emptyText": { "en": "Add a product from the store to see it here.", "bn": "এখানে দেখতে স্টোর থেকে একটি পণ্য যোগ করুন।" },
    "cart.continue": "continue-shopping",
    "dialog.goBack": "go-back",
    "dialog.confirm": "continue-checkout",
    "drawer.checkout": "proceed-to-checkout"
  }
}
```

## The rendered gate

What the save proves is checked again by drawing. `pnpm test:private-pages` (in the Scalius repository) compiles each theme with the store's compiler and draws the real cart page in headless Chromium on a fixture store that delivers (Place order is on), with an app block of every node kind and tone in the summary, below the cart, under a line and inside the details form. Each document is a legal theme, or a named break the save must refuse; a refused document is not drawn. A seed draws a look the save takes: a draft the save refuses gives way to the seed's next draft (up to eight, the same ones every run), the refused drafts are counted and printed, and a seed with no draft taken fails the gate, so every seed is drawn.

**What it draws.** The reviews' named cases and seeded legal themes, each in its states (the base cart; a line asking for a decision, a store kit as one line with an add-on once per kit and an app's offer row under it, and a sold-out line; an empty cart; long Bangla titles; an Arabic right-to-left presence; field errors showing; the sign-in and confirmation dialogs open). Seeds carry colours per scheme, `controls`, every variant, label and style target, `leading`, `mono`, and every app node kind, the toned stack, mark, link and key-value included. Besides them:

- an app's block on a line and in the summary, and an add-on row, each holding a 120-letter English word and a Bangla one;
- a store that asks for its terms to be ticked: the required box and its words on a details form coloured per scheme;
- lines, summary and details in one `columns` with twenty empty groups beside them: refused at save, or drawn with every part at its floor;
- the default look and the customer's look with one, twenty and ninety-nine lines on a 390×700 phone, a 768×1024 tablet and a 1280×800 laptop;
- the customer's cart (the reference above), offered and protected, at 390 and 1280, light and dark, and its protected cart in the drawer with the add-on row open;
- the store's controls in its header, in the strip at the page's end and nowhere, in a store with the light or dark switch and two markets;
- a stored document forged past the save (a stylesheet, the theme's chrome and search, content blocks in the page and a line): the store reads it with all of them dropped and its private pages' compile refused, so the theme stays (its light or dark switch is drawn) and its cart draws the default look with none of them;
- the payment step, drawn as the editor's sample checkout draws it for buyers: a look in palette roles with its methods as a list, the same with a narrow frame and tiles, and a forged stylesheet, at 320, 390 and 1280 px, light and dark. It fails when Pay or the total is not drawn, is off screen when scrolled to or is covered; when Pay is smaller, lighter or fainter than the gift card's Apply, its words read under 4.5:1 on its fill, or it is not found on its card (its fill under 3:1 on what is behind it, with no edge that finds it, as Place order below); when the total is smaller than another money row or reads under 4.5:1; or when the payment provider's surface is painted other than the store paints it. Four mutations prove these fail: Pay hidden, the total hidden, Pay weaker than Apply, token mode reaching into the provider's surface;
- a yellow Place order, Confirm and Pay whose fill reads under 3:1, framed by a 2px #111111 edge, on a white dock, dialog and card;
- named breaks the save must refuse, each with its reason (a stylesheet or blocks, `not_available`; words that do not read, in either scheme; a total smaller, lighter or fainter than its rows, or under its label, `prominence`; Place order or Confirm with no fill that shows, or smaller and lighter than its neighbour; Go back filled; a borderless field or stepper the colour of its box; Place order framed by a dark edge around the dock's own colour, or Place order or Pay framed by a 1px edge): a refused document is not drawn.

**Where each state is drawn** (by cost: each draw loads the page and photographs it screen by screen):

| State | Widths and schemes | Checks beyond the walk, contrast, whole text and clicks |
| --- | --- | --- |
| The base cart | 320, 390 and 1280, each light and dark | Tab order and focus rings at 390 light, 390 dark and 1280 dark; hover at 1280 dark; field errors and the sign-in dialog at 390 light and 1280 dark |
| A line asking for a decision, a kit and an offer row | 390 dark, 1280 light | the confirmation dialog in both |
| Place order asking for the decision | 390 light, 1280 dark | the confirmation dialog in both |
| One, twenty and ninety-nine lines | 390×700 light, 768×1024 dark, 1280×800 light | none |
| The customer's cart, offered or protected | 390 and 1280, each light and dark | its own checks in all four; focus rings at 390 light and 1280 dark; hover at 1280 dark |
| Every other state (empty, Bangla, Arabic, 120-letter words) | 320 light, 1280 dark | none |
| The drawer | 390 light, 1280 dark | none |

In every draw: the first screen, the store's controls, prominence, apps and add-ons fit, and floors; with lines, Place order docked and depth; under 1280px with lines, touch and Place order docked again with the fold open. A seed draws the base cart and one other state, its seed's turn. Under a scheme the store fixes (`light` or `dark`), both rows of a width draw that scheme.

**What fails it.**

| Check | Fails when |
| --- | --- |
| Mandatory parts | One is missing, under 8px, outside the viewport or covered at its centre; the page scrolls sideways. |
| The store's controls | The light or dark switch or a market or language form is drawn anywhere but where `controls` puts it. |
| Nothing of the theme's | Any `[data-free]` region, or a forged document's words or CSS, reaches the page. |
| Scheme | The page draws a colour scheme the store does not show. |
| Coverage walk | In token mode, a text or a focusable control belongs to no row of the colour table (its words are none of its row's resolved colours, its row's element paints something other than the row's paint, a surface the table does not know lies between it and its row, or an element a style target names is drawn by another row), with every add-on row opened; with no tokens, it stands on no surface the anatomy names, or the page shows a paint of its own. |
| Contrast | Any text reads under 4.5:1 (3:1 large) against its worst pixel behind it, with no budget (every text hidden, the page photographed; its line boxes each inset 1px). A field's value or placeholder is read at its 5th-percentile pixel less 0.05: its box is the field's padding box, which holds the field's own ring and edge. A control's words under the pointer are read at their worst pixel too. |
| Whole text | A text is cut off at the side, a glyph is cut by its box, or a word breaks inside itself where it would fit whole on a line of its box (a word wider than its box may only break). |
| Controls | A click at a control's centre lands elsewhere; Tab does not reach it, or reaches it out of document order; its focus ring changes under three quarters of its perimeter at 3:1. |
| Hover | Under the pointer, a control's words read under their floor at their worst pixel, or a control the store gives a hover surface changes under a quarter of its box. |
| Apps and add-ons fit | A word under an app's block runs out of the block (a space hanging at a line's end aside), or an add-on row's title runs out of its bar or lies over its amount. |
| Floors | The lines, the summary or the details form is drawn more than 8px narrower than a page track's floor (20rem) or the cart's own width where that is less. |
| Prominence | The total is drawn smaller than another summary row, its amount smaller than its label, lighter than a row's word, or reading fainter on what is behind it than a row's word (an add-on's app lines aside). |
| Finding actions and fields | Under a theme's tokens: Place order or Confirm is not found on what is behind it: its fill reads under 3:1 there, and it draws no edge that finds it (every side a solid border of at least 1.95px computed, reading 2.95:1 on what is behind it, over a fill at least 40 from it in CIE76); Place order is smaller or lighter than another filled button on the page; Go back paints a fill of its own; Confirm is smaller or lighter than Go back; a field, the stepper, the fold's bar or Go back shows its border under 3:1 on what is behind it, or, drawing none, its own fill. |
| Place order | At scroll 0 and at three places down the cart, Place order or its total is off screen, does not take a click there, or shows no total; on a phone, with the cart's fold closed and again with it open. |
| First screen | At scroll 0, none of the page's lead parts starts inside the screen. |
| Depth | What the theme adds above Place order (its place under the theme less its place under the default look, same cart, the fold open) is over 3200px and 448px a line, or either place cannot be measured. |
| Touch | On a phone, swiping from the top does not reach the end of the details form, Place order's own place (never its docked bar, on screen from the start). |
| The customer's cart | The offer row's mark, sentence, price and Add Now are not in one band at 1280 or take more than two at 390; a status box does not paint its tone's surface; the add-on row does not open to its three lines in order, or its amount shows more than once. |
| Server | Any request answers 5xx. |

**How to run it.**

| Run | Command |
| --- | --- |
| The gate (named cases and the fast seed set) | `pnpm test:private-pages` |
| A longer run | `pnpm test:private-pages --seeds 30 --from 100` (`--no-named` for seeds only, `--all-states` for every state of each) |
| One seed or case | `--seed 7`, `--case "B4"` (a failing seed prints its document) |
| The gate's own test | `pnpm test:private-pages --mutations`: the cases the mutations name draw clean unmutated first, in the same run; then every known-bad change of the store's code, as the test gallery serves it, must fail the check it names (52 today: among them a colour checked in one scheme only, rows inside an app's box checked on the target, the add-on bar without its row, prominence off, the total ranked by size only, a filled button's fill unchecked, an edge read by a border it does not draw, Go back filled, and the switch drawn under `controls: none`) |

The gate checks the cart page with the fixture store's data, not every store's data.

## Anatomy reference

The contract a test pins: a renamed or removed part, hook or label fails the store's build. Each page's root carries `data-private`, each part's elements `data-part`, each host layout `data-layout` (with your hook on `data-hook`). Money rows carry `data-summary-row` (`subtotal`, `add-on`, `delivery`, `discount`, `tax`, `total`) on every surface, and `items` where the summary starts with that row. An app's block is drawn in a wrapper with `data-buyer-ui-app` inside its target's `data-buyer-ui-target`, and each of its nodes carries its kind on `data-ui` and its tone on `data-tone`. These hooks are for reading the page and for tests: you reach the store's parts and the apps' blocks only through tokens. A `style` line is a style target: the selector the store writes it at (`<root>` is the page's `data-private` root), the tokens it takes, `fields` where it holds fields, `targets` the apps' targets it draws inside itself, `outside-when` the variants that stand it on what its part stands on, and `outranks` the rows it is never drawn smaller than.

```text
cart root data-private=cart frames=standard|narrow
cart part progress hooks=progress
cart part notices mandatory hooks=notice
cart part lines mandatory variants=heading-inside|heading-above hooks=lines,lines-header,lines-heading,lines-intro,lines-continue,lines-loading,lines-list,lines-clear,lines-undo,cart-empty,cart-empty-icon
cart part summary mandatory variants=totals|with-items hooks=summary,summary-heading,summary-validation,summary-total-label,add-on-details,add-on-detail
cart part discount hooks=discount
cart part details mandatory hooks=details,details-sign-in,details-form,contact,delivery,field-label,details-errors,dock,details-submit,legal
cart part empty hooks=empty-extras
cart fields in discount,details
cart target cart.page.summary
cart target cart.page.below
cart order notices before details
cart lead lines,summary,details
cart layouts stack,columns,grid,group,fold
cart layout fold hooks=fold-toggle,fold-body
cart layout fold holds=lines,summary,discount,cart.page.summary
cart style page body[data-private-body] tokens=background,gradient,text,muted,link,error
cart style frame <root> <root> tokens=max-width
cart style action :is([data-private="cart"],[data-private="dialog"]) .bg-primary:not([data-private="cart"] [data-part="details-submit"],[data-private="dialog"] [data-part="dialog-confirm"]) tokens=background,gradient,text,border,border-width,border-style,radius,shadow,ring,inset,font,weight,size,case,tracking
cart style input :is([data-private="cart"],[data-private="dialog"]) :is(input:not([type="checkbox"],[type="radio"],[type="hidden"]):not([data-field] *),select:not([data-field] *),textarea:not([data-field] *),[data-field]) tokens=background,text,placeholder,border,ring,invalid,border-width,radius
cart style field-label :is([data-private="cart"],[data-private="dialog"]) [data-part="field-label"] tokens=text,size,weight,case,tracking
cart style notice <root> [data-part="notice"] tokens=background,text,muted,link,error,border,border-width,radius
cart style lines <root> [data-part="lines"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding
cart style lines-heading <root> [data-part="lines-heading"] tokens=text,font,weight,size,leading,case,tracking outside-when=heading-above
cart style lines-intro <root> [data-part="lines-intro"] tokens=text,size,weight,leading outside-when=heading-above
cart style cart-empty <root> [data-part="cart-empty"] tokens=text,muted
cart style line <root> [data-part="line"] tokens=background,border,border-width,border-style,radius,padding
cart style line-image <root> [data-part="line-image"] tokens=width,height,width-wide,height-wide,radius,background,border,border-width,border-style,fit
cart style line-title <root> [data-part="line-title"] tokens=text,font,weight,size,leading,case,tracking,clamp
cart style line-details <root> [data-part="line-details"] tokens=text,size
cart style line-chip <root> [data-part="line-chip"] tokens=background,text,border,border-width,radius
cart style line-price <root> [data-part="line-price"] tokens=text,muted,font,weight,size,align
cart style line-quantity <root> [data-part="line-quantity"] tokens=background,text,border,border-width,border-style,radius,ring boundary=edge
cart style line-remove <root> [data-part="line-remove"] tokens=text,size,weight,radius,ring
cart style fold-toggle <root> [data-part="fold-toggle"] tokens=background,text,border,border-width,radius,shadow,ring boundary=edge
cart style summary <root> [data-part="summary"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding,gap
cart style summary-heading <root> [data-part="summary-heading"] tokens=text,font,weight,size,leading,case,tracking
cart style summary-rows <root> [data-summary-row]:not([data-summary-row="total"]) tokens=text,size
cart style summary-total <root> [data-summary-row="total"] tokens=text,font,weight,size,leading,case,tracking outranks=summary-rows:size+weight+contrast,summary-add-on-detail:size,summary-total-label:size,line-price:size,ui/cart.page.summary:size
cart style summary-total-label <root> [data-summary-row="total"] [data-part="summary-total-label"] tokens=text,font,weight,size,leading,case,tracking outranks=summary-rows:size
cart style summary-add-on <root> [data-part="add-on-details"] > summary tokens=text,ring,radius
cart style summary-add-on-detail <root> [data-part="add-on-details"] [data-part="add-on-detail"] tokens=background,text,muted,border,border-width,radius,padding,font,size
cart style details-form <root> [data-part="details-form"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding targets=checkout.contact.after,checkout.delivery.after
cart style section-heading <root> :is([data-part="contact"],[data-part="delivery"]) h2 tokens=text,font,weight,size,leading,case,tracking
cart style dock [data-private="cart"] [data-part="dock"] tokens=background,text,muted,link,error,border,border-width,shadow
cart style submit <root> [data-part="details-submit"] tokens=background,gradient,text,border,border-width,border-style,radius,shadow,ring,inset,font,weight,size,case,tracking boundary=fill outranks=action:size+weight
cart style legal <root> [data-part="legal"] tokens=text,size,align
cart style dialog [data-private="dialog"] tokens=background,text,muted,link,error,border,border-width,radius,shadow fields
cart style dialog-title [data-private="dialog"] [data-part="dialog-title"] tokens=text,font,weight,size,leading,case,tracking
cart style dialog-text [data-private="dialog"] [data-part="dialog-text"] tokens=background,text,muted,border,border-width,radius,padding
cart style dialog-agree [data-private="dialog"] [data-part="dialog-agree"] tokens=background,text,border,border-width,radius,padding
cart style dialog-back [data-private="dialog"] [data-part="dialog-back"] tokens=text,border,border-width,radius,ring,inset,weight boundary=edge
cart style dialog-confirm [data-private="dialog"] [data-part="dialog-confirm"] tokens=background,gradient,text,border,border-width,border-style,radius,shadow,ring,inset,font,weight,size,case,tracking boundary=fill outranks=dialog-back:size+weight
cart style chrome :is([data-private="core-header"],[data-private="core-footer"]) tokens=background,gradient,text,muted,link,border,border-width
cart style scheme [data-host="scheme"] button tokens=text,ring,radius
cart style localization [data-host="localization"] tokens=text,muted,link fields
cart.line root data-part=line
cart.line part image hooks=line-image
cart.line part title mandatory hooks=line-title
cart.line part details mandatory variants=lines|values|chips hooks=line-details,line-chip
cart.line part inputs mandatory hooks=line-inputs,field-label
cart.line part quantity mandatory hooks=line-quantity
cart.line part price mandatory hooks=line-price
cart.line part remove mandatory variants=icon|words hooks=line-remove
cart.line part limit mandatory hooks=line-limit
cart.line part issue mandatory hooks=line-issue
cart.line part rule mandatory hooks=line-rule
cart.line fields in inputs
cart.line target cart.line.after
cart.line layouts stack,columns,grid,group
cart label cart.heading max=60 no-figures
cart label cart.intro max=200
cart label cart.summaryHeading max=40 no-figures
cart label cart.continue variants=continue-shopping|keep-shopping|back-to-store
cart label cart.empty max=80 no-figures
cart label cart.emptyText max=200
cart label cart.subtotal variants=subtotal|items-total
cart label cart.showSummary variants=show-summary|show-cart
cart label cart.hideSummary variants=hide-summary|hide-cart
cart label dialog.goBack variants=go-back|cancel
cart label dialog.confirm variants=confirm|continue-checkout|agree-and-continue
cart icon cart.empty
cartDrawer root data-private=cart-drawer frames=standard|wide
cartDrawer part header mandatory hooks=drawer-header,drawer-title,drawer-count,drawer-close
cartDrawer part added hooks=drawer-added
cartDrawer part lines mandatory hooks=drawer-lines,drawer-empty,drawer-empty-icon
cartDrawer part recommendations hooks=drawer-recommendations
cartDrawer part undo mandatory hooks=drawer-undo
cartDrawer part offers hooks=drawer-offers
cartDrawer part summary mandatory hooks=drawer-summary,drawer-total,drawer-blocked,add-on-details,add-on-detail
cartDrawer part actions mandatory hooks=drawer-checkout,drawer-actions,drawer-view-cart,drawer-continue
cartDrawer target cart_drawer.footer
cartDrawer layouts stack,columns,grid,group,scroll
cartDrawer layout scroll hooks=drawer-scroll
cartDrawer layout scroll holds=added,lines,recommendations,undo,offers
cartDrawer.line root data-part=line
cartDrawer.line part image hooks=line-image
cartDrawer.line part title mandatory hooks=line-title
cartDrawer.line part details mandatory hooks=line-details
cartDrawer.line part inputs mandatory hooks=line-inputs
cartDrawer.line part quantity mandatory hooks=line-quantity
cartDrawer.line part price mandatory hooks=line-price
cartDrawer.line part remove mandatory hooks=line-remove
cartDrawer.line part limit mandatory hooks=line-limit
cartDrawer.line part issue mandatory hooks=line-issue
cartDrawer.line part rule mandatory hooks=line-rule
cartDrawer.line fields in inputs
cartDrawer.line target cart.line.after
cartDrawer.line layouts stack,columns,grid,group
cartDrawer label drawer.title max=40 no-figures
cartDrawer label drawer.checkout variants=checkout|proceed-to-checkout
cartDrawer label drawer.viewCart variants=view-cart|go-to-cart
cartDrawer label drawer.continue variants=continue-shopping|keep-shopping
cartDrawer label drawer.empty max=80 no-figures
cartDrawer label drawer.startShopping variants=start-shopping|browse-products|continue-shopping
cartDrawer icon drawer.empty
checkout root data-private=checkout frames=standard|narrow
checkout part progress hooks=progress
checkout part empty mandatory hooks=checkout-empty
checkout part summary mandatory variants=open-wide|folded hooks=summary,fold-toggle,summary-panel,summary-heading,summary-total-label,add-on-details,add-on-detail
checkout part heading mandatory hooks=heading
checkout part notices mandatory hooks=notice
checkout part gift-card mandatory hooks=gift-card
checkout part payment mandatory variants=list|tiles hooks=payment,payment-method,payment-details,gateway,pay,legal
checkout fields in gift-card
checkout target checkout.payment.after
checkout target checkout.actions.before
checkout order notices before payment
checkout lead summary,payment
checkout layouts stack,columns,grid,group
checkout style page body[data-private-body] tokens=background,gradient,text,muted,link,error
checkout style frame <root> <root> tokens=max-width
checkout style action [data-private="checkout"] .bg-primary:not([data-private="checkout"] [data-part="pay"]) tokens=background,gradient,text,border,border-width,border-style,radius,shadow,ring,inset,font,weight,size,case,tracking
checkout style input [data-private="checkout"] :is(input:not([type="checkbox"],[type="radio"],[type="hidden"]):not([data-field] *),select:not([data-field] *),textarea:not([data-field] *),[data-field]) tokens=background,text,placeholder,border,ring,invalid,border-width,radius
checkout style field-label [data-private="checkout"] [data-part="field-label"] tokens=text,size,weight,case,tracking
checkout style notice <root> [data-part="notice"] tokens=background,text,muted,link,error,border,border-width,radius
checkout style checkout-empty <root> [data-part="checkout-empty"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding
checkout style heading <root> [data-part="heading"] tokens=text,font,weight,size,leading,case,tracking
checkout style summary <root> [data-part="summary"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding,gap targets=checkout.summary.after
checkout style summary-heading <root> [data-part="summary-heading"] tokens=text,font,weight,size,leading,case,tracking
checkout style summary-rows <root> [data-summary-row]:not(:is([data-summary-row="total"],[data-summary-row="due"])) tokens=text,size
checkout style summary-total <root> :is([data-summary-row="total"],[data-summary-row="due"]) tokens=text,font,weight,size,leading,case,tracking outranks=summary-rows:size+weight+contrast,summary-add-on-detail:size,summary-total-label:size,ui/checkout.summary.after:size
checkout style summary-total-label <root> :is([data-summary-row="total"],[data-summary-row="due"]) [data-part="summary-total-label"] tokens=text,font,weight,size,leading,case,tracking outranks=summary-rows:size
checkout style summary-add-on <root> [data-part="add-on-details"] > summary tokens=text,ring,radius
checkout style summary-add-on-detail <root> [data-part="add-on-details"] [data-part="add-on-detail"] tokens=background,text,muted,border,border-width,radius,padding,font,size
checkout style fold-toggle <root> [data-part="fold-toggle"] tokens=background,text,border,border-width,radius,shadow,ring boundary=edge
checkout style gift-card <root> [data-part="gift-card"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding
checkout style payment-method <root> [data-part="payment-method"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding
checkout style payment-chosen <root> [data-part="payment-method"][data-chosen] tokens=background,text,muted,border,border-width,shadow
checkout style payment-details <root> [data-part="payment-details"] tokens=background,text,muted,link,error,border,border-width,radius,padding outside-when=tiles
checkout style submit <root> [data-part="pay"] tokens=background,gradient,text,border,border-width,border-style,radius,shadow,ring,inset,font,weight,size,case,tracking boundary=fill outranks=action:size+weight
checkout style legal <root> [data-part="legal"] tokens=text,size,align
checkout style chrome :is([data-private="core-header"],[data-private="core-footer"]) tokens=background,gradient,text,muted,link,border,border-width
checkout style scheme [data-host="scheme"] button tokens=text,ring,radius
checkout style localization [data-host="localization"] tokens=text,muted,link fields
receipt root data-private=receipt frames=standard|wide
receipt part progress hooks=progress
receipt part status mandatory hooks=status,status-mark,status-title,status-message,status-steps,status-retry
receipt part tracking mandatory hooks=tracking
receipt part summary mandatory hooks=order,order-facts,order-number,status-badge,summary,summary-heading,summary-total-label,add-on-details,add-on-detail
receipt part delivery mandatory hooks=delivery,section-heading,delivery-contact
receipt part lines mandatory hooks=lines,lines-heading,line,line-image,line-title,line-details,line-price,line-extras
receipt part actions mandatory hooks=actions
receipt part conversation mandatory hooks=conversation
receipt part recommendations hooks=recommendations
receipt fields in actions,conversation
receipt target order.confirmation
receipt target account.order
receipt lead status,summary
receipt layouts stack,columns,grid,group
receipt style page body[data-private-body] tokens=background,gradient,text,muted,link,error
receipt style frame <root> <root> tokens=max-width
receipt style action :is([data-private="receipt"],[data-private="dialog"]) .bg-primary:not([data-part="recommendations"] *):not([data-private="dialog"] [data-part="dialog-confirm"]) tokens=background,gradient,text,border,border-width,border-style,radius,shadow,ring,inset,font,weight,size,case,tracking
receipt style input :is([data-private="receipt"],[data-private="dialog"]) :is(input:not([type="checkbox"],[type="radio"],[type="hidden"]):not([data-field] *),select:not([data-field] *),textarea:not([data-field] *),[data-field]) tokens=background,text,placeholder,border,ring,invalid,border-width,radius
receipt style field-label :is([data-private="receipt"],[data-private="dialog"]) [data-part="field-label"] tokens=text,size,weight,case,tracking
receipt style status <root> [data-part="status"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding
receipt style status-mark <root> [data-part="status-mark"] tokens=background,text,border,border-width,radius
receipt style status-title <root> [data-part="status-title"] tokens=text,font,weight,size,leading,case,tracking
receipt style status-message <root> [data-part="status-message"] tokens=text,size,weight,leading
receipt style status-steps <root> [data-part="status-steps"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding
receipt style tracking <root> [data-part="tracking"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding
receipt style order <root> [data-part="order"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding
receipt style order-facts <root> [data-part="order-facts"] tokens=text,muted,size
receipt style status-badge <root> [data-part="status-badge"] tokens=background,text,border,border-width,radius
receipt style summary <root> [data-part="summary"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding,gap
receipt style summary-heading <root> [data-part="summary-heading"] tokens=text,font,weight,size,leading,case,tracking
receipt style summary-rows <root> [data-summary-row]:not([data-summary-row="total"]) tokens=text,size
receipt style summary-total <root> [data-summary-row="total"] tokens=text,font,weight,size,leading,case,tracking outranks=summary-rows:size+weight+contrast,summary-add-on-detail:size,summary-total-label:size,line-price:size
receipt style summary-total-label <root> [data-summary-row="total"] [data-part="summary-total-label"] tokens=text,font,weight,size,leading,case,tracking outranks=summary-rows:size
receipt style summary-add-on <root> [data-part="add-on-details"] > summary tokens=text,ring,radius
receipt style summary-add-on-detail <root> [data-part="add-on-details"] [data-part="add-on-detail"] tokens=background,text,muted,border,border-width,radius,padding,font,size
receipt style delivery <root> [data-part="delivery"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding
receipt style section-heading <root> [data-part="section-heading"] tokens=text,font,weight,size,leading,case,tracking
receipt style delivery-contact <root> [data-part="delivery-contact"] tokens=text,muted,size
receipt style lines <root> [data-part="lines"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding
receipt style lines-heading <root> [data-part="lines-heading"] tokens=text,font,weight,size,leading,case,tracking
receipt style line <root> [data-part="line"] tokens=background,border,border-width,border-style,radius,padding targets=order.line.after
receipt style line-image <root> [data-part="line-image"] tokens=width,height,width-wide,height-wide,radius,background,border,border-width,border-style
receipt style line-title <root> [data-part="line-title"] tokens=text,font,weight,size,leading,case,tracking
receipt style line-details <root> [data-part="line-details"] tokens=text,size
receipt style line-price <root> [data-part="line-price"] tokens=text,muted,font,weight,size,align
receipt style conversation <root> [data-part="conversation"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding fields
receipt style dialog [data-private="dialog"] tokens=background,text,muted,link,error,border,border-width,radius,shadow fields
receipt style dialog-title [data-private="dialog"] [data-part="dialog-title"] tokens=text,font,weight,size,leading,case,tracking
receipt style dialog-text [data-private="dialog"] [data-part="dialog-text"] tokens=background,text,muted,border,border-width,radius,padding
receipt style dialog-agree [data-private="dialog"] [data-part="dialog-agree"] tokens=background,text,border,border-width,radius,padding
receipt style dialog-back [data-private="dialog"] [data-part="dialog-back"] tokens=text,border,border-width,radius,ring,inset,weight boundary=edge
receipt style dialog-confirm [data-private="dialog"] [data-part="dialog-confirm"] tokens=background,gradient,text,border,border-width,border-style,radius,shadow,ring,inset,font,weight,size,case,tracking boundary=fill outranks=dialog-back:size+weight
account root data-private=account
account part navigation mandatory variants=tabs|sidebar hooks=navigation,nav-item,nav-badge,sign-out
account part heading mandatory hooks=heading,heading-title,heading-intro,heading-back
account part content mandatory hooks=content,card,card-title,status-badge,summary,summary-total-label,add-on-details,add-on-detail,line,line-image,line-title,line-details,line-price,delivery-message,delivery-reveal
account fields in content
account lead heading,content
account layouts stack,columns,grid,group
account style page body[data-private-body] tokens=background,gradient,text,muted,link,error
account style frame <root> <root> tokens=max-width
account style action :is([data-private="account"],[data-private="dialog"]) .bg-primary:not([data-private="dialog"] [data-part="dialog-confirm"]) tokens=background,gradient,text,border,border-width,border-style,radius,shadow,ring,inset,font,weight,size,case,tracking
account style input :is([data-private="account"],[data-private="dialog"]) :is(input:not([type="checkbox"],[type="radio"],[type="hidden"]):not([data-field] *),select:not([data-field] *),textarea:not([data-field] *),[data-field]) tokens=background,text,placeholder,border,ring,invalid,border-width,radius
account style field-label :is([data-private="account"],[data-private="dialog"]) [data-part="field-label"] tokens=text,size,weight,case,tracking
account style navigation <root> [data-part="navigation"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding
account style nav-item <root> [data-part="nav-item"]:not([aria-current="page"]) tokens=text,size,weight,radius,ring
account style nav-current <root> [data-part="nav-item"][aria-current="page"] tokens=text,link,size,weight,radius,ring
account style sign-out <root> [data-part="sign-out"] tokens=background,text,border,border-width,radius,ring,inset,weight,size boundary=edge
account style heading-title <root> [data-part="heading-title"] tokens=text,font,weight,size,leading,case,tracking
account style heading-intro <root> [data-part="heading-intro"] tokens=text,size,weight,leading
account style heading-back <root> [data-part="heading-back"] tokens=text,radius,ring
account style content <root> [data-part="content"] tokens= targets=account.overview,account.order,account.profile
account style card <root> [data-part="card"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding,gap fields
account style card-title <root> [data-part="card-title"] tokens=text,font,weight,size,leading,case,tracking
account style status-badge <root> [data-part="status-badge"] tokens=background,text,border,border-width,radius
account style summary <root> [data-part="summary"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding,gap
account style summary-heading <root> [data-part="summary-heading"] tokens=text,font,weight,size,leading,case,tracking
account style summary-rows <root> [data-summary-row]:not(:is([data-summary-row="total"],[data-summary-row="due"])) tokens=text,size
account style summary-total <root> :is([data-summary-row="total"],[data-summary-row="due"]) tokens=text,font,weight,size,leading,case,tracking outranks=summary-rows:size+weight+contrast,summary-add-on-detail:size,summary-total-label:size,line-price:size
account style summary-total-label <root> :is([data-summary-row="total"],[data-summary-row="due"]) [data-part="summary-total-label"] tokens=text,font,weight,size,leading,case,tracking outranks=summary-rows:size
account style summary-add-on <root> [data-part="add-on-details"] > summary tokens=text,ring,radius
account style summary-add-on-detail <root> [data-part="add-on-details"] [data-part="add-on-detail"] tokens=background,text,muted,border,border-width,radius,padding,font,size
account style line <root> [data-part="line"] tokens=background,border,border-width,border-style,radius,padding targets=order.line.after
account style line-image <root> [data-part="line-image"] tokens=width,height,width-wide,height-wide,radius,background,border,border-width,border-style,fit
account style line-title <root> [data-part="line-title"] tokens=text,font,weight,size,leading,case,tracking
account style line-details <root> [data-part="line-details"] tokens=text,size
account style line-price <root> [data-part="line-price"] tokens=text,muted,font,weight,size,align
account style delivery-message <root> [data-part="delivery-message"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding
account style delivery-reveal <root> [data-part="delivery-reveal"] tokens=background,gradient,text,border,border-width,border-style,radius,shadow,ring,inset,font,weight,size,case,tracking boundary=edge
account style dialog [data-private="dialog"] tokens=background,text,muted,link,error,border,border-width,radius,shadow fields
account style dialog-title [data-private="dialog"] [data-part="dialog-title"] tokens=text,font,weight,size,leading,case,tracking
account style dialog-text [data-private="dialog"] [data-part="dialog-text"] tokens=background,text,muted,border,border-width,radius,padding
account style dialog-agree [data-private="dialog"] [data-part="dialog-agree"] tokens=background,text,border,border-width,radius,padding
account style dialog-back [data-private="dialog"] [data-part="dialog-back"] tokens=text,border,border-width,radius,ring,inset,weight boundary=edge
account style dialog-confirm [data-private="dialog"] [data-part="dialog-confirm"] tokens=background,gradient,text,border,border-width,border-style,radius,shadow,ring,inset,font,weight,size,case,tracking boundary=fill outranks=dialog-back:size+weight
dialog root data-private=dialog hooks=sign-in,dialog-title,dialog-text,dialog-agree,dialog-actions,dialog-back,dialog-confirm,field-label
buyer-ui attributes=data-buyer-ui-target,data-buyer-ui-app,data-ui
chrome roots data-private=core-header|core-footer controls=header|footer|none
layout tokens=background,gradient,border,border-width,border-style,radius,shadow,padding,gap,columns,columns-wide
buyer-ui style ui.banner[.neutral|info|success|warning|critical][@<app>][/<target>] [data-ui="banner"] tokens=background,text,border,border-width,radius,shadow,padding
buyer-ui style ui.stack[.neutral|info|success|warning|critical][@<app>][/<target>] [data-ui="stack"][data-tone] tokens=background,text,border,border-width,radius,shadow,padding,gap
buyer-ui style ui.button[.primary|secondary|critical][@<app>][/<target>] :is(a[data-ui="button"],[data-ui="button"]>button) tokens=background,text,border,border-width,radius,ring,inset,weight,size,case
buyer-ui style ui.badge[.neutral|info|success|warning|critical][@<app>][/<target>] [data-ui="badge"] tokens=background,text,border,radius,padding,inset,weight,size
buyer-ui style ui.mark[.neutral|info|success|warning|critical][@<app>][/<target>] [data-ui="mark"] tokens=text,border,size
buyer-ui style ui.text[.neutral|info|success|warning|critical][@<app>][/<target>] [data-ui="text"] tokens=text,font,size,weight,leading
buyer-ui style ui.heading[@<app>][/<target>] [data-ui="heading"] tokens=text,size,weight,font,case
buyer-ui style ui.link[@<app>][/<target>] a[data-ui="link"] tokens=text,size,weight
buyer-ui style ui.keyvalue[@<app>][/<target>] [data-ui="key-value"] tokens=text,muted,size,weight
buyer-ui style ui.disclosure[@<app>][/<target>] [data-ui="disclosure"] tokens=background,text,border,radius
buyer-ui style ui.row[@<app>][/<target>] :is([data-ui="stack"],[data-ui="columns"]) tokens=gap
```
