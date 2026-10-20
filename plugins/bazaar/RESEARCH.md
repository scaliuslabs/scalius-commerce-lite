# Bazaar: storefront structure research

Bazaar replicates the layout and buying UX of the largest general-merchandise
marketplace storefront (amazon.com) under its own name, logo and words. The
owner approved copying layout and UX; no trademark, logo, product photo or
marketing copy of the reference is used. Demo text and photos live only in the
demo content pack (`src/demo/`), never in theme code.

## Method

`WebFetch` of `https://www.amazon.com/` (1.17 MB of HTML, read in 100 KB
windows at offsets 0, 100k, 300k and 1,000k) and of one product detail page
(`/dp/...`, 619 KB; the fetched variant was the "Fallback Detail Page", so its
body was script-only). The homepage card titles are delivered encrypted/base64
inside widget payloads, so card titles were not readable; the structure below
combines what the fetch confirmed (marked **seen**) with the long-stable,
publicly documented layout of the same pages (marked **known**). Verify the
known items against a live browser before a pixel-level pass.

## Homepage

### Header (`#navbar`, dark `#131921`, 60px)

1. Logo link (**seen**: logo plus a locale label, `.us`).
2. "Deliver to <city>" location chip (**known**; not in the fetched window).
3. Search form (**seen**): a department `<select>` on the left (default
   "All Departments", then every department: Books, Electronics, Toys &
   Games, ...), the text field (placeholder "Search Amazon"), and the
   orange magnifier "Go" submit on the right. Focus draws an orange ring.
4. Language flyout (**seen**: "EN" with a flag; English - EN, español - ES;
   currency USD).
5. "Hello, sign in / Account & Lists" two-line link with a flyout
   (**seen**: "Hello", "Account & Lists").
6. "Returns & Orders" two-line link (**seen**).
7. Cart: a cart glyph with the count overlaid in orange, label "Cart"
   (**seen**).
8. Skip links: "Skip to Main content", keyboard shortcuts for Search, Cart,
   Home, Orders (**seen**).

### Sub-nav (`#nav-main`, `#232f3e`, 39px)

- "All" with a hamburger glyph opens the left drawer (hmenu) (**seen**).
- One row of department links (**seen**, in order): Groceries, Today's
  Deals, Coupons, Pharmacy, Audible, Whole Foods, Music, Pet Supplies, Home,
  Registry, Automotive, Beauty & Personal Care, New Releases, Video Games,
  Fashion, Handmade, Baby, Toys & Games, Smart Home, Subscribe & Save, Sports
  & Outdoors, Gift Shop, Works with Alexa, Custom Products, Best Sellers,
  Luxury, Kindle Books, Books, Computers, Gift Cards. Overflow is clipped, not
  wrapped.
- A promo slot at the end of the row (**known**).

### The "All" drawer (hmenu) (**known**)

- Fixed left panel, 365px, white, over a dark scrim; a close "X" outside it.
- Top band in `#232f3e`: avatar plus "Hello, sign in".
- Groups with bold headings and a divider: "Digital Content & Devices",
  "Shop by Department", "Programs & Features", "Help & Settings".
- Each department row has a right chevron; it slides in a sub-panel with a
  "← Main menu" back row (one level at a time).
- "See all" expands a group in place.

### Hero (**known**)

- Full-bleed carousel (~600px tall on desktop) with big left/right arrow
  hit areas; the image fades to the page grey at its bottom; the first card
  row overlaps the lower ~250px of the hero.

### Card rows (**seen**: shoppable widgets `wd-shoppable-1`, `-2`, a quad card "Deals on Amazon Devices" with subtitle "Shop and save" and four product tiles)

- A row of four white cards (desktop), each ~ 350px tall with 20px padding:
  - title (21px, bold);
  - either one large image, or a 2x2 quad of image tiles each with a small
    caption;
  - a footer link ("See more", "Shop now", "Shop deals").
- Rows of cards alternate with horizontal product carousels.

### Product carousels (**known**)

- White band, title on the left ("Best Sellers in ...", "Today's deals",
  "Related to items you've viewed") with an optional "See more" link, a
  horizontal scroller of fixed-height product images, arrow buttons on hover.
- Deal carousels add per item a red badge ("Up to 30% off" / "Limited time
  deal") and the price line.

### Footer (**seen**: "Back to top"; legal line: "Conditions of Use", "Privacy Notice", "Consumer Health Data Privacy Disclosure", "Your Ads Privacy Choices", "© 1996-2026, ... or its affiliates"; language "English"/"español"; country "United States")

1. "Back to top" full-width bar (`#37475a`).
2. Four link columns on `#232f3e` (**known**): "Get to Know Us", "Make
   Money with Us", "Amazon Payment Products", "Let Us Help You".
3. A divider, then logo plus language, currency and country selectors.
4. A dense grid of sister services (name plus one-line description) on
   `#131a22` (**known**).
5. The legal line (**seen**).

## Search results / listing (**known**)

- A results bar: "1-48 of over 10,000 results for "query"" and "Sort by:
  Featured" on the right.
- Left filter rail (~240px): "Department", "Customer Reviews" (4 stars & up),
  "Brands", "Price" (range plus a slider), "Deals & Discounts", each a bold
  heading with checkbox links.
- Result grid (4 per row desktop) or list; each card: image on light grey,
  "Sponsored" label, title (clamped to 4 lines, link colour on hover),
  stars + count, "1K+ bought in past month", price with superscript cents and
  "List: $xx" struck, a prime-style check badge plus "FREE delivery Tue, Oct
  22", "Add to cart" yellow pill (`#ffd814`) on simple products, "See
  options" otherwise.
- Pagination: "Previous 1 2 3 ... 20 Next" centred.

## Product detail page (**known**; the fetched page was the fallback variant)

- Breadcrumb trail at the top ("Electronics › Computers & Accessories › ...").
- Three columns on desktop:
  1. Image block (~40%): vertical thumbnail strip on the left, main image
     with hover zoom.
  2. Center column: title (24px), "Visit the <Brand> Store" link, rating
     row (average, stars, "1,234 ratings" link), an optional
     "<Store>'s Choice" badge, "1K+ bought in past month", a divider, price
     block ("-15% $129.99", "List Price: $152.99" struck), option swatches,
     a key-facts table (Brand, Model, ...), "About this item" bullet list.
  3. Buy box (~245px, bordered card, radius 8px): price, prime-style
     badge, "FREE delivery <date>", "Deliver to <city>", stock line
     ("In Stock" green), "Quantity" select, "Add to Cart" (yellow
     `#ffd814`, pill), "Buy Now" (orange `#ffa41c`, pill), a secure
     transaction line, then a small table "Ships from / Sold by / Returns /
     Payment", "Add to List", and below the box "Other sellers on Amazon"
     / "New & Used (n) from $xx" with the cheapest other offer and "Add to
     Cart".
- Below: "Frequently bought together", "Products related to this item"
  carousel, "Product information" two-column table, "From the
  manufacturer", "Customer reviews" with the 5-bar histogram on the left and
  top reviews on the right.

## Cart (**known**)

- "Shopping Cart" white card on grey: lines (image, title, "In Stock",
  "Eligible for FREE Shipping", gift option, quantity stepper, Delete, Save
  for later, Share), price on the right; subtotal at the bottom.
- Right rail card: "Subtotal (n items): $xx" and "Proceed to checkout"
  yellow pill.

Scalius renders the cart on a core page that apps never draw on (R3:
`appComponentsRenderOn`), so Bazaar styles the cart only through tokens.
See `BURST-NOTES.md` (platform gap: cart skin).

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| Header | `#131921` | top bar |
| Sub-nav | `#232f3e` | department row, drawer head, footer |
| Back to top | `#37475a` | footer bar |
| Footer bottom | `#131a22` | services grid |
| Page | `#e3e6e6` | homepage background |
| Ink | `#0f1111` | text |
| Link | `#007185` (hover `#c7511f`) | links |
| Search button | `#febd69` | search submit |
| Add to cart | `#ffd814` (border `#fcd200`) | primary pill |
| Buy now | `#ffa41c` (border `#ff8f00`) | secondary pill |
| Deal | `#cc0c39` | deal badge, percent |
| Stars | `#ffa41c` | ratings |
| In stock | `#007600` | availability |
| Prime-style badge | `#1399ff` on white | fast-delivery mark |

Type: the reference uses its own sans; Bazaar uses the system sans stack
(`Arial, sans-serif` fallback). Radius: cards 0-8px, pills 100px.
