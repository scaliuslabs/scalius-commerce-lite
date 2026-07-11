# Catalog Admin Audit

Last reviewed: 2026-07-12

## P0/P1 findings

1. **Resolved in batch 1: base currency is locked after money-bearing catalog/order data exists.** Currency fields validate strictly and commit atomically; symbol/rate corrections remain possible.
2. **Resolved in batch 1: collection drag reorder is disabled unless the complete ordered set is loaded.** Paginated slices cannot be renumbered as global order.
3. **Resolved in batch 2: attribute values have authoritative server search, pagination, global/search totals, and complete preset reconciliation.** Normalized duplicates and rename collisions fail closed.
4. **Resolved in batches 1–2: catalog query failures render retryable error state and disable authority-dependent mutations.** They no longer masquerade as empty data.
5. **Resolved in batch 2 against the current API permission map: one capability model gates catalog and inventory actions.** Dedicated permissions for a few permanent/bulk actions remain a backend RBAC design gap.
6. **Resolved in batch 3: the option spreadsheet uses one atomic mixed variant edit plan.** Failed plans preserve drafts and show actionable inline error; successful plans reconcile authoritative returned rows.
7. **Variant image configuration is tied to SEO and array position.** The form stores an HTML marker in `metaDescription` and maps options to images by array index. Persist explicit stable media associations.
8. **Resolved in batch 3: collection product picker is one debounced, cancellable, paginated multi-category server query.** Loading, empty, failure, retry, and load-more are distinct; selected labels survive page/search changes.
9. **Inventory hides operational deficits and allows false reason/sign pairs.** Admin clamps negative availability to zero, and accepts combinations such as positive “damage” or negative “stock received.” Show signed deficit and constrain reason by direction or use an absolute stocktake mode.
10. **Resolved in batch 2: single and bulk category permanent deletion share one atomic cleanup primitive.** Malformed collection config blocks deletion instead of leaving dangling references.
11. **Resolved in batch 2: detail loaders redirect only on typed 404.** Permission, conflict, timeout, and upstream failure reach the route error boundary.
12. **Resolved in batch 2: option add/edit/bulk drafts participate in navigation protection.**
13. **Resolved in batch 2: competing form actions are inert while save is in flight.**
14. **Destructive confirmation is inconsistent.** Collection and attribute delete/permanent-delete paths can execute immediately while products/categories confirm. Permanent delete requires a consistent impact summary and confirmation.

## P2 workflow and UI findings

- New products and collections now default Draft; a shared activation-readiness gate remains open.
- Product, category, and collection create/edit shells now expose compact visible page headings and workflow context.
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
