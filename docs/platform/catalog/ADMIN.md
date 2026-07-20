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
9. **Resolved in the inventory/settings slice: inventory exposes exact signed truth.** The admin no longer clamps adjustments or availability, reason choices follow direction, and an explicit physical stocktake mode warns when the count exposes a reservation deficit.
10. **Resolved in batch 2: single and bulk category permanent deletion share one atomic cleanup primitive.** Malformed collection config blocks deletion instead of leaving dangling references.
11. **Resolved in batch 2: detail loaders redirect only on typed 404.** Permission, conflict, timeout, and upstream failure reach the route error boundary.
12. **Resolved in batch 2: option add/edit/bulk drafts participate in navigation protection.**
13. **Resolved in batch 2: competing form actions are inert while save is in flight.**
14. **Partially resolved in the categories/attributes slice: attribute row and bulk trash/permanent-delete now share a compact impact confirmation, and the service protects assigned values atomically.** Collection destructive actions still need the same confirmation grammar; permanent actions should eventually require typed confirmation at the shared component boundary.
15. **Resolved in batch 5: product editing is conflict-safe.** A fresh editor-owned snapshot, shared product/SKU revision, draft-preserving dialog, explicit reload, terminal deleted-product action, and persistent action-bar state prevent blind overwrite.
16. **Resolved in batch 5: option duplication is local and unsaved.** It clears SKU, barcode, stock, and one option axis; the obsolete persisted duplicate and redundant bulk-update APIs are removed.
17. **Resolved in the category authority slice: category hard delete is trash-only and bulk-safe.** Single and bulk destructive actions share impact confirmation, trash selection respects restore/permanent permissions, active dynamic collections cannot be orphaned, and trashed rows cannot enter edit.

## P2 workflow and UI findings

- New products and collections now default Draft; a shared activation-readiness gate remains open.
- Product, category, and collection create/edit shells now expose compact visible page headings and workflow context.
- Product detail omits flat discount, condition, feed/discovery state, and merchant option labels; it can render the internal variant-image marker and currently double-converts timestamps.
- Product names in the main table are not semantic links; several icon controls have no accessible names; inventory tabs lack tab semantics; loading overlays lack `aria-busy`/live status.
- Mobile product management keeps the desktop table and clips category, price, variants, and actions horizontally without a clear scroll affordance. Use a compact mobile row/card projection while preserving desktop density.
- General Settings contains thirteen in-memory tabs with no stable URLs. Currency, SEO/discovery, media, scanner, and other major areas need route-backed, permission-aware navigation.
- Inventory now has server-backed movement search/type filtering, order links, stable pagination, and explicit stocktake. It still lacks the alert inbox/acknowledgement UI, actor resolution, date range, cursor pagination, and streaming export.
- Resolved in the collections slice: content source is explicit and independent from grid/carousel presentation. Manual products are an ordered, keyboard-operable list; dynamic collections expose category membership only. Membership edits participate in dirty-state and publish-readiness validation.
- Dynamic category selection still reads a bounded 500-row option list rather than a paginated searchable picker; large catalogs need the same server-query pattern already used by the product picker.
- Resolved in the categories/attributes slice: attribute creation is responsive at narrow widths, icon-only value controls have accessible names, case-insensitive duplicate presets are collapsed in both UI and validation, and names/options have bounded canonical input.

## Interaction grammar

- One action name from button through toast: “Save changes” → “Changes saved.”
- One failure grammar: preserve inputs, state what failed, give Retry, and never replace an outage with an empty state.
- One destructive grammar: impact summary, reversible trash by default, typed confirmation for permanent deletion.
- One table grammar: URL-backed search/filter/sort/page, named controls, keyboard row navigation, selection-scoped bulk bar, visible stale/loading state.
- One edit grammar: explicit dirty state, CAS conflict response, reload/merge guidance, all competing navigation inert during save.
