# Rich demo store blueprint

Last reviewed: 2026-07-13

Status: the checked-in manifest and network-free planning gate are implemented;
authenticated write/reconcile phases are still disabled. The deployed result
belongs in [LIVE-DEMO-RUN.md](LIVE-DEMO-RUN.md) only after the API writes,
storefront/admin browser run, and release checks have passed.

Run `pnpm demo:store --plan` before any import work. It validates and prints the
exact five-category, 50-product, 177-SKU contract, including identity and option
topology, positive prices and stock intent, media-slot/alt-text intent, ordered
additional sections, offers, collections, heroes, and retained Rider/Halo IDs.
The command has no implicit write mode; omitting `--plan` fails closed. Stable
phase resume keys are present for the later authenticated API reconciler, but
they do not claim that any live resource has been created or updated.

`pnpm demo:store --compile` is the parallel network-free inspection gate for
the deterministic admin API command intent. It is also write-disabled. The
compiled vocabulary step creates the exact filterable Brand definition only
when its slug is absent; a drifting existing Brand is a pre-write conflict
because Attribute updates do not yet have a monotonic revision claim.

`pnpm demo:store --diff` is the next read-only gate. It asks for the admin email
and a non-echoed password in an interactive terminal, creates a short-lived
session, verifies authenticated access, and reads bounded category, product,
product-detail, Media, attribute, collection, theme, header/footer, and hero
projections through the dashboard's admin API proxy. Page reads stop after 20
pages of 100 and Media cursors must be non-repeating and no longer than 2,000
characters. Exact category/product slugs, retained product IDs, option
topology, revisions, and exact collection names drive the diff; unexpected
resources are reported, never implicitly trashed.

Diff evidence is written with private file modes under the Git-ignored
`.wrangler/demo-store-evidence/` directory by default. The resume journal uses
a strict field allowlist and contains only phase/resource/revision/status
metadata; credentials, cookies, buyer data, receipt proof, OTPs, and response
error bodies are not recorded. The session is closed best-effort even when a
read or evidence write fails. `--diff` does not enable any write phase, and
credential flags are rejected so secrets cannot enter shell history.

### Apply executor milestone (not CLI-enabled)

The checked-in apply engine now has a second, stricter gate behind `--diff`.
It accepts only a complete staged-asset report whose SHA-256 manifest
fingerprint matches the current 5/50/177 intent and whose 237 exact logical
media records are all ready, uniquely identified, hashed, dimensioned, and
typed. Header/footer intent is rejected because those settings APIs do not yet
have revision claims. The public `pnpm demo:store` command still rejects
`--apply`; completing this report does not by itself authorize writes.

The internal executor consumes one pure compiler authority and binds its
references from fresh snapshots and verified staged assets; it does not rebuild
request payloads in the apply layer. It runs sequential create-only vocabulary,
category, product, inactive collection, and desktop/mobile hero commands
through admin APIs only.
Theme intent remains outside this milestone. Creates are resolved
again by exact slug/name/type after success, timeout, or conflict; updates carry
the current category revision, product aggregate revision, collection version,
theme revision, or hero revision. A 409 is reported as a conflict and is never
blindly retried. Every command is re-read and verified after a nominal success,
and later dependent phases stop when an earlier phase conflicts.
The staged-only executor refuses active non-retained products, collections, or
heroes until the explicit quarantine lifecycle has deactivated them.

Product creation uses stable request-scoped option/value/SKU/media association
IDs, starts inactive, and writes optioned initial stock through the existing
product matrix ledger-v2 path. Existing matching SKU rows retain their persisted
ID, stock, barcode, barcode type, weight, and tracking policy; an editor rerun
must not reset operational inventory. A newly created simple product may receive
its one initial stock update only when the current run or a safe resume journal
proves creation provenance. Otherwise the executor refuses to guess whether a
zero/changed quantity is seed state or real commerce activity.

Media readiness fingerprints include every asset's exact owner, role,
crop/profile, caption, and alt-text intent. Apply authorization separately
fingerprints the complete catalog intent, including copy, prices, offers, and
merchandising, so a media-ready report cannot authorize changed product data.

Rider and Halo are stronger boundaries: exact retained IDs and option topology
must match the fresh snapshot, all stock/reservation/version facts must be
present, every existing ready media association must remain represented, and no
option-matrix or variant-stock command is generated for either product. Their
base copy/media command preserves current activation, non-Brand attributes,
association IDs, SKU images, inventory, reservations, and barcodes.

Collections are created inactive with deterministic membership (balanced
3/3/2/2/2 New & Noteworthy selection, explicit Weekend Ready, first 12 current
offers, and category-backed dynamic collections). Hero sliders are likewise
saved inactive with separate desktop/mobile staged assets. Publication,
activation, unversioned header/footer writes, and CLI exposure remain later
milestones after staged browser verification; the executor reports
`staged_complete`, never stable-release completion.

## Target and acceptance contract

The demo merchant is **Scalius Market**, a coherent multi-category lifestyle
store with five fictional house labels. The seed must end with exactly five
active, published categories and exactly ten active products in each category:

| Category | House label | Buyer promise |
| --- | --- | --- |
| Footwear | Northline | Comfort-first daily shoes with useful fit choices |
| Home & Living | Loom & Light | Calm lighting, textiles, and small-space objects |
| Bags & Carry | Fieldwork | Organized carry for commutes, errands, and short trips |
| Kitchen & Table | Common Table | Practical tools and tableware for everyday cooking |
| Desk & Mobile Tech | Orbit Works | Quiet, compact accessories for work and travel |

The final active catalog has 50 products, 177 sellable SKUs, 46 optioned
products, and four simple products with one persisted hidden/default SKU each.
The two existing live products and their stable identities are retained:

- `prod_9XNNERD2XpAOIoI1SN6gx` / `rider-court-trainers` remains in Footwear;
- `prod_FOHvuxr0Hr11AA_hyLUpH` / `halo-arc-table-lamp` remains in Home & Living.

Their SKU identities, inventory ledger, open reservations, order history,
option-value IDs, and existing product-media association IDs must not be reset.
They may receive richer copy, facts, and media metadata through revision-aware
updates. Any topology or stock change must be handled as an ordinary merchant
edit and must preserve the existing reservation and ledger rules.

Completion means all of the following are true at the same time:

- category and active-product counts are exactly `5` and `50`, with `10` per
  published category; trash-only audit products/categories do not count;
- every active product has a positive buyer-resolvable SKU price, at least one
  available SKU, a real image representation, rich main copy, explicit brand,
  product condition, SEO copy, and descriptive alt text;
- every option axis uses merchant language and one accurate standard mapping
  (`size`, `color`, `material`, `pattern`, or `none`), never hard-coded
  size/color assumptions;
- every saved SKU image is an exact `product_variants.image_id` reference to an
  attached ready image. A missing exact image remains `NULL` and visibly uses
  the product primary image; no axis inheritance or positional matching exists;
- at least 16 products have two or more ordered additional-information
  sections, and the sections render in the protected product-page layout;
- desktop and mobile category/product grids, search, filters, collection
  sections, cart, checkout, order creation, feeds, sitemap, JSON-LD, and UCP all
  agree on product media, price, discount, option labels, and availability;
- desktop and mobile hero images are separate assets composed for their actual
  aspect ratios. Product imagery is not stretched into banners;
- the run is reproducible and resumable through authenticated admin APIs. No
  catalog, media, inventory, category, collection, theme, or navigation row is
  inserted or updated with raw D1 SQL.

## Assortment notation

- Options use `Name{values}[standard mapping]`. `x` means the saved Cartesian
  axes; an explicit omission means that combination does not exist.
- Media slots are `P` (primary), `V:value` (variant view), `D` (detail), `L`
  (lifestyle), and `VID` (video). A rule such as `Sand -> V:Sand` means the UI
  convenience may select all Sand rows, but the API payload materializes the
  exact same association ID on every matching SKU row.
- `fallback` means a saved `imageId: null`; it is intentional, not missing data.
- Stock profiles list exact on-hand quantities in manifest variant order:
  `steady = [18,16,14,12,10,8]`, `deep = [30,25,20,18,16,12]`,
  `scarce = [8,6,4,3,2,0]`, and `simple = [24]`. Use only the prefix required
  by that product's SKU count. Every SKU tracks inventory. The importer must
  not overwrite the retained Rider/Halo stock values.
- Offers are either product-wide (`product 10%`, `product BDT 300 off`) or
  exact-SKU (`SKU ... 10%`). Do not combine a product and SKU offer on the same
  product in this dataset. Prices are BDT major units.

## Exact product manifest

### Footwear — `footwear`

Category copy: “Comfort-first trainers, sandals, flats, and boots selected for
Bangladesh's working week and warm-weather weekends. Clear fit choices, durable
soles, and practical materials make every pair easy to choose and live in.”

| # | Product / slug | BDT | Options and SKU count | Media and exact-SKU image rule | Inventory / offer / delivery | Additional sections |
| ---: | --- | ---: | --- | --- | --- | --- |
| 1 | Rider Court Trainers / `rider-court-trainers` | 8,990 | Size{40,41,42}[size] x Color{Sand,Onyx}[color] = 6 | Keep current 4 images; retain current exact Sand-40 image and current fallback rows | Preserve live counts/reservation; no offer | 3 |
| 2 | Vale Everyday Runners / `vale-everyday-runners` | 6,490 | Size{39,41,43}[size] x Color{Chalk,Slate}[color] = 6 | 4: P,V:Chalk,V:Slate,D; exact by Color on all rows | steady; Slate-43 SKU 10% | 2 |
| 3 | Monsoon Trail Sandals / `monsoon-trail-sandals` | 4,290 | Size{40,42,44}[size] x Strap{Olive,Black}[color] = 6 | 4: P,V:Olive,V:Black,L; exact by Strap | deep; no offer | 2 |
| 4 | Nila City Loafers / `nila-city-loafers` | 7,290 | Size{38,40,42}[size] x Finish{Cocoa,Black}[color] = 6 | 4: P,V:Cocoa,V:Black,D; exact by Finish | steady; product BDT 500 off; free | 0 |
| 5 | Padma Knit Slip-Ons / `padma-knit-slip-ons` | 4,990 | Size{39,41,43}[size] x Color{Mist,Navy}[color] = 6 | 4: P,V:Mist,V:Navy,D; exact by Color | scarce; no offer | 0 |
| 6 | Dune Leather Slides / `dune-leather-slides` | 3,490 | Size{40,42,44}[size] = 3 | 3: P,D,L; fallback all | deep; product 8% | 0 |
| 7 | Metro Low-Top Sneakers / `metro-low-top-sneakers` | 7,990 | Size{40,42,44}[size] x Color{White,Graphite}[color] = 6 | 4: P,V:White,V:Graphite,D; exact by Color | steady; no offer; free | 0 |
| 8 | Rove Packable Flats / `rove-packable-flats` | 3,990 | Size{36,38,40}[size] x Color{Rose,Black}[color] = 6 | 4: P,V:Rose,V:Black,L; exact Rose rows, Black rows fallback | deep; product 10% | 0 |
| 9 | Ridge Chelsea Boots / `ridge-chelsea-boots` | 10,990 | Size{40,42,44}[size] x Finish{Tan,Black}[color] = 6 | 5: P,V:Tan,V:Black,D,L; exact by Finish | scarce; no offer; free | 2 |
| 10 | Aster Studio Clogs / `aster-studio-clogs` | 4,590 | Size{37,39,41}[size] x Color{Cream,Sage}[color] = 6 | 4: P,V:Cream,V:Sage,D; exact by Color | steady; Sage-41 SKU BDT 400 off | 0 |

### Home & Living — `home-living`

Category copy: “Thoughtful lighting, décor, and textiles that make compact
homes feel warmer, calmer, and more useful. Each object balances tactile
materials with proportions suited to apartments and everyday rooms.”

| # | Product / slug | BDT | Options and SKU count | Media and exact-SKU image rule | Inventory / offer / delivery | Additional sections |
| ---: | --- | ---: | --- | --- | --- | --- |
| 1 | Halo Arc Table Lamp / `halo-arc-table-lamp` | 2,490 | Finish{Matte,Gloss}[none] x Plug{EU,US}[none], omit Gloss/US = 3 | Replace the unapproved image/video, add an explicit poster and detail image, and let every SKU use the product-primary fallback; do not preserve a redundant exact assignment to the same featured image | Preserve live counts and Matte/EU 10% SKU offer | 3 |
| 2 | Mira Pleated Bedside Lamp / `mira-pleated-bedside-lamp` | 3,290 | Shade{Oat,Ink}[color] x Plug{EU,US}[none] = 4 | 4: P,V:Oat,V:Ink,D; exact by Shade | steady; no offer | 0 |
| 3 | Soma Handloom Cushion Cover / `soma-handloom-cushion-cover` | 1,290 | Size{45 cm,50 cm}[size] x Weave{Indigo,Clay}[pattern] = 4 | 4: P,V:Indigo,V:Clay,D; exact by Weave | deep; Indigo-45 SKU 10% | 2 |
| 4 | Noor Ceramic Vase / `noor-ceramic-vase` | 2,190 | simple = 1 | 4: P,D,D,L; fallback | simple; no offer | 0 |
| 5 | Jute Nest Storage Basket / `jute-nest-storage-basket` | 1,790 | Size{Small,Medium,Large}[size] = 3 | 3: P,D,L; fallback | deep; product BDT 250 off | 0 |
| 6 | Luma Ribbed Glass Lantern / `luma-ribbed-glass-lantern` | 2,690 | Glass{Clear,Amber}[color] = 2 | 4: P,V:Clear,V:Amber,L; exact by Glass | steady; no offer | 0 |
| 7 | Kori Oak Floating Shelf / `kori-oak-floating-shelf` | 3,990 | Length{60 cm,90 cm}[size] x Finish{Natural,Walnut}[color] = 4 | 5: P,V:Natural,V:Walnut,D,L; exact by Finish | steady; no offer; free | 3 |
| 8 | Dhara Cotton Throw / `dhara-cotton-throw` | 2,890 | Color{Sand,Indigo,Forest}[color] = 3 | 5: P,V:Sand,V:Indigo,V:Forest,D; exact by Color | deep; product 8% | 0 |
| 9 | Arka Round Wall Mirror / `arka-round-wall-mirror` | 7,490 | Diameter{60 cm,80 cm}[size] x Frame{Brass,Black}[color] = 4 | 5: P,V:Brass,V:Black,D,L; exact Brass rows, Black fallback | scarce; no offer; free | 3 |
| 10 | Terra Scented Candle Trio / `terra-scented-candle-trio` | 1,690 | Scent{Cedar,Citrus,Linen}[none] = 3 | 5: P,V:Cedar,V:Citrus,V:Linen,L; exact by Scent | steady; no offer | 0 |

### Bags & Carry — `bags-carry`

Category copy: “Clean, organized carry for commutes, errands, and short trips.
The collection favors quiet branding, repairable hardware, useful pockets, and
sizes that fit daily essentials without unnecessary bulk.”

| # | Product / slug | BDT | Options and SKU count | Media and exact-SKU image rule | Inventory / offer / delivery | Additional sections |
| ---: | --- | ---: | --- | --- | --- | --- |
| 1 | Transit Daypack 18L / `transit-daypack-18l` | 5,990 | Color{Moss,Black,Stone,Ochre}[color] = 4 | 6: P + four V + D; exact by Color | deep; Moss SKU 10%; free | 3 |
| 2 | Orin Commuter Tote / `orin-commuter-tote` | 4,490 | Canvas{Natural,Ink}[color] x Strap{Short,Long}[none] = 4 | 4: P,V:Natural,V:Ink,D; exact by Canvas | steady; no offer | 0 |
| 3 | Tidal Rolltop Backpack / `tidal-rolltop-backpack` | 7,990 | Capacity{20L,28L}[size] x Color{Navy,Black}[color] = 4 | 5: P,V:Navy,V:Black,D,L; exact by Color | scarce; no offer; free | 3 |
| 4 | Mini Crescent Crossbody / `mini-crescent-crossbody` | 2,790 | Color{Cocoa,Black,Sage,Rose}[color] = 4 | 6: P + four V + D; exact by Color | deep; product 8% | 0 |
| 5 | Field Canvas Messenger / `field-canvas-messenger` | 4,990 | Color{Khaki,Olive,Black}[color] = 3 | 5: P + three V + D; exact by Color | steady; no offer | 0 |
| 6 | Metro Tech Sleeve / `metro-tech-sleeve` | 2,190 | Device{13-inch,15-inch}[size] x Color{Graphite,Sand}[color] = 4 | 4: P,V:Graphite,V:Sand,D; exact by Color | steady; no offer | 2 |
| 7 | Weekender Duffel 35L / `weekender-duffel-35l` | 6,490 | Color{Olive,Navy,Black}[color] = 3 | 5: P + three V + L; exact by Color | scarce; no offer; free | 0 |
| 8 | Trail Belt Bag / `trail-belt-bag` | 2,390 | Color{Rust,Olive,Black,Stone}[color] = 4 | 6: P + four V + L; exact Rust/Olive, Black/Stone fallback | deep; no offer | 0 |
| 9 | Fold Market Tote Set / `fold-market-tote-set` | 1,190 | simple = 1 | 4: P,D,D,L; fallback | simple; product 12% | 0 |
| 10 | Passport Travel Wallet / `passport-travel-wallet` | 2,590 | Color{Tan,Forest,Black}[color] = 3 | 5: P + three V + D; exact by Color | steady; no offer | 0 |

### Kitchen & Table — `kitchen-table`

Category copy: “Reliable cookware, prep tools, storage, and tableware chosen
for daily meals rather than display-only kitchens. Materials, set contents, and
care guidance are stated clearly so buyers know exactly what arrives.”

| # | Product / slug | BDT | Options and SKU count | Media and exact-SKU image rule | Inventory / offer / delivery | Additional sections |
| ---: | --- | ---: | --- | --- | --- | --- |
| 1 | Kansa Serve Bowl / `kansa-serve-bowl` | 2,990 | Diameter{18 cm,24 cm,30 cm}[size] = 3 | 4: P,D,D,L; fallback | steady; no offer | 2 |
| 2 | Nori Chef Knife 8-inch / `nori-chef-knife-8-inch` | 4,790 | simple = 1 | 5: P,D,D,L,VID with poster; fallback | simple; no offer; free | 3 |
| 3 | Bela Acacia Chopping Board / `bela-acacia-chopping-board` | 2,290 | Size{Small,Medium,Large}[size] = 3 | 4: P,D,D,L; fallback | deep; no offer | 0 |
| 4 | Ripple Double-Wall Tumbler Pair / `ripple-double-wall-tumbler-pair` | 1,890 | Tint{Clear,Smoke,Amber}[color] = 3 | 5: P + three V + D; exact by Tint | steady; product BDT 200 off | 0 |
| 5 | Ember Pour-Over Kettle 1L / `ember-pour-over-kettle-1l` | 5,490 | Finish{Steel,Black}[color] = 2 | 4: P,V:Steel,V:Black,D; exact by Finish | scarce; no offer; free | 2 |
| 6 | Shada Stoneware Dinner Set / `shada-stoneware-dinner-set` | 8,990 | Setting{4-person,6-person}[size] x Glaze{Cloud,Ink}[color] = 4 | 5: P,V:Cloud,V:Ink,D,L; exact by Glaze | scarce; Cloud/4-person SKU 8%; free | 3 |
| 7 | Press Glass Storage Set / `press-glass-storage-set` | 2,490 | Set{3-piece,5-piece,8-piece}[size] = 3 | 4: P,D,D,L; fallback | deep; product 10% | 0 |
| 8 | Soma Cross-Back Linen Apron / `soma-cross-back-linen-apron` | 2,190 | Color{Oat,Clay,Forest}[color] = 3 | 5: P + three V + D; exact by Color | steady; no offer | 0 |
| 9 | Dhaka Spice Tin / `dhaka-spice-tin` | 3,790 | Insert{7-cup,12-cup}[size] = 2 | 4: P,V:7-cup,V:12-cup,D; exact by Insert | steady; no offer | 0 |
| 10 | Loop Silicone Utensil Set / `loop-silicone-utensil-set` | 1,690 | Color{Charcoal,Sage,Terracotta}[color] = 3 | 5: P + three V + D; exact by Color | deep; no offer | 0 |

### Desk & Mobile Tech — `desk-mobile-tech`

Category copy: “Compact power, input, audio, and desk accessories for hybrid
work and travel. Compatibility, port behavior, power limits, and included
cables are described plainly instead of hidden behind generic tech claims.”

| # | Product / slug | BDT | Options and SKU count | Media and exact-SKU image rule | Inventory / offer / delivery | Additional sections |
| ---: | --- | ---: | --- | --- | --- | --- |
| 1 | Orbit GaN Charger 65W / `orbit-gan-charger-65w` | 4,990 | Plug{EU,UK}[none] x Color{White,Black}[color] = 4 | 5: P,V:White,V:Black,D,L; exact by Color | scarce; no offer; free | 3 |
| 2 | Loom Braided USB-C Cable / `loom-braided-usb-c-cable` | 990 | Length{1 m,2 m}[size] x Color{Stone,Black}[color] = 4 | 4: P,V:Stone,V:Black,D; exact by Color | deep; product 10% | 0 |
| 3 | Frame Aluminum Laptop Stand / `frame-aluminum-laptop-stand` | 3,290 | Finish{Silver,Space Gray}[color] = 2 | 4: P,V:Silver,V:Space Gray,L; exact by Finish | steady; no offer | 0 |
| 4 | QuietKey Wireless Keyboard / `quietkey-wireless-keyboard` | 6,990 | Layout{US,UK}[none] x Color{Mist,Graphite}[color] = 4 | 5: P,V:Mist,V:Graphite,D,L; exact by Color | scarce; UK/Graphite SKU BDT 500 off; free | 3 |
| 5 | Pebble Silent Mouse / `pebble-silent-mouse` | 2,790 | Color{Mist,Graphite,Sage}[color] = 3 | 5: P + three V + D; exact by Color | deep; no offer | 0 |
| 6 | Beam Magnetic Desk Light / `beam-magnetic-desk-light` | 3,990 | Finish{White,Black}[color] = 2 | 4: P,V:White,V:Black,L; exact White, Black fallback | steady; no offer | 0 |
| 7 | Vault 10K Power Bank / `vault-10k-power-bank` | 4,490 | Color{White,Navy,Black}[color] = 3 | 5: P + three V + D; exact by Color | scarce; no offer; free | 2 |
| 8 | Dock 7-in-1 USB-C Hub / `dock-7-in-1-usb-c-hub` | 5,990 | simple = 1 | 5: P,D,D,L,VID with poster; fallback | simple; product 8%; free | 3 |
| 9 | Halo Magnetic Phone Stand / `halo-magnetic-phone-stand` | 2,490 | Finish{Silver,Black}[color] = 2 | 4: P,V:Silver,V:Black,L; exact by Finish | steady; no offer | 0 |
| 10 | Echo Mini Bluetooth Speaker / `echo-mini-bluetooth-speaker` | 3,790 | Color{Sand,Ocean,Black}[color] = 3 | 5: P + three V + D; exact by Color | deep; no offer | 0 |

## Approved main description copy

Descriptions are saved as semantic rich text (`<p>`, with occasional `<strong>`
or lists), never one giant heading and never keyword-stuffed filler. These are
the approved content facts; the manifest may add markup but must not invent
specifications beyond them.

### Footwear copy

1. **Rider Court Trainers.** A retro-inspired everyday trainer built for
   all-day comfort. Layered suede-look panels, a cushioned footbed, and a
   grippy rubber outsole balance clean street style with dependable wear from
   the commute to the weekend.
2. **Vale Everyday Runners.** A light daily runner for walking, commuting, and
   easy training. Breathable engineered mesh, a softly structured heel, and a
   flexible foam midsole keep the ride comfortable without a bulky profile.
3. **Monsoon Trail Sandals.** An open trail sandal tuned for warm, wet days.
   Three adjustable straps hold the foot securely, while the textured footbed
   and channelled rubber sole dry quickly after sudden rain.
4. **Nila City Loafers.** A softly structured loafer that moves from office
   trousers to weekend denim. The clean apron seam, padded heel, and flexible
   low-profile sole give a polished shape without the stiffness of formal
   footwear.
5. **Padma Knit Slip-Ons.** A breathable knit slip-on for errands, travel, and
   long standing days. The stretch collar is easy to step into, while the
   removable cushioned insole and flexible sole keep the pair light on foot.
6. **Dune Leather Slides.** A simple two-strap slide cut from smooth leather
   over a contoured footbed. The broad straps distribute pressure evenly, and
   the rubber base adds everyday grip indoors and out.
7. **Metro Low-Top Sneakers.** A clean low-top sneaker with a durable cupsole,
   padded collar, and easy-to-maintain upper. Its restrained paneling works
   across casual uniforms without looking like performance footwear.
8. **Rove Packable Flats.** A flexible ballet flat that folds into the included
   travel pouch without losing its shape. A cushioned heel pad and non-slip
   outsole make it a useful office, event, or cabin-bag backup.
9. **Ridge Chelsea Boots.** A weather-ready ankle boot with elastic side
   panels, a rear pull tab, and a lugged rubber outsole. The supportive footbed
   and rounded toe leave room for everyday socks while keeping a sharp profile.
10. **Aster Studio Clogs.** A roomy closed-toe clog for studio work, kitchens,
    and slow weekends. The washable upper, supportive molded footbed, and
    grippy sole are designed for easy, low-fuss wear.

### Home & Living copy

1. **Halo Arc Table Lamp.** A softly diffused table lamp for focused work and
   relaxed evenings. The compact arched silhouette fits neatly on desks,
   bedside tables, and shelves, while the available plug-and-finish
   combinations keep ordering clear.
2. **Mira Pleated Bedside Lamp.** A warm bedside lamp with a finely pleated
   fabric shade and compact ceramic base. It casts a gentle pool of light for
   reading and winding down without overpowering a small nightstand.
3. **Soma Handloom Cushion Cover.** A tactile handloom cushion cover with a
   quiet geometric weave and concealed zip. The cotton-rich face adds texture
   to a sofa or bed, while the plain reverse keeps the piece easy to layer.
4. **Noor Ceramic Vase.** A sculptural stoneware vase with a matte, softly
   speckled surface. Its narrow mouth supports a few stems neatly, and the
   balanced shape looks intentional even when left empty.
5. **Jute Nest Storage Basket.** A sturdy hand-braided jute basket for throws,
   toys, laundry, or entryway clutter. Integrated handles make it easy to move,
   and the three graduated sizes nest together when not in use.
6. **Luma Ribbed Glass Lantern.** A ribbed glass lantern that turns a small
   candle into softly patterned light. The heat-safe inner cup lifts out for
   cleaning, while the metal handle makes the lantern easy to reposition once
   cool.
7. **Kori Oak Floating Shelf.** A solid-wood floating shelf with a slim front
   edge and hidden mounting rail. It gives books, frames, and everyday objects
   a clean landing place without visible brackets.
8. **Dhara Cotton Throw.** A medium-weight cotton throw with a softly washed
   hand and fringed edge. It is breathable enough for an air-conditioned room
   yet substantial enough to add color and warmth at the end of a bed.
9. **Arka Round Wall Mirror.** A generous round mirror framed in slim metal for
   a light, architectural look. The deep lip adds definition without visual
   bulk, making it well suited to hallways, bedrooms, and compact vanities.
10. **Terra Scented Candle Trio.** Three small soy-wax candles blended for
    distinct moods: dry cedar, bright citrus, and clean linen. Each reusable
    glass cup has a cotton wick and a restrained scent throw for smaller rooms.

### Bags & Carry copy

1. **Transit Daypack 18L.** A compact commuter pack with a padded laptop sleeve,
   quick-access top pocket, and two bottle pockets that stay close to the bag.
   The structured back panel carries comfortably without turning an everyday
   load into a hiking pack.
2. **Orin Commuter Tote.** A zip-top canvas tote with enough structure for a
   laptop, notebook, bottle, and daily extras. Choose the short handles for
   hand carry or the longer strap for an easier shoulder drop.
3. **Tidal Rolltop Backpack.** A rolltop pack for wet commutes and flexible
   weekend loads. Coated fabric, sealed high-wear seams, and a side laptop
   access zip protect the essentials while the expandable top adds spare room.
4. **Mini Crescent Crossbody.** A compact crescent bag that follows the body
   without feeling rigid. The wide adjustable strap, smooth two-way zip, and
   divided interior keep phone, wallet, keys, and small extras in easy reach.
5. **Field Canvas Messenger.** A durable cotton-canvas messenger with a padded
   device divider and two organization pockets under the flap. Metal hardware
   and a replaceable webbing strap are chosen for long everyday use.
6. **Metro Tech Sleeve.** A lightly padded laptop sleeve with a soft lining and
   an external pocket for a charger, cable, and slim notebook. The water-
   resistant outer fabric protects against daily scuffs and brief rain.
7. **Weekender Duffel 35L.** A cabin-friendly duffel with a wide opening,
   separate shoe pocket, and removable shoulder strap. Its 35-litre shape packs
   for a short trip without becoming awkward on buses or overhead racks.
8. **Trail Belt Bag.** A low-profile belt bag with two zipped compartments and
   a breathable back panel. Wear it at the waist or across the chest for hands-
   free errands, travel days, and short walks.
9. **Fold Market Tote Set.** Three lightweight reusable totes that fold into
   their own attached pockets. Reinforced handles and broad gussets make them
   useful for groceries, books, or an unexpected extra carry.
10. **Passport Travel Wallet.** A slim travel wallet with space for two
    passports, boarding cards, currency, and six cards. The full zip keeps
    documents together while a concealed pocket separates emergency cash.

### Kitchen & Table copy

1. **Kansa Serve Bowl.** A warm-toned metal serving bowl with a gently hammered
   exterior and smooth food-contact surface. The graduated sizes move easily
   from snacks and sides to salads and shared rice dishes.
2. **Nori Chef Knife 8-inch.** A balanced 8-inch chef's knife for slicing,
   chopping, and everyday prep. The full-tang handle offers a secure grip, while
   the fine plain edge is straightforward to hone and sharpen at home.
3. **Bela Acacia Chopping Board.** A reversible acacia board with a juice groove
   on one side and a clean flat surface on the other. Rounded edges and an
   integrated handhold make the solid board easier to lift and store.
4. **Ripple Double-Wall Tumbler Pair.** Two ribbed double-wall glasses that keep
   hot or cold drinks comfortable to hold. The lightweight shape stacks neatly
   in the hand, and the tinted options add quiet color without printed motifs.
5. **Ember Pour-Over Kettle 1L.** A stainless-steel gooseneck kettle shaped for
   a controlled, even pour. The balanced handle, clear fill marks, and one-litre
   capacity work well for pour-over coffee and precise tea preparation.
6. **Shada Stoneware Dinner Set.** A coordinated stoneware set with softly
   irregular rims and a durable satin glaze. Choose the four- or six-person set
   in Cloud or Ink for an everyday table that still feels considered.
7. **Press Glass Storage Set.** Stackable borosilicate glass containers with
   locking lids and replaceable silicone seals. The clear bases move from
   refrigerator to microwave and table without hiding what is inside.
8. **Soma Cross-Back Linen Apron.** A washed linen-blend apron with broad cross-
   back straps that distribute weight without a neck tie. Two deep front
   pockets hold a towel, phone, or small tools while cooking or making.
9. **Dhaka Spice Tin.** A stainless-steel spice box with removable inner cups,
   a fitted lid, and a small measuring spoon. Choose seven or twelve cups to
   keep frequently used spices visible and close at hand.
10. **Loop Silicone Utensil Set.** A coordinated set of heat-resistant silicone
    tools with firm internal cores and comfortable handles. The pieces are
    gentle on coated cookware and stand together in the included draining cup.

### Desk & Mobile Tech copy

1. **Orbit GaN Charger 65W.** A compact 65-watt wall charger with two USB-C
   ports and one USB-A port for a laptop, phone, and accessory. Power is shared
   intelligently across connected devices, and the selected plug is fixed and
   clearly shown before checkout.
2. **Loom Braided USB-C Cable.** A soft-touch braided USB-C to USB-C cable rated
   for charging and everyday data transfer. Reinforced strain relief and two
   useful lengths make it easy to keep one at a desk and one in a bag.
3. **Frame Aluminum Laptop Stand.** A ventilated aluminum stand that raises a
   laptop screen and opens desk space beneath it. Silicone contact pads protect
   the device, while the folded profile slips into a work bag.
4. **QuietKey Wireless Keyboard.** A low-profile wireless keyboard with quiet
   scissor switches, multi-device pairing, and a compact layout that retains a
   full function row. Choose the printed key layout and color explicitly before
   adding it to the cart.
5. **Pebble Silent Mouse.** A compact wireless mouse with quiet clicks, a smooth
   scroll wheel, and an ambidextrous shape. Bluetooth and the included receiver
   offer flexible pairing across a desk, laptop bag, or shared workspace.
6. **Beam Magnetic Desk Light.** A slim rechargeable light bar that attaches to
   its weighted stand magnetically. Rotate the head for task or ambient light,
   then use the stepped touch control to adjust warmth and brightness.
7. **Vault 10K Power Bank.** A 10,000 mAh travel battery with USB-C input/output,
   one USB-A port, and a clear remaining-charge display. Its flat edges pack
   neatly beside a phone without the bulk of a high-capacity brick.
8. **Dock 7-in-1 USB-C Hub.** A compact hub that adds HDMI, two USB-A ports,
   USB-C power pass-through, SD, microSD, and gigabit Ethernet to a compatible
   USB-C computer. Port labels are visible and the attached cable folds into
   the body for travel.
9. **Halo Magnetic Phone Stand.** A weighted aluminum phone stand with a
   magnetic head, adjustable viewing angle, and cable pass-through. It keeps a
   compatible phone visible for calls and charging without crowding the desk.
10. **Echo Mini Bluetooth Speaker.** A palm-sized speaker with a fabric wrap,
    simple top controls, and a rubber base that stays put. It is tuned for clear
    speech and balanced casual listening in a bedroom, kitchen, or small group.

## Ordered additional-information content

These sections are deliberate progressive disclosure, not repeated marketing
copy. The manifest stores stable logical IDs, titles, HTML content, and dense
zero-based `sortOrder`; the API owns the persisted `prc_...` IDs.

| Product | Ordered sections and content brief |
| --- | --- |
| Rider Court Trainers | **Fit & sizing:** regular fit; choose the usual EU size, with measured foot guidance. **Materials & care:** upper/outsole facts and spot-clean instructions. **Delivery & returns:** unworn try-on and original-box guidance matching the configured policy. |
| Vale Everyday Runners | **Ride & use:** daily walking/easy training, not a technical race shoe. **Fit guide:** toe room, socks, and measured-foot steps. |
| Monsoon Trail Sandals | **Adjusting the straps:** heel, forefoot, and instep sequence. **After wet wear:** rinse, air-dry, and no direct heat. |
| Ridge Chelsea Boots | **Fit & socks:** rounded toe and medium-weight sock guidance. **Weather care:** clean/dry/condition sequence; no waterproof claim. |
| Halo Arc Table Lamp | **Light & setup:** bulb/socket, warm-light intent, plug selection. **Dimensions & placement:** footprint, cord, and indoor clearance. **Care & safety:** dry-cloth cleaning and unplug-before-care guidance. |
| Soma Handloom Cushion Cover | **What is included:** cover only, insert excluded. **Textile care:** cold gentle wash, reshape, shade dry, and natural weave variation. |
| Kori Oak Floating Shelf | **Installation:** wall-type-aware fixings and two-person setup for 90 cm. **Load & materials:** evenly distributed decorative load, no universal load promise. **In the box:** shelf, concealed rail, standard fixings, and guide. |
| Arka Round Wall Mirror | **Measure before ordering:** finished diameters and wall clearance. **Hanging:** two-person install and wall-appropriate anchor note. **Care:** glass and powder-coated frame cleaning. |
| Transit Daypack 18L | **Organization:** laptop sleeve, bottle pockets, and quick-access pocket. **Fit & carry:** strap and sternum adjustment. **Fabric care:** spot clean and air dry. |
| Tidal Rolltop Backpack | **Weather resistance:** brief-rain protection without a submersion/waterproof claim. **Capacity guide:** 20L day load versus 28L short-trip load. **Laptop access:** supported device envelope and packing order. |
| Metro Tech Sleeve | **Device fit:** measure the device rather than relying only on screen diagonal. **Care:** spot clean, keep zips clear, and dry before storing. |
| Kansa Serve Bowl | **Size guide:** diameter/capacity/use examples. **Care:** hand wash, dry promptly, and natural patina note. |
| Nori Chef Knife 8-inch | **Steel & edge care:** hone, sharpen, hand wash, and dry immediately. **Safe handling:** stable board, claw grip, and storage guidance. **In the box:** knife and reusable blade guard. |
| Ember Pour-Over Kettle 1L | **Pour control:** fill line, grip, and low-flow technique. **Use & care:** compatible heat sources as photographed/verified, descaling, and dry storage. |
| Shada Stoneware Dinner Set | **What is included:** exact piece counts for four- and six-person sets. **Glaze character:** acceptable handcrafted variation versus damage. **Care:** dishwasher/microwave truth only after source verification. |
| Orbit GaN Charger 65W | **Port output guide:** single- and multi-port allocation. **Compatibility:** USB Power Delivery devices/cable requirements; no universal fast-charge promise. **Safety:** ventilation and damaged-cable guidance without invented certifications. |
| QuietKey Wireless Keyboard | **Layout & pairing:** visible US/UK differences and three-device switching. **Battery & charging:** truthful runtime only after asset/spec verification. **Care:** keycap and surface cleaning. |
| Vault 10K Power Bank | **Charging guide:** input/output ports and included cable. **Travel & storage:** airline rules are buyer responsibility; protect terminals and avoid heat. |
| Dock 7-in-1 USB-C Hub | **Ports & displays:** exact port list and tested maximum output. **Compatibility:** host USB-C requirements and OS notes. **Power pass-through:** charger/cable sold separately unless the final pack says otherwise. |

## Attributes, collections, and presentation

Create the reusable `Brand` attribute first, make it filterable, and assign the
fictional house label shown in the category table to every product. Create
filterable `Material` and `Best for` definitions only after the curated values
are normalized; do not create a new preset for every sentence. Create
non-filterable `Care` and `Warranty` facts only when the saved value is concise
and truthful. Product option values remain SKU choices and must not be copied
into delimited attribute strings.

Create these collections after product IDs are known:

| Collection | Source / presentation | Membership |
| --- | --- | --- |
| New & Noteworthy | manual / carousel / 12 | two or three launch products from every category, explicit merchant order |
| Everyday Carry | dynamic / grid / 8 | Bags & Carry + Desk & Mobile Tech |
| Home Refresh | dynamic / grid / 8 | Home & Living + Kitchen & Table |
| Weekend Ready | manual / carousel / 8 | Rider, Monsoon, Rove, Transit, Tidal, Weekender, Vault, Echo |
| Offers Worth Opening | manual / grid / 12 | only products with a current product- or SKU-level offer; update the list when offers change |

Homepage order is one primary hero, New & Noteworthy, a five-category rail,
Everyday Carry, Home Refresh, and a restrained trust/policy strip. Do not render
all five collections as equal visual blocks.

Create three hero stories with distinct desktop and mobile assets:

| Story | Copy | Destination | Desktop master | Mobile master |
| --- | --- | --- | --- | --- |
| The Everyday Edit | “Useful things, considered well.” | New & Noteworthy collection | 2400x900 WebP, subject in center 60% | 1080x1350 WebP, subject in upper-middle 70% |
| A softer home | “Light, texture, and room to breathe.” | Home & Living category | 2400x900 WebP, copy-safe left third | 1080x1350 WebP, copy-safe top quarter |
| Carry the day | “Commute-ready bags without the bulk.” | Bags & Carry category | 2400x900 WebP, copy-safe right third | 1080x1350 WebP, copy-safe top quarter |

Keep the current verified social-link set only when each URL resolves to an
owned Scalius profile. Labels must be nonblank and URLs explicit HTTPS (or a
valid `https://wa.me/...` WhatsApp destination). Do not fabricate Instagram,
TikTok, Facebook, X, YouTube, LinkedIn, GitHub, or WhatsApp handles just to fill
the footer. Four real links are better than seven dead ones.

## Media acquisition and image-quality contract

Product-specific variant series should be original, unbranded images generated
as a consistent set, or merchant-owned photography. The prompt/shot sheet must
hold the product form, camera angle, background, and light constant while only
the named option changes. This prevents a “Sand” SKU from switching to a
visibly different shoe, bag, or device.

Public/free sources have narrower roles:

- [Pexels permits use in websites and ecommerce shops](https://www.pexels.com/license/)
  and permits modification, so it is suitable for manually curated lifestyle
  and hero backgrounds. Record source page, photographer, download date, and
  license even though attribution is not required. Do not imply endorsement by
  a visible person or brand, do not sell the stock image itself, and do not
  scrape or bulk-copy the library.
- Openverse may locate CC0, Public Domain Mark, or CC BY detail/lifestyle
  images. The importer must retain the upstream work URL, creator, exact
  license/version, and required attribution. Search-result metadata is not
  enough; verify the original host before use.
- DummyJSON or another fake-store API may inspire neutral dimensions or
  taxonomy during drafting, but its images and product claims are not approved
  assets unless their rights and source are independently verified. Never copy
  brand names, reviews, ratings, barcodes, certifications, or regulated claims.

Every asset has a manifest record with `logicalKey`, source kind, upstream URL
or generation prompt, creator, license, downloaded/generated date, SHA-256,
original dimensions, staged dimensions, alt text, caption, and intended crop.
Reject visible logos, watermarks, copyrighted characters, misleading
certification marks, inconsistent option colors, and identifiable people who
could appear to endorse the fictional product.

Prepare product masters locally with the existing `sharp` dependency before
upload rather than storing huge originals and paying to resize every admin
view. Product masters are 1600x1600 WebP, sRGB, normally 150–450 KB, with the
entire object inside an 80% safe area. Detail/lifestyle images may crop, but the
primary and variant images must not. Category masters are 1600x1000 WebP.
Hero and mobile-hero sizes are specified above. The transparent wordmark is a
wide PNG/WebP with generous side padding; the favicon is a separate square
512x512 asset. Logos always use `contain`, product primary/variant previews use
`contain`, and lifestyle/category/hero art may use `cover` only in a
ratio-matched slot.

Cloudflare transformations are delivery derivatives, not a second media
authority. Use a small named set of widths per surface, preserve intrinsic
aspect ratio unless the component deliberately owns a crop, and never chain a
`/cdn-cgi/image/` URL through another transform. During browser QA, compare the
R2 original and transformed request, confirm cache hits, inspect crop/focal
behavior, and record every surface that asks Cloudflare for a transform larger
than its rendered slot.

## API-safe, resumable import workflow

The implementation should add a checked-in declarative manifest and a
purpose-built command, for example `scripts/demo-store-seed.mjs`, but the
command must remain an admin API client, not an alternate domain service.
Shopify, Medusa, and Vendure all model bulk product import around product and
variant rows plus media. Shopify's CSV warnings show how partial columns and
image URLs can unexpectedly detach or duplicate data; Medusa updates by
variant rows; Vendure supports product/variant assets and stock in its import
format. Scalius should keep the useful manifest idea while sending complete,
validated domain commands through its existing APIs instead of adding a
validation-skipping fast importer:

- [Shopify product CSV behavior and image handling](https://help.shopify.com/en/manual/products/import-export/using-csv)
- [Medusa product import model](https://docs.medusajs.com/user-guide/products/import)
- [Vendure product/variant/asset import format](https://docs.vendure.io/current/core/developer-guide/importing-data)

### 1. Plan and authenticate

1. `--plan` validates the manifest without network writes and prints exact
   category, product, SKU, media, additional-section, collection, and active
   offer counts. It fails unless the contract is `5 / 50 / 177` and every
   variant combination, SKU, slug, media slot, alt text, and price is unique.
2. The command asks for the admin password through hidden terminal input and
   posts email/password as JSON to `/api/auth/sign-in/email`. It reuses
   `scripts/admin-session-cookie.mjs` to build a short-lived Cookie header.
   Credentials never enter a URL, command argument, committed file, log, or
   shell history.
3. Read the authenticated session and required permissions before any write.
   A 401/403 stops the run; it must not fall back to a direct Worker binding or
   database mutation.
4. Export current admin API projections to a timestamped local evidence folder
   ignored by Git: categories, products/details, media filenames, attributes,
   collections, theme revisions, header/footer, and hero revisions. This is a
   recovery reference, not an alternate restore database.

### 2. Resolve and upload media

1. Create/reuse one Media folder per category plus `Demo / Brand` and
   `Demo / Hero`. Resolve by exact normalized folder name and fail closed if
   duplicates make the target ambiguous.
2. Stage and validate source bytes locally. Accept only the current platform
   MIME policy (JPEG/PNG/GIF/WebP/AVIF up to 20 MiB; MP4/WebM up to 100 MiB),
   but keep normal staged images far below the maximum.
3. List Media with stable cursor pagination. Reuse an exact ready asset only
   when filename, size, MIME, dimensions, and manifest SHA-256/source record
   agree. Do not assume that a matching filename means matching bytes.
4. Upload new bytes through `POST /api/v1/admin/media/uploads`, sequential
   5 MiB `PUT .../parts/{n}` requests, and `POST .../complete`. Limit the seed
   to two active asset sessions and one part per session at a time. Patch alt,
   caption, dimensions, duration, poster, and folder with the returned Media
   version. Abort failed sessions; a rerun reconciles or starts a fresh session.
5. Upload video posters as ordinary image assets first, then set the video's
   `posterMediaId`. A poster is not automatically an SKU-selectable product
   image unless it is also attached to that product as an image association.

### 3. Reconcile vocabulary and categories

1. Create/reuse attribute definitions by normalized slug. Never infer a
   collision by display name alone, never update trash, and never create
   delimited multi-values.
2. Reuse Footwear and Home & Living by their current IDs. Create the remaining
   three categories through `POST /api/v1/admin/categories`; new categories
   start as drafts. Reconcile copy, image, SEO, canonical path, and discovery
   flags with `expectedRevision`.
3. Never delete the protected Shoes category or retained audit products in
   trash. Other active categories/products outside this manifest are moved to
   trash only after a dry-run report names them and confirms they have no
   retention boundary. Permanent deletion is a separate explicit command.

### 4. Reconcile products through complete commands

For a new product, build the complete `POST /api/v1/admin/products` payload:
base fields, ordered media associations, attributes, additional information,
and (for 46 products) the entire normalized option matrix. Draft option/value
IDs exist only inside the request; product-media association IDs are stable
within the request so exact SKU image references are valid at create time.
The command creates products inactive first.

For an existing product, resolve by exact slug, then GET its complete admin
detail and revision. Preserve existing association, option, value, and SKU IDs.
Send the full base/media/content update with `expectedAggregateRevision`, then
send the complete option matrix with the newly returned revision. On 409,
refetch and produce a field-level conflict report; never blind-retry or replace
the merchant's newer state. Media removal conflicts require the existing
explicit SKU-image acknowledgement flow.

New simple products omit `optionMatrix`, producing exactly one protected
default SKU. GET the created product and update that SKU through
`PUT /api/v1/admin/products/{productId}/variants/{variantId}` with empty
`selectedOptionValueIds`, its current aggregate revision, a human SKU, tracked
stock, and the server-generated barcode retained. Do not manipulate stock in a
plain product update or raw SQL.

New optioned products submit initial stock in the create matrix, which writes
ledger-v2 stocktake movements and stock-version edges in the same product
batch. Retained Rider/Halo stock and reservations are adopted from the live
read, not reset from a profile. Every new barcode left unspecified is allowed
to use the platform-generated internal Code 128 identity.

After all ten products in a category are media- and SKU-ready, activate them
through revision-aware product updates. New categories need one eligible
active product before the publication readiness check can pass; publish the
category immediately after that check, then activate the remaining nine in a
short, logged sequence. The run is performed in the demo store's maintenance
window because publication is intentionally per-resource rather than one
catalog-wide transaction.

### 5. Collections, theme, navigation, and hero

Resolve the final product/category IDs and create or update the five collections
through their versioned admin API. Save category navigation, collection links,
header/footer branding, real social links, and the three hero stories through
their existing admin/revision APIs. Do not call raw settings tables. A rerun
must preserve collection/manual product order and reject a stale theme, header,
footer, or hero revision instead of overwriting it.

### 6. Merchant and buyer verification

Use the importer for scale, then exercise representative workflows in the
authenticated admin and storefront rather than treating a successful HTTP 201
as completion:

1. Desktop and smartphone admin: category list/edit/publish, product list,
   simple product edit, two-axis product edit, intentionally omitted
   combination, partial SKU image fallback, all-SKU exact image assignment,
   media upload/reorder/poster, additional-section collapse behavior,
   inventory search/adjustment/movement, collection create/edit/order, and
   theme/header/footer/hero changes.
2. Storefront desktop and mobile: homepage hero sources and crops, category
   grids, filters for Brand/Material, search, collection pages, 12 product
   pages across all categories, every option axis, sold-out SKU, low-stock SKU,
   product-level discount, percentage SKU discount, flat SKU discount, exact
   SKU image, null-to-primary fallback, video/poster, sticky description tabs,
   cart, COD checkout, account/guest receipt, and admin order/inventory state.
3. Discovery: product sitemap has exactly 50 active product URLs; category
   sitemap has the five published categories; Google/Meta feeds omit no eligible
   product and emit SKU rows/standard mappings/brand/price/availability
   accurately; UCP search and lookup resolve samples from every category;
   Product/ProductGroup/Breadcrumb/CollectionPage JSON-LD matches the same
   SKU, brand, option, image, and price facts.
4. Media economics: record original and transformed response dimensions,
   byte sizes, cache status, and rendered CSS box for hero, logo, category,
   product primary, SKU image, card, cart, receipt, and admin thumbnail. Fix the
   owning component when a crop is wrong; do not distort the source image to
   conceal a bad transform.
5. Run focused tests for any defects found, then sequential package typechecks,
   SDK generation only if contracts changed, environment check, deployment,
   `pnpm ops:check --queues`, and `pnpm release:check`. Never overlap workspace
   typechecks or deployments on the 16 GB host.

## Failure and resume rules

- The manifest is intent; current API state plus revisions is authority. Each
  successful operation appends a non-secret JSONL result with logical key,
  resource ID, old/new revision, and timestamp. Receipt proofs, credentials,
  buyer PII, raw provider payloads, and cookies are never logged.
- Resume starts with a fresh authenticated read and recomputes the diff. It does
  not replay already-matching writes, duplicate media, reset stock, or assume a
  previous response committed when the follow-up read disagrees.
- HTTP 409 is a real merchant conflict. Stop that resource, continue only
  independent resources, and report a bounded actionable diff.
- HTTP 429/5xx uses bounded exponential backoff for read/idempotent operations.
  A timed-out non-idempotent create is resolved by exact slug/folder/filename
  read before any retry.
- A product is never activated until its own media, price, SKU topology,
  inventory, copy, and discovery readiness checks pass. One malformed product
  must not force partially valid data into another product.
- `LIVE-DEMO-RUN.md` is updated only with the actual final IDs, counts, orders,
  inventory evidence, deployment versions, and any intentionally retained
  deviation from this blueprint.
