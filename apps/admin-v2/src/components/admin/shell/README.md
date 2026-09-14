# Admin shell components

Shared page furniture for the dashboard. Every admin surface is built from these
pieces so a page looks and behaves the same whichever domain owns it. The
semantics follow Shopify Polaris (contextual save bar, annotated section, index
table, empty state, badge tones) expressed in this app's Tailwind/shadcn tokens.

```tsx
import { PageHeader, SettingsSection, ContextualSaveBar } from "~/components/admin/shell";
```

Everything here is presentation only: data loading, permissions, and API calls
stay with the caller. There are no new dependencies — the components wrap the
existing primitives in `src/components/ui`.

## Page rules

- **One primary action per page.** The single filled button lives in
  `PageHeader.primaryAction`. Everything else is a secondary action (outline
  button, or an item in the "..." overflow menu). Destructive actions still
  confirm with an `AlertDialog` that says what will happen. In a "..." menu the
  deleting item is `<DropdownMenuItem variant="destructive">` — the tint comes
  from the primitive, never from hand-written `text-destructive` classes.
- **No per-card Save buttons on settings pages.** A settings page is one form:
  it saves through a single `ContextualSaveBar` that appears only while the page
  is dirty. A section may still carry inline row actions when it manages an
  independent resource list (adding a courier, removing an origin) — those act
  immediately and are not part of the page draft.
- **No duplicate titles.** If `PageHeader` already names the page, a card below
  it does not repeat the name.
- Copy is sentence case, no exclamation marks; help text says what happens.
- Content loads into skeletons (`SkeletonPage`), never spinners. Errors render
  as an inline banner with a retry. Success is a `sonner` toast.
- Everything must work at 375px: touch targets are 44px tall on mobile
  (`min-h-11 sm:min-h-9`), tables stack, and two-column sections collapse.

## Components

### `PageHeader`

Breadcrumb trail, title, subtitle and a right-aligned action area.

The header measures **itself**, not the viewport (`@container`): a page beside
the settings navigation is about 560px wide at a 1024px window, so viewport
breakpoints lied about how much room the header really had. The title block and
the action cluster are one wrapping flex row — the title keeps `flex-1
basis-[16rem]`, wraps its text instead of truncating, and the actions drop onto
a line of their own as soon as both no longer fit. Secondary actions stay inline
up to `inlineActionCount` once the header is `@lg` (32rem) or wider; in a
narrower header every secondary action is in the "More actions" menu.

Because Radix portals the menu out of the header, a container query cannot reach
its items — so there are two triggers instead: `page-header-overflow` (shown
below `@lg`, holds every secondary action) and `page-header-overflow-wide`
(shown from `@lg`, rendered only when something really overflows).

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `title` | `string` | — | 20px semibold; wraps, never truncates. |
| `subtitle` | `ReactNode` | — | Muted 13px line under the title. |
| `breadcrumbs` | `PageHeaderBreadcrumb[]` | — | `{ label, href?, onClick? }`; the last item without `href` is `aria-current="page"`. |
| `primaryAction` | `PageHeaderAction` | — | One per page. |
| `secondaryActions` | `PageHeaderAction[]` | `[]` | Collapse into the overflow menu. |
| `inlineActionCount` | `number` | `2` | How many stay inline from `@lg` (32rem of header width) up. |
| `linkComponent` | `ComponentType<PageHeaderLinkProps>` | anchor | Pass a router-aware link for client-side breadcrumbs. |
| `status` | `ReactNode` | — | Status line under the title: a `StatusBadge` plus at most one short sentence. |
| `titleSlot` | `ReactNode` | — | Inline content after the title (a "Rename" pencil). |
| `renderTitle` | `(ctx) => ReactNode` | — | Replaces the `h1` for an inline-editable title. |
| `children` | `ReactNode` | — | Extra content before the actions (a filter, a picker). |

`PageHeaderAction` is `{ id, label, onClick?, icon?, disabled?, variant?, disabledReason? }`.

`status` is where a page says what state it is in ("Tax calculation is off"),
so the subtitle can stay a fixed explanation — or be dropped. It renders inside
the title block, never in the action area.

`renderTitle` receives `{ id, className, title }`. The header names itself with
`aria-labelledby={id}`, so whatever it returns must still carry a heading with
that `id` — a visually hidden `h1` is fine while an input has the focus:

```tsx
<PageHeader
  title={menu.name}
  renderTitle={editing ? ({ id }) => (
    <form onSubmit={save}>
      <h1 id={id} className="sr-only">{menu.name}</h1>
      <Input aria-label="Menu name" value={name} onChange={...} />
    </form>
  ) : undefined}
  titleSlot={editing ? null : <RenameButton onClick={startEditing} />}
  status={<StatusBadge tone="attention">Draft changes</StatusBadge>}
/>
```
`splitHeaderActions(actions, inlineActionCount)` is exported for tests and for
callers that need the same split elsewhere.

```tsx
<PageHeader
  title="Delivery providers"
  subtitle="Couriers that can receive shipments from this store."
  breadcrumbs={[{ label: "Settings", href: "/admin/settings" }, { label: "Delivery" }]}
  primaryAction={{ id: "connect", label: "Connect provider", onClick: openConnect }}
  secondaryActions={[{ id: "sync", label: "Sync statuses", onClick: sync }]}
  linkComponent={({ href, ...rest }) => <Link to={href} {...rest} />}
/>
```

### `SettingsSection`

The annotated section: explanatory left column, card of controls on the right,
stacked below `lg`.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `title` | `string` | — | 14px semibold heading; names the section for assistive tech. |
| `description` | `ReactNode` | — | Muted, capped at 28ch. |
| `children` | `ReactNode` | — | The controls. |
| `footer` | `ReactNode` | — | Muted note under a divider. Never a Save button. |
| `actions` | `ReactNode` | — | Card header controls (a toggle, "Add"). |
| `id` | `string` | — | Anchor for deep links. |
| `className` / `cardClassName` / `contentClassName` | `string` | — | Escape hatches. |

```tsx
<SettingsSection
  title="Public origins"
  description="Saved in the database and shared by every Worker."
>
  <div className="grid gap-4">{fields}</div>
</SettingsSection>
```

### `FormCard`

Plain card with an optional title, description, header actions and footer, for
non-annotated layouts (detail panes, dashboards). Props: `title?`,
`description?`, `actions?`, `footer?`, `children`, `className?`,
`contentClassName?`.

The header wraps like `PageHeader`'s: the heading block keeps `flex-1
basis-[12rem]` so badges and buttons move onto their own line instead of
squeezing the title to one word per line. `SettingsSection`'s header actions row
wraps for the same reason.

### `ContextualSaveBar` + `useUnsavedChanges`

The page-level save affordance. It renders nothing until `isDirty`, sticks to
the top of the content area, announces itself with `role="status"` /
`aria-live="polite"`, and owns Save + Discard. While it is mounted it blocks
in-app navigation (TanStack Router `useBlocker`) and tab close (`beforeunload`),
and asks "Leave without saving?" before discarding.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `isDirty` | `boolean` | — | The only thing that shows the bar. |
| `onSave` / `onDiscard` | `() => void` | — | Discard must restore the last saved values, including pending sub-inputs. |
| `message` | `string` | `"Unsaved changes"` | |
| `saveLabel` / `discardLabel` | `string` | `"Save"` / `"Discard"` | |
| `saving` | `boolean` | `false` | Spinner, `aria-busy`, both actions locked. |
| `saveDisabled` | `boolean` | `false` | Invalid draft; Discard stays available. |
| `saveDisabledReason` | `string` | — | Surfaced on the disabled Save. |
| `canSave` | `boolean` | `true` | Read-only operators: both actions lock. |
| `discardDisabled` | `boolean` | `false` | Discard is shown but not available yet. |
| `hideDiscard` | `boolean` | `false` | Drops Discard for a change with nothing to fall back to (a first publication). |
| `blockNavigation` | `boolean` | `true` | Turns the guard and the dialog off. |
| `allowSamePathNavigation` | `boolean` | `false` | Query-string workspace state inside the same route is not "leaving". |
| `stickyClassName` | `string` | `"sticky top-0 z-30"` | Offset it when sticky page chrome sits above. |

`useUnsavedChanges(isDirty, { isSubmitting?, allowSamePathNavigation?, disabled? })`
returns `{ status, isBlocking, proceed, reset }` and is exported for forms that
need the guard without the bar (wizards, dialogs). The bar calls it for you.

```tsx
<ContextualSaveBar
  isDirty={dirty}
  saving={mutation.isPending}
  saveDisabled={hasErrors}
  saveDisabledReason="Fix the highlighted fields"
  canSave={canManage}
  onSave={() => mutation.mutate(patch)}
  onDiscard={reset}
/>
```

### `EmptyState`

Icon, heading, one sentence, primary action, optional secondary action/link.
Props: `heading`, `body?`, `icon?`, `action?`, `secondaryAction?`,
`bordered?` (default `true`), `compact?`, `children?`. Actions are
`{ label, onClick?, href?, disabled?, variant?, icon? }`.

### `IndexTable` + `IndexFilters`

`IndexTable<T>` is the resource list: 44px rows, hover, optional sortable
headers, optional bulk-selection column, sticky header, and rows that stack into
cards below `sm` (one DOM, `max-sm:` layout).

The stacked card reads like Shopify's: the first column that is not
`hideOnMobile` is the card title — top-left, left-aligned, unlabelled — the
`rowActions` menu is pinned to the card's top-right corner, and every remaining
cell is a label/value pair beneath. Order the columns so the row's primary label
(name, handle, order number) comes first.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `items` | `readonly T[]` | — | |
| `columns` | `IndexTableColumn<T>[]` | — | `{ id, header, cell, sortable?, align?, mobileLabel?, hideOnMobile?, className? }`. |
| `getRowId` | `(item: T) => string` | — | Row key and selection id. |
| `label` | `string` | `"Results"` | Accessible table name. |
| `loading` | `boolean` | `false` | Skeleton rows for the first page. |
| `loadingRowCount` | `number` | `5` | |
| `empty` | `ReactNode` | default `EmptyState` | Replaces the table when there is nothing to list. |
| `selectable` / `selectedIds` / `onSelectionChange` | — | — | Controlled selection; select-all only touches the listed rows. |
| `onRowClick` | `(item: T) => void` | — | Makes rows clickable and keyboard reachable (Tab, then Enter or Space). |
| `rowActions` | `(item: T) => ReactNode` | — | Trailing "..." menu; clicks do not open the row. |
| `sort` / `onSortChange` | — | — | `{ columnId, direction }`; headers expose `aria-sort`. |
| `stickyHeader` | `boolean` | `true` | |
| `bulkActions` | `ReactNode` | — | Bar shown only while rows are selected. |
| `footer` | `ReactNode` | — | Note under the rows; sits above the pager. |
| `pagination` | `IndexTablePagination` | — | Compact pager in the footer. |

`IndexTablePagination` is `{ page, pageSize, total, onPageChange, disabled?, itemLabel? }`
— 1-based `page`, `total` counts every matching row, and `disabled` locks the
pager while the next page is in flight. It renders the range it is showing
("26–50 of 120 items"), "Page 2 of 5", and previous/next; paging itself stays
with the caller, which normally means the URL. `indexTablePageCount(total,
pageSize)` is exported for callers that need the same page count.

`IndexFilters` is the bar above it: `searchValue`/`onSearchChange`,
`filters`/`activeFilterId`/`onFilterChange` (pills with `aria-pressed`),
`sortOptions`/`sortValue`/`onSortChange`, and an `actions` slot. Every control is
optional; render only what the list really supports.

`searchDebounceMs` (default `0`, immediate) reports the search only after a
pause — use it when each search costs a request or a URL change (350ms is the
house value). The field stays responsive while a commit is pending, and the
clear button always reports immediately. A list must not debounce a second time
on top of this.

```tsx
<IndexFilters searchValue={q} onSearchChange={setQ} filters={pills} activeFilterId={status} onFilterChange={setStatus} />
<IndexTable
  items={orders}
  columns={orderColumns}
  getRowId={(order) => order.id}
  loading={query.isLoading}
  onRowClick={(order) => navigate({ to: "/admin/orders/$id", params: { id: order.id } })}
  rowActions={(order) => <OrderRowMenu order={order} />}
/>
```

### `EditorSheet`

The side editor: a titled header with a close button, one scrolling body, and a
pinned footer for the actions. Radix owns the focus trap, Escape and the
overlay. Use it for editing one record beside the list that opened it; a screen
with its own URL still belongs on a route, and a yes/no question belongs in an
`AlertDialog`.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `open` / `onOpenChange` | — | — | Controlled, like every Radix surface. |
| `title` | `string` | — | Names the sheet (`aria-labelledby`). |
| `description` | `ReactNode` | — | One line on what saving changes. Omitted cleanly when absent. |
| `width` | `"sm" \| "md" \| "lg"` | `"md"` | `md` for a form, `sm` for a list, `lg` for a wide editor. |
| `footer` | `ReactNode` | — | Pinned action row: Cancel first, primary last. |
| `onSubmit` | `() => void` | — | Wraps body and footer in a form, so Enter and a `type="submit"` footer button save. |
| `headerActions` | `ReactNode` | — | Extra header controls left of the close button. |
| `closeLabel` | `string` | `"Close"` | |
| `side` | `"right" \| "left"` | `"right"` | |

```tsx
<EditorSheet
  open={open}
  onOpenChange={setOpen}
  title={editing ? "Edit tax rate" : "Add tax rate"}
  description="Rates that match the same checkout are added together."
  onSubmit={submit}
  footer={(
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
      <Button type="submit">Save rate</Button>
    </>
  )}
>
  {fields}
</EditorSheet>
```

### `PageTabs`

The section switcher for a workspace page that keeps its tab in the URL: a tab
strip from `sm` up, a select below it. It reports the new value and nothing
else — the caller owns the URL and renders the panel.

A page inside `SettingsLayout` switches sections with this, never with a second
left column of its own — the settings navigation is already the left column, and
a third one (the account page used to have one) leaves the content about 330px
wide. Account, checkout and taxes all read their section from `?section=`.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `tabs` | `PageTabItem[]` | — | `{ value, label, icon?, count?, disabled? }`. |
| `value` / `onChange` | — | — | `value` is the URL's section. |
| `label` | `string` | `"Sections"` | Names the strip and the select. |
| `panelId` | `string` | — | `id` of the panel; the selected tab points `aria-controls` at it. |

Arrow keys, Home and End move between tabs and select as they go. Give the
panel `role="tabpanel"` and the same `id`:

```tsx
<PageTabs tabs={tabs} value={section} onChange={setSection} label="Tax workspace section" panelId="tax-panel" />
<div id="tax-panel" role="tabpanel" aria-label={activeTab.label}>{panel}</div>
```

### `StatusBadge`

One badge for every status. `tone`: `success | attention | warning | critical |
info | neutral` (default `neutral`), `dot` (default `true`), `srLabel` for a
screen-reader-only prefix such as `"Payment status:"`. Pick the tone by meaning,
never by colour, and keep the label a readable word — colour never carries the
meaning on its own. `STATUS_TONE_CLASSES` is exported for one-off surfaces that
need the same palette.

### `InlineHelp` and `FieldError`

`InlineHelp` is the muted helper line under a field; `FieldError` is the same
slot once the field is invalid (icon + `role="alert"`). Give both an `id` and
point the input's `aria-describedby` at it; set `aria-invalid` on the input while
`FieldError` is showing. `FieldError` renders nothing without a message, so it is
safe to mount unconditionally.

### `SkeletonPage`

Loading shape for a settings page: header block plus `sections` annotated
sections (default 2, `rowsPerSection` 3), `role="status"` and `aria-busy`.
Props: `sections?`, `showHeader?`, `rowsPerSection?`, `label?`, `className?`.

## Testing

Each component has a `.test.tsx` beside it using the repo harness: happy-dom
(`// @vitest-environment happy-dom`), `createRoot` + `act`, and `vi.mock` for
`@tanstack/react-router` where the router is involved. Run them with:

```sh
pnpm vitest run apps/admin-v2/src/components/admin/shell
```
