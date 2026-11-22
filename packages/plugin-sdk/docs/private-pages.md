# Design the buyer's private pages

The cart page and the cart drawer are a buyer's own pages: they hold a cart, an address, a phone number and a code. No theme or app script ever runs there. You still design them: you arrange the store's parts, add your own words and pictures, reword its labels and style everything with one stylesheet. The store draws the page from that data.

This page covers the cart page and the drawer. The checkout, the receipt and the account follow the same model as they move to it; until then they take the closed choices in [themes.md](themes.md#templates).

## What you set

A template sets them under `privatePages`. The merchant's theme document holds the same object, so a merchant or an agent can edit it too.

| Field | What it is |
| --- | --- |
| `chrome` | `core` (the store's minimal checkout header) or `theme` (your header and footer skins, drawn without script). |
| `pages.cart`, `pages.cartDrawer` | An arrangement per page. Leave a page out to keep the store's own. |
| `css` | Your stylesheet for these pages, at most 24 KiB. |
| `labels` | Your words for the store's labels, per language: `{ "cart.heading": { "en": "Your Cart", "bn": "আপনার কার্ট" } }`. |
| `icons` | Your image for a store icon: `{ "cart.empty": { "app": "acme.studio", "file": "icons/bag.svg" } }` (a file in your `public/`). |

The store checks all of it when the theme is saved or published, and stores the checked stylesheet. A refusal names its `reason` (below).

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

## The stylesheet

Write ordinary CSS against the hooks. The store scopes every selector under `[data-private]` (each private surface's root), and a rule for `:root`, `html` or `body` alone sets the page's own tokens and background:

```css
:root { --primary: #6d28d9; }
body { background: radial-gradient(#1e1831, #0b0915); }
[data-hook="studio-grid"] { grid-template-columns: minmax(0, 1fr) 380px; }
[data-part="line"] [data-hook="studio-line"] { grid-template-columns: 64px 1fr 88px; }
[data-buyer-ui-app="acme.protection"] [data-ui="banner"] { border-radius: 0; }
@media (min-width: 40rem) { [data-hook="studio-line"] { grid-template-columns: 92px 1fr 150px; } }
@font-face { font-family: Studio; src: url(/_x/acme.studio/<release>/public/fonts/studio.woff2) format("woff2"); }
```

Allowed: style rules, `@media`, `@supports`, `@container`, `@layer`, `@font-face`, `@keyframes`, and `url()` for your own `public/` files or a fragment (`#id`). Write sides as logical properties (`margin-inline-start`, `inset-inline-end`), so a right-to-left page mirrors.

Refused, each with its `reason`:

| `reason` | Why |
| --- | --- |
| `import` | `@import` reaches another file. |
| `foreign_url` | A `url()` that is not your own file: another host, `//…`, an app page, a `..` path. |
| `forbidden_function` | `image-set()`, `src()`, `attr()`, `element()`, `cross-fade()`. |
| `form_value_selector` | An attribute-value selector on `input`, `select`, `textarea`, `option`, `button`, `output`, or on `value`, `placeholder`, `name`, `checked`: it could reveal what a buyer types. Style a field through its part: `[data-part="contact"] input`. |
| `escape` | A backslash outside a quoted string. |
| `unscoped_selector` | A selector starting with a combinator, or a sibling of a surface root (`[data-private] ~ *`). |
| `nested_rule` | Nested rules: write each with its full selector. |
| `unsupported_at_rule` | `@page`, `@namespace`, `@property` and others. |
| `too_large` | Over 24 KiB. |
| `syntax` | Not CSS the store can read. |

The page's policy loads images only from the store's own origins, so a stylesheet cannot reach another host even by a path the check missed.

**The guard.** If your stylesheet hides what a buyer must see (the total, Check out, the details form's submit, a line's price, quantity or remove), by `display`, `visibility`, `opacity`, a zero size or moving it off the page, the page drops your stylesheet for that view, marks `<html data-private-style="dropped">` and says why in the console. Check your look with the theme editor's canvas.

## Words and icons

| Label | Page | Longest |
| --- | --- | --- |
| `cart.heading`, `cart.continue`, `cart.subtotal`, `cart.showSummary`, `cart.hideSummary` | Cart page | 40 to 60 |
| `cart.empty`, `cart.emptyText` | Cart page, empty | 80, 200 |
| `dialog.goBack`, `dialog.confirm` | The confirmation an app's choice asks for | 30 |
| `drawer.title`, `drawer.checkout`, `drawer.viewCart`, `drawer.continue`, `drawer.empty`, `drawer.startShopping` | Drawer | 30 to 80 |

Labels are plain text: `markup` refuses HTML and `label_too_long` refuses words over the bound. Icons: `cart.empty`, `drawer.empty`.

## Your header and footer

With `chrome: theme` the cart page draws your header and footer skins, the same projection as on any page (the store's name, logo, menus, routes), told the page is `/cart`. They draw without script: no island loads, deferred markup is drawn in place and no JSON-LD is written. Make the header work without its islands (a `<details>` menu, a `GET` search form, `menuDrawer()` and `CartCount`), and put its styles in this stylesheet: your public stylesheet does not load on private pages. A buyer's session, order or address never reaches a skin.

## Anatomy reference

The contract a test pins: a renamed or removed part, hook or label fails the store's build. Each page's root carries `data-private`, each part's elements `data-part`, each host layout `data-layout`. Money rows carry `data-summary-row` (`subtotal`, `add-on`, `delivery`, `discount`, `tax`, `total`) on every surface. An app's block carries `data-buyer-ui-app` inside its target's `data-buyer-ui-target`, and each of its nodes its kind on `data-ui`.

```text
cart root data-private=cart frames=standard|narrow
cart part progress hooks=progress
cart part notices mandatory hooks=notice
cart part lines mandatory hooks=lines,lines-heading,lines-continue,lines-loading,lines-list,lines-clear,lines-undo,cart-empty,cart-empty-icon
cart part summary mandatory hooks=summary,summary-validation guard=[data-summary-row="total"]
cart part discount hooks=discount
cart part details mandatory hooks=details,details-sign-in,details-form,contact,delivery,details-errors,details-submit,legal guard=[data-part="details-submit"],[data-part="contact"],[data-part="delivery"]
cart part empty hooks=empty-extras
cart target cart.page.summary
cart target cart.page.below
cart layouts stack,columns,grid,group,fold
cart layout fold hooks=fold-toggle,fold-body
cart.line root data-part=line
cart.line part image hooks=line-image
cart.line part title mandatory hooks=line-title
cart.line part details mandatory hooks=line-details
cart.line part inputs mandatory hooks=line-inputs
cart.line part quantity mandatory hooks=line-quantity guard=[data-part="line-quantity"]
cart.line part price mandatory hooks=line-price guard=[data-part="line-price"]
cart.line part remove mandatory hooks=line-remove guard=[data-part="line-remove"]
cart.line part limit mandatory hooks=line-limit
cart.line part issue mandatory hooks=line-issue
cart.line part rule mandatory hooks=line-rule
cart.line target cart.line.after
cart.line layouts stack,columns,grid,group
cart label cart.heading max=60
cart label cart.continue max=40
cart label cart.empty max=80
cart label cart.emptyText max=200
cart label cart.subtotal max=40
cart label cart.showSummary max=40
cart label cart.hideSummary max=40
cart label dialog.goBack max=30
cart label dialog.confirm max=30
cart icon cart.empty
cartDrawer root data-private=cart-drawer frames=standard|wide
cartDrawer part header mandatory hooks=drawer-header,drawer-title,drawer-count,drawer-close
cartDrawer part added hooks=drawer-added
cartDrawer part lines mandatory hooks=drawer-lines,drawer-empty,drawer-empty-icon
cartDrawer part recommendations hooks=drawer-recommendations
cartDrawer part undo mandatory hooks=drawer-undo
cartDrawer part offers hooks=drawer-offers
cartDrawer part summary mandatory hooks=drawer-summary,drawer-total,drawer-blocked guard=[data-summary-row="total"]
cartDrawer part actions mandatory hooks=drawer-checkout,drawer-actions,drawer-view-cart,drawer-continue guard=[data-part="drawer-checkout"]
cartDrawer target cart_drawer.footer
cartDrawer layouts stack,columns,grid,group,scroll
cartDrawer layout scroll hooks=drawer-scroll
cartDrawer.line root data-part=line
cartDrawer.line part image hooks=line-image
cartDrawer.line part title mandatory hooks=line-title
cartDrawer.line part details mandatory hooks=line-details
cartDrawer.line part inputs mandatory hooks=line-inputs
cartDrawer.line part quantity mandatory hooks=line-quantity guard=[data-part="line-quantity"]
cartDrawer.line part price mandatory hooks=line-price guard=[data-part="line-price"]
cartDrawer.line part remove mandatory hooks=line-remove guard=[data-part="line-remove"]
cartDrawer.line part limit mandatory hooks=line-limit
cartDrawer.line part issue mandatory hooks=line-issue
cartDrawer.line part rule mandatory hooks=line-rule
cartDrawer.line target cart.line.after
cartDrawer.line layouts stack,columns,grid,group
cartDrawer label drawer.title max=40
cartDrawer label drawer.checkout max=30
cartDrawer label drawer.viewCart max=30
cartDrawer label drawer.continue max=40
cartDrawer label drawer.empty max=80
cartDrawer label drawer.startShopping max=30
cartDrawer icon drawer.empty
dialog root data-private=dialog hooks=sign-in,dialog-title,dialog-text,dialog-agree,dialog-actions,dialog-back,dialog-confirm
buyer-ui attributes=data-buyer-ui-target,data-buyer-ui-app,data-ui
chrome roots data-private=header|footer
```

The drawer opens over public pages too. There your public stylesheet applies, through the same hooks.
