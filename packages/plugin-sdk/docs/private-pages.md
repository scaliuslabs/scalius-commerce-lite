# Design the buyer's private pages

The cart, checkout, payment, receipt and account pages are a buyer's own pages: they hold a cart, an address, a phone number and a code. No theme or app script runs there. You still design them, with data the store draws:

- you **arrange** the store's parts and your own content;
- you give the store's parts, and the apps' blocks the store draws, their **look through typed tokens** (colours, sizes, radii, fonts, columns);
- you style **your own regions** freely with one stylesheet: your content blocks and your header and footer;
- you **choose** the store's words for its actions and amounts, **reword** its headings and empty states, and swap its icons.

The store never lets a stylesheet select one of its parts. A rendered gate (`pnpm test:private-pages`, [below](#the-rendered-gate)) draws generated themes in a real browser and fails when anything a buyer must read or use is lost.

This page covers the cart page, which is private, and the cart drawer. The drawer opens over public pages and is part of each of them: its arrangement, words and icons come from here, and its look comes from your public stylesheet through the same hooks. No store check compiles that public stylesheet. The checkout, the receipt and the account follow the same model as they move to it; until then they take the closed choices in [themes.md](themes.md#templates).

## What you set

A template sets them under `privatePages`. The merchant's theme document holds the same object, so a merchant or an agent can edit it too.

| Field | What it is |
| --- | --- |
| `chrome` | `core` (the store's minimal checkout header) or `theme` (your header and footer skins, drawn without script). |
| `search` | With `chrome: theme`, where the store's search sits in the header: `before` or `after` your header's region. Leave it out for none. |
| `pages.cart`, `pages.cartDrawer` | An arrangement per page. Leave a page out to keep the store's own. |
| `tokens` | The look of the store's parts, per page and style target: `{ "cart": { "summary": { "background": "card", "radius": 0 } } }`. |
| `css` | Your stylesheet for your own regions, at most 24 KiB. |
| `labels` | The store's word you choose for an action or an amount (`{ "dialog.confirm": "continue-checkout" }`), your own words per language for a heading or an empty state (`{ "cart.heading": { "en": "Your Cart", "bn": "আপনার কার্ট" } }`). |
| `icons` | Your image for a store icon: `{ "cart.empty": { "app": "acme.studio", "file": "icons/bag.svg" } }` (a file in your `public/`). |
| `assets` | Files your stylesheet names, by key: `{ "paper": { "app": "acme.studio", "file": "images/paper.webp" } }`, at most 16. |

Every file (`assets`, `icons`, an image block) is one of your own theme's: `app` is the app your template comes from (`foreign_asset` otherwise).

The store checks all of it when the theme is saved or published, and stores the result. A refusal names its `reason` (below). A buyer's request never compiles anything. After a store update with a newer checker, a page shows the store's default look until the next save, or until the first maintenance run after the update compiles it again.

## Arrangements

An arrangement is `{ frame?, layout?, items? }`:

- `frame`: the page's closed variant. The cart page: `standard` or `narrow`. The drawer: `standard` (380px) or `wide` (440px).
- `layout`: the page as a tree of nodes. Leave it out to keep the store's layout.
- `items.line`: the layout of one cart line, repeated for every line.

A node is one of:

| Node | Shape | Draws |
| --- | --- | --- |
| Layout | `{ "type": "layout", "layout": "stack", "hook": "studio-side", "children": [...] }` | `stack` (one column), `columns` (side by side from 64rem on the page, 40rem in the drawer), `grid` (shape it in your CSS), `group` (a box), `fold` (cart only: on phones its children fold behind a bar that states the total), `scroll` (drawer only: the scrolling region). |
| Part | `{ "type": "part", "part": "summary" }` | One of the store's parts (anatomy below). |
| Target | `{ "type": "target", "target": "cart.page.summary" }` | Where apps draw their blocks. |
| Content | `{ "type": "content", "hook": "studio-lead", "content": { "kind": "text", "text": { "en": "…", "bn": "…" } } }` | Your words or picture. |

Content kinds: `heading` (`level` 2 or 3), `text` (`tone`), `link` (`href`: a path on the store), `image` (`image`: your file, `alt`, `width`, `height`), `banner` (`tone`, `title`, `text`), `disclosure` (`summary`, `text`: opens without script), `divider`. Words are plain text in each language you write; a page shows its language, then English.

A hook is lowercase words joined by hyphens (`studio-summary`). The store writes it as `data-hook="studio-summary"`.

### What must stay

Every arrangement holds each **mandatory** part and every target exactly once. You may leave out the **optional** parts. Reading order is your order at every width, so put what a buyer needs first in a sensible place: the page keeps one `h1` (the lines' heading) and your headings are `h2` or `h3`.

| Page | Mandatory | Optional |
| --- | --- | --- |
| Cart page | `notices`, `lines`, `summary`, `details` | `progress`, `discount`, `empty` |
| Cart line | `title`, `details`, `inputs`, `quantity`, `price`, `remove`, `limit`, `issue`, `rule` | `image` |
| Drawer | `header`, `lines`, `undo`, `summary`, `actions` | `added`, `recommendations`, `offers` |

The phone fold (`fold`) starts closed on phones, so it holds only `lines`, `summary`, `discount`, the `cart.page.summary` target and your own content (`layout_holds` otherwise).

When the store later makes another part mandatory, a saved arrangement without it shows it in its default place. A store upgrade never breaks your page.

Example: the summary and the form in a side column, a line of your own words under the notices, and a line card with the app's per-line block under the title.

```json
{
  "pages": {
    "cart": {
      "layout": [
        { "type": "part", "part": "notices" },
        { "type": "content", "hook": "studio-lead", "content": { "kind": "text", "text": { "en": "Review your items before checkout.", "bn": "চেকআউটের আগে দেখে নিন।" } } },
        { "type": "layout", "layout": "columns", "hook": "studio-grid", "children": [
          { "type": "layout", "layout": "stack", "children": [{ "type": "part", "part": "lines" }, { "type": "target", "target": "cart.page.below" }] },
          { "type": "layout", "layout": "stack", "hook": "studio-side", "children": [
            { "type": "part", "part": "summary" }, { "type": "target", "target": "cart.page.summary" }, { "type": "part", "part": "details" }
          ] }
        ] }
      ],
      "items": {
        "line": [
          { "type": "layout", "layout": "grid", "hook": "studio-line", "children": [
            { "type": "part", "part": "image" },
            { "type": "layout", "layout": "stack", "children": [
              { "type": "part", "part": "title" }, { "type": "target", "target": "cart.line.after" }, { "type": "part", "part": "details" }, { "type": "part", "part": "inputs" }
            ] },
            { "type": "layout", "layout": "stack", "children": [{ "type": "part", "part": "price" }, { "type": "part", "part": "quantity" }, { "type": "part", "part": "remove" }] }
          ] },
          { "type": "part", "part": "limit" }, { "type": "part", "part": "issue" }, { "type": "part", "part": "rule" }
        ]
      }
    }
  }
}
```

## Tokens

Each page names its **style targets**, the elements of its parts that take a look, and the tokens each one takes. You set values; the store writes every CSS rule from them. The anatomy reference below lists the targets as `style <name> <selector> tokens=…`.

**Token mode.** A page with any token is drawn in token mode, and so is the cart page of a theme with a page paint (`tokens.pagePaint`), tokens or not. Every colour a buyer reads there comes from one **colour table** the store resolves when you save:

- the table has a row for every style target at every place your arrangement puts it (each app node kind and tone at each of the page's targets and inside the details form, the store's dialogs, every filled button, a field row in every box that holds fields), for each palette a buyer can see (light, dark or both);
- a row holds a solid surface (or a gradient's points), the colour of the target's own words, its muted, link and error words, its border and focus ring, its hover surface (a step from the surface that its words still read on), and for a field its placeholder and error border;
- each is your token where you set one, else a default that reads on the surface beneath: a dark box gives its untouched children readable words, and a field keeps its own surface;
- the page itself stands on the theme's page paint (`tokens.pagePaint`, [themes](themes.md)) unless your `page` tokens give it a surface, so every row on the page, the store's defaults included, is checked along the whole paint;
- the store writes exactly those rows as CSS, and checks exactly those rows: **every text at 4.5:1** on its surface and on its row's hover surface, **a field's border and error border and every focus ring at 3:1** on the box around them (a field only on the boxes that hold fields). A gradient counts at every point;
- inside the page, the store's own palette classes read the nearest row: no translucent tint and no palette colour decides a colour there. The page is drawn from its arrangement (the store's default one if you set none), so the table's places are the page's.

A page with no token, in a theme with no page paint, is drawn exactly as the store draws it. The drawer takes no tokens (`unknown_style`): it opens over public pages and takes their look.

| Token | Value | Writes |
| --- | --- | --- |
| `background`, `gradient` | A palette role (`card`, `primary`, `muted-foreground`, …) or an opaque `#rrggbb`; a gradient is `{ "shape": "linear" \| "radial", "angle"?: 0–360, "from": colour, "to": colour }` | The row's surface |
| `text` | A colour | The target's own words (and plain words inside it) |
| `muted`, `link`, `error` | A colour | Its muted, link and error words |
| `border` | A colour | Its border (a field's at 3:1) |
| `ring` | A colour | The focus ring of what is inside it; a field's or a button's own |
| `placeholder`, `invalid` | A colour | A field's placeholder and error border |
| `border-width`, `radius` | Whole pixels: 0–4, 0–32 | Those properties |
| `padding`, `gap` | 0–48 px | Those, scaled down to 4% of the screen's width on a phone; a padding is never under 4px nor under 30% of the radius, so focus rings and rounded corners stay on the box's surface |
| `border-style` | `solid`, `dashed`, `dotted`, `none` | `border-style` |
| `shadow` | `none`, `sm`, `md`, `lg` | A fixed `box-shadow` |
| `font` | `body`, `heading` (the theme's typography) | `font-family` |
| `size` | 12–40 px | `font-size`, at most 7% of the box it sits in (a line, a layout node, else the screen; never under 12 px) |
| `weight`, `case`, `tracking`, `align` | `400`–`800`; `none`/`uppercase`; `normal`/`wide`/`wider`; `start`/`center`/`end` | Those properties |
| `clamp` | `none`, `2`, `3` (lines of a title) | A line clamp on the title's link (so its focus ring is never clipped) |
| `columns`, `columns-wide` | 1 to 4 tracks: `auto`, `min-content`, `1fr`–`4fr`, or 24–480 px | A layout node's columns, **only where the box holding it fits them** (`columns-wide` from 40rem); a share is at least 6rem and a pixel track may shrink; else the store's one column |
| `width`, `height`, `width-wide`, `height-wide` | 40–240 px (at most 30% of the screen), 40–320 px | An image's size |
| `fit` | `contain`, `cover` | The image's `object-fit` |
| `max-width` | 480–1600 px | The page frame's width |

A layout node takes `background`, `gradient`, `border`, `border-width`, `border-style`, `radius`, `shadow`, `padding`, `gap`, `columns` and `columns-wide` through its hook: `"@studio-grid": { "columns": [64, "1fr", 88] }`. A hook with a colour is a row of the table. The store's own layouts split into columns by the width of the box they sit in, never the screen's.

`action` is every filled button the store draws without a target of its own, `input` every field on the page and in its dialogs (one row per box that holds fields: the discount part, the details form, a line's inputs, a dialog, an app's target), `dialog` the store's dialogs (the confirmation an app's choice asks for, sign-in) with `dialog-back` and `dialog-confirm` their buttons, `chrome` the store's own header (`chrome: core`), and `search` the store's search in your header (see `search` above).

**Apps' blocks.** The store draws an app's block from typed nodes, so it is one of the store's parts: you give it a look by node kind, under `ui.<kind>`, narrowed by tone, app and target: `"ui.banner.warning@acme.protection/cart.page.summary": { "background": "#3a2a0a", "text": "#fde68a" }`. Every kind and tone has a row at each of the page's targets (`cart.page.summary`, `cart.page.below`, `cart.line.after`), on whatever that target sits on, whether you name it or not.

| Kind | Tokens |
| --- | --- |
| `ui.banner[.neutral\|info\|success\|warning\|critical]` | `background`, `text`, `border`, `border-width`, `radius`, `shadow`, `padding` |
| `ui.button` | `background`, `text`, `border`, `border-width`, `radius`, `ring`, `weight`, `size`, `case` |
| `ui.badge[.<tone>]` | `background`, `text`, `border`, `radius` |
| `ui.text`, `ui.heading` | `text`, `size`, `weight` (a heading also `font`, `case`) |
| `ui.disclosure` | `background`, `text`, `border`, `radius` |
| `ui.row` | `gap` |

No value is text CSS reads as code: no `var()`, no `calc()`, no `url()`, no font name. A refusal names the pair and the token that set it: `summary-rows: text #eeeeee on #ffffff is 1.16:1`.

| Reason | Means |
| --- | --- |
| `unknown_style` | No such style target, node kind, tone or target on the page, or no layout node with that hook. |
| `unknown_token` | The target does not take that token. |
| `token_value` | Not a value of the token's type, or outside its bounds. |
| `contrast` | A row of the table has words below 4.5:1, or a field's mark or a focus ring below 3:1. |

## Free regions and your stylesheet

Your stylesheet styles **free regions** only, and only what is inside them:

| Region | Its wrapper | Start a selector with |
| --- | --- | --- |
| One of your content blocks | `data-free="block"` with its `data-hook` | `[data-hook="studio-lead"] p` |
| Your header or footer | `data-free="header"`, `data-free="footer"` | `[data-free="header"] .logo` |
| Every region | `data-free` | `[data-free] a` |

A selector starts at one wrapper (written as just that attribute), then a space or `>`, then what it selects inside. A root state may come first: `:root[data-color-scheme="dark"] [data-free="header"] .logo`. The wrapper itself is the store's: you never select it, and a selector that starts anywhere else is refused (`unscoped_selector`). Nothing of the store's is ever inside a region: its search sits beside your header and takes the `search` tokens. Class names and ids are your region's own: `.logo` matches what your header skin wrote as `class="logo"` (both are written `tc-logo`), so they never meet a store or utility class.

Inside a region you may use what CSS offers for a design: layout, colour, gradients, transforms, absolute positioning, animations, pseudo-elements, `@media`, `@supports`, `@container` and `@keyframes`. The store **seals** every region, on every page that draws one and whatever your look holds (no stylesheet, tokens or paint included): it is its own containing block and stacking context; its layout and paint are contained and it is never wider than its column, so nothing inside widens the page or a column; what is painted inside is clipped to it; and its height is bounded (a content block 30rem, the header 24rem, the footer 80rem).

```css
[data-hook="cart-intro"] p { color: #b9b0d6; margin: 0 }
:root[data-color-scheme="dark"] [data-free="header"] .site-header { background: #120d22 }
[data-hook="cart-intro"] p::before { content: "★ "; animation: glow 2s ease-in infinite }
@keyframes glow { from { opacity: .4 } to { opacity: 1 } }
```

`url(<asset>)` names one of your listed `assets`, only as the direct value of a property that paints an image in its box (`background`, `background-image`, `border-image`, `border-image-source`, `list-style`, `list-style-image`, `mask`, `mask-image`, `content`): never in a custom property, inside a function or as a cursor, which takes no `var()`. The page loads it from the store's own origin. Your animations name only your own `@keyframes` (written `t-<name>`). Custom properties are named `--t-<name>`.

A page holds at most **8 content blocks**, at most **3 before its last part a buyer must reach** (the details form on the cart page), and at most 2 in a cart line (`content_limit`).

The stylesheet is parsed by a CSS Syntax 3 parser and written back from what was checked, never copied, then read back and compared: anything that disagrees serves nothing. It never throws: oversize, too many tokens and deep nesting are refusals too.

| Reason | Means |
| --- | --- |
| `unscoped_selector` | A selector does not start at a region's wrapper, selects the wrapper itself, leaves it by `~` or `+`, or climbs out of it: `:is()`, `:where()` and `:not()` take compound selectors only (no combinator), `:has()` looks only down (` ` or `>`, never `~` or `+`), and `html`, `body` and `:root` appear only first, as the page's scheme, language or direction (`:root[data-color-scheme="dark"] [data-free="header"] p`). |
| `positioning` | `position: fixed` or `sticky`, a position read from a variable, anchor positioning or a view transition name. |
| `animation_name` | An animation that names a keyframe that is not yours. |
| `import`, `foreign_url`, `forbidden_function` | `@import`, a `url()` that is not one of your assets or stands anywhere but an image property's value, a cursor read from `var()`, `image()`, `image-set()`, `cross-fade()`, `element()`, `attr()` and other functions not on the list. |
| `unknown_attribute`, `state_selector` | An attribute your region's markup never carries (`[value^=…]`, `[data-part…]`, `[data-host…]`; it may name `[data-ui]`, `[data-tone]`, `aria-*` and the other attributes the inert rebuild keeps), or a state that reads what a buyer does (`:placeholder-shown`, `:has(:checked)`). |
| `unsupported_selector`, `unsupported_at_rule`, `custom_property` | A selector, at-rule or custom property not on the lists, or `[class…]`, `[id…]` (use `.name`, `#name`). |
| `syntax`, `escape`, `bad_string`, `bad_url`, `comment`, `unbalanced`, `null_byte`, `nested_rule` | What a browser would repair: refused instead. |
| `too_large`, `too_deep`, `unsafe_output` | Over 24 KiB, 12000 tokens or 24 levels of nesting, or output that did not read back as checked. |

## What the store guarantees, and what is yours

| The store guarantees | Yours |
| --- | --- |
| No rule of your stylesheet matches a store part, an app's block, a layout node, the page, the body or the store's search. | Everything inside your regions: your words, your pictures, your header's markup. |
| A region is sealed: what it paints is clipped to it and its content does not widen the page; its height is bounded. | A region that clips its own content because you made it bigger than its bound. |
| A token is a typed value the store writes as its own CSS; in token mode every colour comes from the one table the save checks. | Choosing tokens that read well together beyond the floors. |
| Every row of the table reads at its floor: words at 4.5:1, a field's marks and focus rings at 3:1. | The drawer's look on public pages (your public stylesheet). |
| A buyer's request never compiles; a look an older checker wrote is not served. | Re-saving after a store update if you want your look before the next maintenance run. |

## The rendered gate

What the save proves is checked again by drawing. `pnpm test:private-pages` (`apps/storefront/test-support/private-pages.properties.browser.mjs`) compiles each theme with the store's compiler and draws the real cart page in headless Chromium on the fixture gallery: a store that delivers (Place order is on), two lines, and an app block of every node kind and tone in the summary, below the cart, under a line and inside the details form. CI runs it when a push reaches the storefront, the theme model, the apps' buyer UI or Noor.

**What it draws.** The reviews' named breaks, then seeded legal themes: the default arrangement (tokens only) and generated ones; tokens for every style target, `ui.<kind>` with tone, app and target; labels, icons, image, link, disclosure and divider blocks; gradients, every palette, light, dark and system schemes, the narrow frame; page paints with and without tokens; `chrome: theme` with Noor's real header skin (its region is drawn) and with no header skin (the store's checkout header is drawn). Each in its states: the base cart; a line asking for a decision, a store kit as one line with an add-on once per kit and an app's offer row under it, and a sold-out line; the decision asked from Place order with every field filled; an empty cart; long Bangla titles; an Arabic right-to-left presence; with field errors showing, the sign-in dialog open and the confirmation dialog open. At 320, 390 and 1280 px, light and dark.

**What fails it.**

| Check | Fails when |
| --- | --- |
| Mandatory parts | One (with `chrome: theme`, your header's region and the store's search too) is missing, under 8px, outside the viewport, more than 9000px down, or covered by a free region; the page scrolls sideways; a free region is not sealed, or holds an element or attribute the inert rebuild never writes (a form, a field, a submit button, a store control, an embed). |
| Coverage walk | A text or a focusable control belongs to no row of the colour table (token mode: its words are none of its row's colours, its row's element paints something other than the row's paint, the body included, a surface the table does not know lies between it and its row, or an app's node of a styled kind has no row of its own at its target), or, with no tokens, to no surface the anatomy names, or the page shows a paint of its own. |
| Contrast | Any text, with no budget, reads under 4.5:1 (3:1 large) against the pixels behind it (every text hidden, the page photographed). |
| Whole text | A text is cut off at the side, a glyph is cut by its box, or a word breaks inside itself. |
| Controls | A click at a control's centre lands elsewhere; Tab does not reach it, or reaches it out of document order; its focus ring changes under three quarters of its perimeter at 3:1. |
| Hover | Under the pointer (1280 px, dark), a control's words read under their floor, or a control the store gives a hover surface changes under a quarter of its box. |
| Touch | On a phone, swiping from the top does not reach Place order. |
| Server | Any request answers 5xx. |

**How to run it.**

| Run | Command |
| --- | --- |
| The gate (named cases and the fast seed set, about 4 minutes) | `pnpm test:private-pages` |
| A longer run | `pnpm test:private-pages --seeds 30 --from 100` (`--no-named` for seeds only, `--all-states` for every state of each) |
| One seed or case | `--seed 7`, `--case "B4"` (a failing seed prints its document) |
| The gate's own test | `pnpm test:private-pages --mutations`: every known-bad change in `private-pages.mutations.mjs` must fail it |

A mutation rewrites one source file as the test gallery serves it (never the store's code, never in production): each review's fix reverted, the region seal without clipping, the seal written only with a compiled look, the skin's slots drawing the store's controls inside its region, a stylesheet allowed to select a host part, the search inside the theme's region, a row's contrast skipped, the surface reset off, the store's header outside token mode, every row leaving out its parent's cells, a title's clamp on its heading, screen-sized text, unfitted columns, the page row off the page paint, a page paint with no tokens drawing the store's own page, a dark row leaving out a cell its light row writes, the theme's chrome with no header drawing the public header, the details form's app targets without rows, and no hover surface in token mode. Paint containment clips on its own, so the seal's overflow clip is a second guard (the mutation that drops clipping drops both). The seal no longer holds `contain: inline-size`: without it no case failed, and `min-inline-size: 0` with `max-inline-size: 100%` is what keeps a block from widening its column (dropping those fails the gate).

The gate checks the cart page with the fixture gallery's data, not every store's data.

## Words and icons

A label that names an action or an amount takes one of the store's **variants**, which the store words in each language it translates (English, Bangla), so "Go back" never confirms and a subtotal never reads as the total. A heading or an empty state takes **your own words**, per language.

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
| `cart.heading` | Cart page | Your words, at most 60 |
| `cart.empty`, `cart.emptyText` | Cart page, empty | Your words, at most 80, 200 |
| `drawer.title`, `drawer.empty` | Drawer | Your words, at most 40, 80 |

`label_variant` refuses a value that is not one of the label's variants (or words where a variant goes, or a variant where words go). Your words are plain text: `markup` refuses HTML and `label_too_long` refuses words over the bound. Icons: `cart.empty`, `drawer.empty`.

## Your header and footer

With `chrome: theme` the cart page draws your header and footer skins from the same projection as any page (with no header skin it draws the store's checkout header, with no footer skin no footer, as with `chrome: core`): the store's name, logo, menus and routes. The skin is told the page's root (`/cart`) and nothing more: never an order's or a claim's path, a session, an order or an address. What the skin draws is rebuilt, not copied, inside its sealed region:

- text, lists, links to this store's clean paths (no `//`, no dot segment) or to the region's own ids, images from the page's allowed origins (each URL judged as the browser reads it: a control character drops it, and it is resolved against the page), disclosure (`<details>`), tables and SVG drawing (no `url()` references);
- no script, island, style attribute, frame, media, dialog, popover, event handler, live region, alert or modal role;
- class names and ids become your region's own (`tc-<name>`), the ids ARIA attributes and fragment links name too, so the chrome never shadows a store element;
- of the data attributes, only the store's chrome behaviours stay (`whenSignedIn()`, `colorSchemeToggle()`, `accountLink()`), and the buyer UI's kind and tone words (`data-ui`, `data-tone`);
- your slots draw nothing: no app slot, no light or dark switch, no market or language form sits inside your region (the page offers none of them, as with the store's checkout header);
- no form: every form, field, select and label goes, a search form included. The store's own search (`data-host="search"`: one field named `q` and a submit, in the store's words) sits in its own slot of the header's frame, before or after your region as `search` says, never inside it. The page carries no app form token.

Your public stylesheet does not load on private pages: style the chrome in this stylesheet through its classes (`[data-free="header"] .site-header`). A menu works as a `<details>`.

Trust model. A bundled app's skin is code the store runs in its own Worker. It gets only the job (the projection, its settings and the root path), but as host code it could read what the process holds during that request, like any store code. An isolated app's skin runs in its own isolate and gets only the job. Neither ever gets the buyer's cart lines, which live in the browser.

## The reference cart

The reference design's cart (a dark store with a square violet panel, portrait line images, a price column, an emerald total and an app's amber offer row) is an arrangement, tokens and free CSS. It is compiled against its palette in the store's tests (`packages/shared/src/storefront-theme/private-reference.fixture.ts`):

```json
{
  "tokens": {
    "cart": {
      "page": { "gradient": { "shape": "radial", "from": "#2b1650", "to": "background" } },
      "lines": { "background": "card", "border": "#524179", "border-width": 1, "radius": 0, "shadow": "lg" },
      "line-image": { "width": 64, "height": 80, "width-wide": 92, "height-wide": 112, "radius": 0, "fit": "cover" },
      "line-title": { "weight": "600", "clamp": "2" },
      "summary": { "background": "card", "border": "#524179", "border-width": 1, "radius": 0, "padding": 20, "gap": 12 },
      "summary-total": { "text": "#34d399", "size": 20, "weight": "800" },
      "submit": { "background": "#7c3aed", "text": "#ffffff", "radius": 0, "case": "uppercase", "weight": "700" },
      "dialog-confirm": { "background": "#7c3aed", "text": "#ffffff", "radius": 0, "weight": "700" },
      "ui.banner.warning@gameghor.protection": { "background": "#3a2a0a", "text": "#fde68a", "border": "#f59e0b", "border-width": 1, "radius": 0 },
      "ui.button@gameghor.protection": { "background": "#10b981", "text": "#04130d", "radius": 0, "weight": "700" },
      "@line-grid": { "columns": [64, "1fr", 88], "columns-wide": [92, "1fr", 150], "gap": 12 }
    }
  },
  "search": "after",
  "labels": { "cart.heading": { "en": "Your Cart", "bn": "আপনার কার্ট" }, "dialog.goBack": "go-back", "dialog.confirm": "continue-checkout", "drawer.checkout": "proceed-to-checkout" },
  "css": "[data-hook=\"cart-intro\"] p { color: #b9b0d6; margin: 0 }"
}
```

The line arrangement puts the image, a stack of the title and its facts, and a `line-side` stack of the price, the stepper and remove in the `line-grid` grid, with the app's per-line target under it.

## Anatomy reference

The contract a test pins: a renamed or removed part, hook or label fails the store's build. Each page's root carries `data-private`, each part's elements `data-part`, each host layout `data-layout`. Money rows carry `data-summary-row` (`subtotal`, `add-on`, `delivery`, `discount`, `tax`, `total`) on every surface. An app's block is drawn in a wrapper with `data-buyer-ui-app` inside its target's `data-buyer-ui-target`, and each of its nodes carries its kind on `data-ui` and its tone on `data-tone`. These hooks are for reading the page; your stylesheet reaches only inside free regions, and the store's parts and the apps' blocks take tokens. A `style` line is a style target: the selector the store writes it at (`<root>` is the page's `data-private` root) and the tokens it takes.

```text
cart root data-private=cart frames=standard|narrow
cart part progress hooks=progress
cart part notices mandatory hooks=notice
cart part lines mandatory hooks=lines,lines-heading,lines-continue,lines-loading,lines-list,lines-clear,lines-undo,cart-empty,cart-empty-icon
cart part summary mandatory hooks=summary,summary-validation
cart part discount hooks=discount
cart part details mandatory hooks=details,details-sign-in,details-form,contact,delivery,details-errors,details-submit,legal
cart part empty hooks=empty-extras
cart fields in discount,details
cart target cart.page.summary
cart target cart.page.below
cart layouts stack,columns,grid,group,fold
cart layout fold hooks=fold-toggle,fold-body
cart layout fold holds=lines,summary,discount,cart.page.summary
cart style page body[data-private-body] tokens=background,gradient,text,muted,link,error
cart style frame <root> <root> tokens=max-width
cart style action :is([data-private="cart"],[data-private="dialog"]) .bg-primary tokens=background,gradient,text,border,border-width,border-style,radius,shadow,ring,font,weight,size,case,tracking
cart style input :is([data-private="cart"],[data-private="dialog"]) :is(input:not([type="checkbox"],[type="radio"],[type="hidden"]),select,textarea) tokens=background,text,placeholder,border,ring,invalid,border-width,radius
cart style notice <root> [data-part="notice"] tokens=background,text,muted,link,error,border,border-width,radius
cart style lines <root> [data-part="lines"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding
cart style lines-heading <root> [data-part="lines-heading"] tokens=text,font,weight,size,case,tracking
cart style cart-empty <root> [data-part="cart-empty"] tokens=text,muted
cart style line <root> [data-part="line"] tokens=background,border,border-width,border-style,radius,padding
cart style line-image <root> [data-part="line-image"] tokens=width,height,width-wide,height-wide,radius,background,border,border-width,border-style,fit
cart style line-title <root> [data-part="line-title"] tokens=text,font,weight,size,case,tracking,clamp
cart style line-details <root> [data-part="line-details"] tokens=text,size
cart style line-price <root> [data-part="line-price"] tokens=text,muted,font,weight,size,align
cart style line-quantity <root> [data-part="line-quantity"] tokens=background,text,border,border-width,border-style,radius,ring
cart style line-remove <root> [data-part="line-remove"] tokens=text,radius,ring
cart style fold-toggle <root> [data-part="fold-toggle"] tokens=background,text,border,border-width,radius,shadow,ring
cart style summary <root> [data-part="summary"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding,gap
cart style summary-rows <root> [data-summary-row]:not([data-summary-row="total"]) tokens=text,size
cart style summary-total <root> [data-summary-row="total"] tokens=text,font,weight,size,case,tracking
cart style details-form <root> [data-part="details-form"] tokens=background,gradient,text,muted,link,error,border,border-width,border-style,radius,shadow,padding targets=checkout.contact.after,checkout.delivery.after
cart style section-heading <root> :is([data-part="contact"],[data-part="delivery"]) h2 tokens=text,font,weight,size,case,tracking
cart style submit <root> [data-part="details-submit"] tokens=background,gradient,text,border,border-width,border-style,radius,shadow,ring,font,weight,size,case,tracking
cart style legal <root> [data-part="legal"] tokens=text,size,align
cart style dialog [data-private="dialog"] tokens=background,text,muted,link,error,border,border-width,radius,shadow fields
cart style dialog-back [data-private="dialog"] [data-part="dialog-back"] tokens=background,text,border,border-width,radius,ring,weight
cart style dialog-confirm [data-private="dialog"] [data-part="dialog-confirm"] tokens=background,gradient,text,border,border-width,border-style,radius,shadow,ring,font,weight,size,case,tracking
cart style chrome [data-private="core-header"] tokens=background,gradient,text,muted,link,border,border-width
cart style search [data-host="search"] tokens=background,text,placeholder,border,ring,invalid,border-width,radius
cart.line root data-part=line
cart.line part image hooks=line-image
cart.line part title mandatory hooks=line-title
cart.line part details mandatory hooks=line-details
cart.line part inputs mandatory hooks=line-inputs
cart.line part quantity mandatory hooks=line-quantity
cart.line part price mandatory hooks=line-price
cart.line part remove mandatory hooks=line-remove
cart.line part limit mandatory hooks=line-limit
cart.line part issue mandatory hooks=line-issue
cart.line part rule mandatory hooks=line-rule
cart.line fields in inputs
cart.line target cart.line.after
cart.line layouts stack,columns,grid,group
cart label cart.heading max=60
cart label cart.continue variants=continue-shopping|keep-shopping|back-to-store
cart label cart.empty max=80
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
cartDrawer part summary mandatory hooks=drawer-summary,drawer-total,drawer-blocked
cartDrawer part actions mandatory hooks=drawer-checkout,drawer-actions,drawer-view-cart,drawer-continue
cartDrawer target cart_drawer.footer
cartDrawer layouts stack,columns,grid,group,scroll
cartDrawer layout scroll hooks=drawer-scroll
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
cartDrawer label drawer.title max=40
cartDrawer label drawer.checkout variants=checkout|proceed-to-checkout
cartDrawer label drawer.viewCart variants=view-cart|go-to-cart
cartDrawer label drawer.continue variants=continue-shopping|keep-shopping
cartDrawer label drawer.empty max=80
cartDrawer label drawer.startShopping variants=start-shopping|browse-products|continue-shopping
cartDrawer icon drawer.empty
dialog root data-private=dialog hooks=sign-in,dialog-title,dialog-text,dialog-agree,dialog-actions,dialog-back,dialog-confirm
buyer-ui attributes=data-buyer-ui-target,data-buyer-ui-app,data-ui
chrome roots data-private=header|footer search=before|after
layout tokens=background,gradient,border,border-width,border-style,radius,shadow,padding,gap,columns,columns-wide
buyer-ui style ui.banner[.neutral|info|success|warning|critical][@<app>][/<target>] [data-ui="banner"] tokens=background,text,border,border-width,radius,shadow,padding
buyer-ui style ui.button[@<app>][/<target>] :is(a[data-ui="button"],[data-ui="button"]>button) tokens=background,text,border,border-width,radius,ring,weight,size,case
buyer-ui style ui.badge[.neutral|info|success|warning|critical][@<app>][/<target>] [data-ui="badge"] tokens=background,text,border,radius
buyer-ui style ui.text[@<app>][/<target>] [data-ui="text"] tokens=text,size,weight
buyer-ui style ui.heading[@<app>][/<target>] [data-ui="heading"] tokens=text,size,weight,font,case
buyer-ui style ui.disclosure[@<app>][/<target>] [data-ui="disclosure"] tokens=background,text,border,radius
buyer-ui style ui.row[@<app>][/<target>] :is([data-ui="stack"],[data-ui="columns"]) tokens=gap
free regions data-free=block|header|footer
```
