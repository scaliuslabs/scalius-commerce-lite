# Admin Route-State Contract

Last reviewed: 2026-07-14

Status: accepted contract for new admin work and incremental route audits.

## Decision

Every meaningful, restorable admin workspace must have a canonical URL. A
merchant must be able to refresh, use Back/Forward, bookmark, share with an
authorized teammate, and open a global-search result without losing where they
were working.

The URL is the workspace address, not a serialization of the form.

## State that belongs in the URL

- the page/resource identity, preferably in the path;
- outer and nested tabs or panels;
- list search, safe filters, sort, page/cursor, and saved-view identity;
- a selected mode such as grid/table, preview, or diagnostics when it changes
  the workspace materially;
- a focused entity or subsection when opening that state directly is useful.

Normalize invalid or obsolete values to one canonical default. Do not leave
two URLs representing the same resting workspace.

Use history `push` for deliberate workspace transitions such as changing a tab
or opening a resource. Use `replace` for transient refinements such as a
debounced list query, pagination correction, or removal of an invalid value.
Back must return to the previous meaningful workspace, not replay every typed
character.

## State that must not enter the URL

- credentials, OTPs, receipt proof, customer PII, cart/payment/discount values,
  or other secrets already prohibited by the platform security contract;
- unsaved field values or rich-text drafts;
- transient UI such as hover, drag position, toast, open tooltip, or animation;
- bearer-like recovery material;
- a large selection set that can reveal or exceed URL limits.

If a workflow requires restorable private draft state, give it a server-side
draft identity with authorization and expiry; never encode the draft itself in
the query string.

## Nested settings

Settings use `section=<outer>&panel=<inner>` while they remain one route. The
inner panel is mandatory for sections that have a nested workspace and absent
for sections that do not. For example:

`/admin/settings?section=header&panel=navigation`

Refreshing this URL must reopen Header > Navigation. Changing either level
must update the address immediately. Mobile and desktop layouts share the same
route state even if their visual navigation differs.

If a settings area becomes large enough to own loaders, permissions, errors,
or a stable external reference, move it to a path route instead of adding more
query nesting.

## Global-search dependency

An admin search result is a typed action with a deterministic destination. The
route registry is therefore part of the future global-search index. Do not add
a result for a tab, setting, entity, or workflow until it can produce a stable
URL and restore the intended state.

Search must apply authorization before returning results and again on route
load. Hiding a result is not an authorization boundary.

## Verification gate

For each audited page, test:

1. direct load and refresh restore the same workspace;
2. Back/Forward traverses meaningful transitions;
3. invalid values normalize without a loop;
4. copying the URL into a fresh authorized tab restores the state;
5. narrow/mobile layout preserves the same address and meaning;
6. no sensitive or unsaved value enters the address, analytics, or logs;
7. the canonical address can be emitted by the future global-search registry.
