# Admin Route-Addressability Audit

Last reviewed: 2026-07-14

Status: active inventory. The route-state contract is
[`ADMIN-ROUTE-STATE.md`](./ADMIN-ROUTE-STATE.md); this file records adoption so
future agents do not repeat or lose the audit.

## Release rule

A meaningful admin workspace is incomplete until a canonical URL restores it
after direct load, refresh, Back/Forward, and a narrow-layout render. The URL is
also the future global-search destination. Form drafts, dialog steps, drag
position, credentials, buyer data, and other transient or sensitive values
must remain outside the URL.

## Addressable workspaces

| Area | Canonical state | Notes |
| --- | --- | --- |
| General settings | `section`, plus `panel` for Header/Footer | Header and Footer inner workspaces are refreshable. |
| Checkout settings | `section` | Flow, payment, languages, shipping, delivery, and customer requests. |
| Tax settings | `section` | Policy, classes, rates, classification, and preview. |
| Theme settings | `section` | Design system, colors, and review/publish. |
| Account settings | `section` | Existing route-backed workspace. |
| Notification settings | `section` | Delivery rules and admin push. |
| Inventory | `section` | Variants, low-stock alerts, and movements. |
| Homepage hero | `section` | Desktop and mobile compositions. |
| Meta Conversions | `section` | Settings and event logs. |
| Media | `folder`, `kind`, `sort`, `search`, `view` | Defaults are omitted; missing folders normalize only after a successful folder read. Picker selections remain transient. |
| Products, categories, attributes, collections, pages, customers, orders, discounts, analytics | typed list query | Safe search/filter/sort/page/trash state is already route-backed. |

## Deliberately transient state

These states are not global-search destinations and should not enter the URL:

- notification-popover All/Unread tabs;
- language and permission-editor dialog tabs;
- customer-request preview examples;
- product Description/Additional editor tabs while they expose one unsaved
  product draft;
- open dialogs, row selections, drag projections, hover help, and toasts.

If any of these grows into a standalone, permissioned workflow, first give it
a route or a server-side draft identity rather than copying draft data into a
query string.

## Open audit items

- `TaxClassificationsPanel` has a Product/SKU sub-view inside the route-backed
  classification workspace. Decide whether frequent direct reference warrants
  a nested `panel` parameter; do not add it until its query/filter state is
  reviewed as one unit.
- `DeliveryLocationsContainer` has City/Zone/Area tabs but no active route was
  found in the July 2026 route scan. Remove the dead component or route the
  canonical delivery-location manager; do not maintain two authorities.
- Entity editors need a second pass for deep-linkable, read-only sections. A
  section may enter the URL only when refresh will not discard or falsely
  reconstruct an unsaved form draft.
- Drawers, segmented controls, saved views, and non-`Tabs` mode switches need a
  second mechanical scan. Classify each against the contract rather than
  automatically serializing every visual control.

## Verification checklist

For each row moved into the addressable table:

1. validate and normalize the search value;
2. render from route state rather than duplicate local state;
3. push deliberate workspace changes into history;
4. prefetch the selected data surface when practical;
5. verify direct load, refresh, Back/Forward, copy-open, mobile, and console;
6. add the destination to the future typed route registry only after those
   checks pass.
