# Catalog Admin Audit

Last reviewed: 2026-07-12

## P0/P1 findings

1. **Currency changes reinterpret the live catalog.** `CurrencySettingsBuilder.tsx` permits a normal ISO-code change, while `site-settings.service.ts` only updates settings and does not convert product, variant, shipping, discount, or tax amounts. Invalid exchange rates can be silently ignored while other fields save. Block code changes after money-bearing data exists unless an explicit migration exists; validate and write atomically.
2. **Paginated collection reorder corrupts global order.** `admin/collections/index.tsx` renumbers only the current page to `0..N`; `collections.service.ts` persists those values blindly. Use an anchor/full-set reorder contract; immediately disable drag unless the complete ordered set is loaded.
3. **Attribute values after the first 20 are unmanageable.** `AttributeValueEditor` and `AttributeValuesViewer` ignore server pagination and search only the first page. The service also merges presets against only the current page, duplicating values and totals.
4. **Catalog query failures look empty or stale.** Products, Categories, Attributes, Collections, sortable tables, and Inventory discard query errors/refetch controls. Show explicit retry/stale states and disable mutations when authority is unavailable.
5. **UI capabilities do not match API RBAC.** View-only routes expose create, edit, toggle, delete, restore, permanent delete, reorder, and stock-adjust actions that later fail at the API. Gate every action from a shared catalog capability model.
6. **Variant bulk save is non-atomic and unsafe to retry.** The UI creates rows and then updates existing rows in two calls; a failure leaves successful creates marked as drafts. Use one atomic edit-plan endpoint or reconcile returned IDs and row-level failures.
7. **Variant image configuration is tied to SEO and array position.** The form stores an HTML marker in `metaDescription` and maps options to images by array index. Persist explicit stable media associations.
8. **Collection product picker is truncated and racy.** It makes one request per category, reads only the first 50, has no request sequencing, and converts errors into “No products found.” Replace with one paginated multi-category server search.
9. **Inventory hides operational deficits and allows false reason/sign pairs.** Admin clamps negative availability to zero, and accepts combinations such as positive “damage” or negative “stock received.” Show signed deficit and constrain reason by direction or use an absolute stocktake mode.
10. **Single category hard delete leaves dangling collection config.** Single and bulk permanent deletion use different cleanup rules. Route both through one impact-aware primitive.
11. **Detail loaders collapse operational failures into redirects.** Product/category/collection detail loaders redirect on 401/403/500/timeout as if the row was absent. Only typed 404 should redirect/not-found.
12. **Variant drafts bypass the page unsaved-change guard.** Variant local state is not part of React Hook Form dirty state.
13. **Form action links remain navigable during save.** A disabled Button wrapping a link does not disable the anchor; competing actions can leave during an in-flight save.
14. **Destructive confirmation is inconsistent.** Collection and attribute delete/permanent-delete paths can execute immediately while products/categories confirm. Permanent delete requires a consistent impact summary and confirmation.

## P2 workflow and UI findings

- New products and collections default Active before buyer readiness is proven. Activation should require a shared readiness summary: resolvable SKU, positive effective price, media policy, category/content, and discovery outcome.
- Product/category/collection create forms have no visible page-level `h1`; breadcrumbs alone are insufficient context.
- Product detail omits flat discount, condition, feed/discovery state, and merchant option labels; it can render the internal variant-image marker and currently double-converts timestamps.
- Product names in the main table are not semantic links; several icon controls have no accessible names; inventory tabs lack tab semantics; loading overlays lack `aria-busy`/live status.
- Mobile product management keeps the desktop table and clips category, price, variants, and actions horizontally without a clear scroll affordance. Use a compact mobile row/card projection while preserving desktop density.
- General Settings contains thirteen in-memory tabs with no stable URLs. Currency, SEO/discovery, media, scanner, and other major areas need route-backed, permission-aware navigation.
- Inventory lacks alert acknowledgement, movement filters, actor/order links, date range, export, and explicit stocktake mode despite backend concepts already existing.
- Collection form copy says categories and products combine, while runtime product IDs take precedence. Show an exact resolvable preview and make `manual` versus `dynamic` behavior real.

## Interaction grammar

- One action name from button through toast: “Save changes” → “Changes saved.”
- One failure grammar: preserve inputs, state what failed, give Retry, and never replace an outage with an empty state.
- One destructive grammar: impact summary, reversible trash by default, typed confirmation for permanent deletion.
- One table grammar: URL-backed search/filter/sort/page, named controls, keyboard row navigation, selection-scoped bulk bar, visible stale/loading state.
- One edit grammar: explicit dirty state, CAS conflict response, reload/merge guidance, all competing navigation inert during save.
