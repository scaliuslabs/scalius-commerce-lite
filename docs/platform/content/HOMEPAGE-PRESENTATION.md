# Homepage presentation

Last reviewed: 2026-07-19

## Decision

Homepage composition is a bounded, revisioned presentation document. It is not
hardcoded from every published resource, distributed across category rows, or
embedded in semantic Theme settings.

The release document owns only:

- an optional, ordered category rail with a merchant heading and at most twelve
  exact category IDs;
- an optional delivery/returns strip whose visible copy is derived from live
  shipping-method and return-policy authorities.

Hero stories remain owned by the revisioned Hero workspace. Collection
publication and homepage inclusion remain owned by collection configuration and
sort order. The semantic Theme document continues to own typography, color,
shape, density, and component style rather than merchandising content. This
keeps one authority per fact and prevents a later page builder from having to
reconcile several competing homepage flags.

The initial storefront order is deliberately constrained:

1. hero;
2. first homepage collection;
3. category rail;
4. remaining homepage collections;
5. delivery/returns strip.

The category rail and trust strip can be disabled independently. Missing,
draft, internal, trashed, or deleted categories stay absent from the public
projection without taking down the page. A configured policy strip omits facts
that are not backed by an active shipping method or enabled valid return
policy. Merchants cannot type unsupported trust claims into this surface.

## Competitive evidence

Shopify JSON templates store unique section instances plus an explicit order;
the theme editor can add, remove, disable, and reorder those sections. Section
schemas bound the available settings and blocks. That separation between a
resource and its placement is the architectural formula Scalius adopts, not a
reason to recreate Shopify's theme runtime before the stable release.

- [Shopify JSON templates](https://shopify.dev/docs/storefronts/themes/architecture/templates/json-templates)
  define the saved sections/order document and bound templates to 25 sections.
- [Shopify sections and blocks](https://help.shopify.com/en/manual/online-store/themes/theme-structure/sections-and-blocks)
  exposes merchant add/reorder/hide operations with a live theme preview.
- [Shopify Shop Store customization](https://help.shopify.com/en/manual/online-sales-channels/shop/manage-shop-store/customize/shop-store)
  keeps the collection list's membership, heading, cover art, and order as an
  explicit home presentation decision rather than treating every collection as
  a homepage section.

Medusa, Vendure, and Saleor remain useful catalog/domain references but their
headless storefronts do not provide a stronger core homepage-composer contract
to copy. Scalius therefore keeps a platform-owned, resource-referencing
document while avoiding a freeform canvas, arbitrary HTML, or theme-specific
serialized component props.

## Storage and concurrency

`site_settings.homepage_config` stores the normalized JSON document and
`homepage_config_revision` is its monotonic compare-and-swap authority. New
stores and migrated stores start with both modules disabled. Saves require the
current revision and return `409 HOMEPAGE_PRESENTATION_REVISION_CONFLICT` on a
stale write; the admin then reloads rather than silently overwriting another
session.

The shared parser:

- defaults malformed or missing JSON to disabled modules;
- trims and bounds heading copy;
- trims, deduplicates, and preserves the exact category order;
- caps the category rail at twelve IDs.

The API save invalidates the homepage API and storefront HTML cache group. It
does not invalidate layout, discovery, product, or checkout families because
the saved document changes only homepage composition.

## Admin interaction

General Settings → Storefront keeps Store URL and Homepage as separate compact
authorities on one URL-addressable surface. The homepage editor shows:

- one enable switch and heading for the category rail;
- the selected categories as visible, keyboard-sortable rows;
- the shared searchable selector for adding categories;
- a status badge for saved draft/internal categories;
- one enable switch for the derived delivery/returns strip;
- saved revision, dirty state, and one Save homepage action.

The editor explains the fixed placement once. It does not repeat paragraphs
inside every row or expose meaningless style controls already owned by Theme.

## Storefront rendering

The public homepage endpoint reads SEO, hero, collections, public category
metadata, one active-shipping readiness row, and the saved return-policy row in
the first bounded D1 batch. Selected category IDs are resolved in saved order
against published non-trashed rows. Collection products remain resolved through
the existing buyer-resolvable batched projection.

The category rail uses five cards on wide screens and a compact horizontal snap
rail on narrow screens. Category images use an intentional center-cover
transform because the card is a merchandising crop; the link keeps the exact
saved category/canonical route. The delivery/returns strip uses restrained
two-column facts and never fabricates free delivery, free returns, a return
window, payment readiness, or certifications.

## Extension boundary

A future page builder should generalize this document into ordered typed
modules, not add more unrelated booleans to catalog rows. It must preserve:

- stable module IDs and explicit order;
- schema-bounded settings per module type;
- exact resource references rather than copied names/URLs;
- draft/publish/history/preview if arbitrary composition is introduced;
- public eligibility filtering and fail-closed parsing;
- dependency-aware cache invalidation.

Do not add arbitrary rich text, custom HTML, nested freeform blocks, market
overrides, or product-page composition to this initial document. Those require
their own preview, versioning, validation, and migration contract.
