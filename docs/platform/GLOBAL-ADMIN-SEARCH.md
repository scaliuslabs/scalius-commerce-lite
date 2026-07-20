# Global Admin Search and Command Palette

Last reviewed: 2026-07-14

Status: research and acceptance gate. Do not implement the global palette until
the route-state audit and the evidence/prototype gates below are complete.

## Product decision

`Cmd/Ctrl + K` will be a fast keyboard-first navigator and command surface, not
a chatbot. It must find commerce resources, admin destinations, settings, and
safe actions using intent-friendly deterministic ranking without requiring a
proprietary hosted search service or a separate Worker.

The first release combines:

1. a versioned static route/setting/command registry shipped with the admin;
2. permission-filtered resource search from the existing API and D1 search
   infrastructure;
3. a small non-sensitive local recent/frequent signal;
4. deterministic token, prefix, alias, acronym, and field-aware ranking;
5. explicit scopes and result groups instead of an opaque relevance score.

Do not add embeddings, an LLM, or fuzzy matching that cannot explain why a
result ranked. Synonyms such as `stock -> inventory`, `nav -> navigation`, and
`promo -> discounts` belong in a reviewed alias registry with tests.

## Verified benchmark lessons

- Shopify opens admin search with `Cmd/Ctrl + K`, searches resources plus
  settings/navigation, shows recent searches, supports one result-type filter,
  and caps the first result set before an explicit expansion. The useful lesson
  is bounded progressive disclosure, not copying its taxonomy.
  <https://help.shopify.com/en/manual/shopify-admin/admin-search>
- Notion lists recently viewed pages before a query, adds popularity signals,
  supports exact quoted search, opens a result in a new tab with a modifier,
  and provides a direct copy-link shortcut. It also treats `home` and
  `settings` as destinations rather than only document text.
  <https://www.notion.com/help/search>
- Medusa exposes search from every admin page, uses `Cmd/Ctrl + K`, and supports
  arrow-key selection plus Enter. Its separate navigation shortcuts show that
  frequent deterministic destinations should not depend on a text query.
  <https://docs.medusajs.com/user-guide>
- Saleor's dashboard is an open-source GraphQL single-page admin. Its source is
  a useful implementation benchmark, but no search behavior is accepted from
  source inspection until a specific interaction is reproduced and recorded.
  <https://github.com/saleor/saleor-dashboard>

## Information architecture

With an empty query, show a small ordered set of recent destinations, context
actions, and core navigation. With a query, group results by intent:

- **Go to:** pages, settings panels, reports, and saved views;
- **Resources:** products/SKUs, orders, customers including guest profiles,
  categories, collections, pages, media, discounts, and other authorized data;
- **Actions:** create/open/import/export actions that are safe in the current
  context. Destructive actions never execute directly from a search result;
- **Search in:** an explicit handoff to a full list/search page with the query
  preserved when bounded quick results are insufficient.

Each result has one primary label, one short disambiguator, a recognizable icon,
and an optional shortcut. Do not fill the palette with explanatory paragraphs.
Never mix a navigation result and a mutating action under the same visual type.

## Query and ranking contract

Normalize case and Unicode safely; tokenize punctuation without damaging SKU,
barcode, email, phone, or order identities. Rank exact identity and exact label
first, then field-aware prefix, token/alias match, word-boundary contains, and
finally bounded typo tolerance only where it cannot confuse identifiers.

Boost current-context compatibility and a small recent/frequent score after
text relevance, never ahead of an exact identifier. Permission, lifecycle,
tenant, and buyer/admin visibility filters run before scoring. Ranking must be
stable for identical data and query, with deterministic tie-breakers.

Queries should be abortable and debounced only enough to prevent request
storms. Static destinations filter immediately in the browser while one
permission-scoped resource request runs. Results from an older query must never
replace a newer query.

## Performance and resilience budget

- palette shell and static results visible within one animation frame after the
  shortcut on a warm admin;
- local filtering should remain perceptually immediate;
- first useful remote results target p95 under 200 ms from an already loaded
  regional admin, with a hard bounded result count and no unbounded reads;
- no new worker, hosted index, or full-catalog browser download;
- API failure leaves static navigation/actions usable and shows a compact retry
  state for resources;
- cache only non-sensitive, tenant-scoped safe result metadata, and clear it on
  logout/tenant change.

Use existing repository FTS/index patterns and D1. Respect D1's 100-binding and
six-connection limits; aggregate resource searches through one bounded service
boundary rather than issuing one concurrent request per result group.

## Interaction and accessibility

- open from any non-conflicting context with `Cmd/Ctrl + K` and from a visible
  Search control;
- arrow keys move active result, Enter opens, modifier+Enter opens a new tab
  where safe, Escape closes, and focus returns to the trigger;
- preserve the typed query while moving between groups/scopes;
- use a combobox/listbox or equivalent proven accessible pattern with announced
  result count, group names, loading, errors, and active descendant;
- never steal ordinary typing from form/rich-text contexts;
- on mobile, use the same search/ranking contract in a full-width sheet;
- animation is a short opacity/scale/position transition. Honor reduced motion,
  avoid springy layout movement, and never delay focus or result interaction.

## Research and prototype gate

Before production implementation:

1. inventory every admin route, nested panel, entity identity, permission, and
   safe action; make missing workspace state URL-addressable first;
2. reproduce and record current Shopify, Medusa, Notion, and Saleor search
   interactions, including empty, partial, no-result, error, keyboard, and
   mobile states;
3. define the typed registry and result schema without importing page modules
   into the palette bundle;
4. benchmark the existing D1 FTS/token indexes with realistic demo volume and
   typo/alias/identifier queries;
5. create local prototypes for density, grouping, motion, and keyboard behavior
   and review them before integrating;
6. add ranking fixtures for exact IDs, SKU/barcode, aliases, ambiguous names,
   guest customers, unavailable/trash resources, permissions, and locale text;
7. prove abort/race handling, partial API failure, narrow viewport, screen
   reader, reduced motion, and no-JavaScript/sensitive-data boundaries;
8. ship behind an explicit feature gate with latency, error, and zero-result
   aggregate telemetry that contains no query text or PII.
