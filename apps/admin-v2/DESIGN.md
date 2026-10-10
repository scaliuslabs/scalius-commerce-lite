# Dashboard design system

Binding rules for every contributor to `apps/admin-v2`. The look follows Shopify admin (Polaris). The discipline follows Cloudflare Kumo's design rules (a reference, not a dependency). The primitives are shadcn/ui on Radix (`src/components/ui/`). Token values, the type scale and motion are in `src/styles/global.css`, and copy is in `src/i18n/`. `pnpm --filter ./apps/admin-v2 lint` enforces part of this document as errors (see [Lint](#lint)). Rules without a "(lint)" mark are review rules: follow them anyway. [The polish bar](#the-polish-bar) gives every rule an ID and a check: `lint`, `harness` (`pnpm quality:admin`) or `review`.

Dark mode is only the token file. Never write `dark:` (lint). Never use palette colours such as `bg-red-500` (lint, `no-raw-colors`).

## Tokens

Use the Tailwind names. Values for both themes are in `global.css`.

| Role | Classes |
| --- | --- |
| Surfaces | `bg-background` page grey · `bg-card` card · `bg-muted` subdued (table header, row hover) · `bg-popover` · `bg-accent` hover and selected · `bg-secondary` neutral fill (`hover:bg-secondary-hover`) |
| Text | `text-foreground` · `text-muted-foreground` subdued · `text-link` · `text-primary-foreground` on `bg-primary` · `text-destructive` readable red text |
| Lines, focus | `border-border` (the default `border`) · `border-input` field edge · `ring-ring` focus ring (2px, 1px offset) · `bg-overlay` backdrop |
| Actions | `bg-primary` / `hover:bg-primary-hover` · `bg-destructive` / `hover:bg-destructive-hover` (the button fill) |
| Tones: `success` `warning` `caution` `critical` `info` | `bg-{tone}` fill with `text-{tone}-foreground` · `bg-{tone}-surface` tint with `text-{tone}` · `border-{tone}`. Every pair passes WCAG AA in both themes. |
| Shell | `bg-sidebar` (the near-black frame, both themes) with `text-sidebar-foreground`, `text-sidebar-muted-foreground`, `hover:bg-sidebar-hover` and `bg-sidebar-accent` (current-page pill) · `bg-topbar` with `text-topbar-foreground` and the `-subdued` (search pill, save bar), `-hover`, `-primary` (Save) and `-progress` (loading bar) variants · `bg-store-badge` (store avatar) |
| Charts | `bg-chart-1` to `bg-chart-5` |
| Elevation | `shadow-card` · `shadow-button` (outline buttons) · `shadow-button-primary` · `shadow-button-critical` · `shadow-popover` · `shadow-modal` · pressed: `shadow-pressed`, `shadow-pressed-strong`. The card, button, popover and modal shadows draw their own 1px ring edge. |
| Radius | `rounded-md` 6px (menu items) · `rounded-lg` 8px (controls, badges, navigation rows) · `rounded-xl` 12px (cards, popovers, menus, alerts) · `rounded-2xl` 16px (dialogs) |
| Spacing | Tailwind 4px scale. Cards `p-4`. Page stacks `gap-4`. Table cells `px-3 py-1.5`; list tables (`DataTable`) `px-1.5 py-1.5`, `pl-3`/`pr-3` at the table's edges. Page content `max-w-7xl`, padding `px-3 sm:px-4 md:px-6`. |

## Type

Font: Inter at weights 450 (normal), 550 (`font-medium`) and 650 (`font-semibold`). A metric-matched Arial fallback prevents layout shift while Inter loads. Use only the classes below. Never use Tailwind's default sizes, `text-xs` to `text-9xl` (lint).

| Class | English | Bangla | Use |
| --- | --- | --- | --- |
| `text-caption` | 12/16 | 13/20 | Badges, table column headings, keyboard shortcuts, calendar weekdays only |
| `text-nav` | 13/20 | 14/20 | Navigation labels only |
| `text-body` | 14/20 | 15/24 | All other content: body, buttons, data, controls, tooltips, menus, help, errors |
| `text-body-lg` | 16/24 | 16/26 | Fields below 640px (iOS zooms into smaller inputs). Fields are `text-body` from `sm`. |
| `text-heading-sm` | 14/20 | 15/24 | Card titles |
| `text-heading-md` | 16/24 | 16/26 | Dialog, sheet and alert dialog titles |
| `text-heading-lg` | 20/28 | 20/32 | Page titles |
| `text-heading-xl` | 24/32 | 24/36 | Metric values only |

- All headings are semibold. Inline emphasis is `font-medium`.
- Wrap SKUs, order IDs, phone numbers and tracking codes in `<code>` inside a sentence (`code`, `kbd` and `samp` render at 0.9em). A standalone mono value, such as a SKU column, uses `font-mono` at body size.
- Format money with `useCurrency().fmt()`: store currency symbol first, digits grouped as the store's country groups them (lakhs in Bangladesh). Use `tabular-nums` outside tables.
- Format numbers and dates with `formatNumber` and `formatDateTime` from `~/i18n` (`@scalius/shared/locale-format`: Intl for the dashboard language in the store's country, store time), lists with `formatList(items, getLocale())` (`@scalius/shared/locale-words`), and weights with `formatWeight` (`product-form/variants/weight-format.ts`). Never call `Intl` formatters or `toLocaleString` yourself (`scripts/check-source-policies.mjs`).
- Write counts with the plural syntax in the catalog: `{count, plural, one {# variant} other {# variants}}` (CLDR rules for the dashboard language; `=0 {…}` for an exact number). Never write "1 variants". Bangla needs no branches. Pass the number itself (`t("key", { count })`), never `formatNumber(count)`: `t()` formats it and picks the plural word from it (`scripts/check-source-policies.mjs`). `src/i18n/placeholders.test.ts` formats every catalog string in both languages and fails on a leftover `{`, `}` or `#`, and on a `t("key")` that needs variables and gets none.
- Write when something happened as `ListDate` does ("Just now", "41 min ago", "Today at 3:42 PM", "Oct 3 at 3:42 PM", "Oct 3, 2025"). Write a date field with `DateInput`, its month as a word ("Oct 7, 2026"). Never a numeric date ("07/10/2026"), and never `<input type="date">`.
- Write a stored phone number with `formatPhoneForDisplay(phone, getStoreRegion())` (`@scalius/shared/phone-input`): the store country's national format ("01712-345678" in Bangladesh), another country's with its code set apart.
- Order and payment status words are the storefront's (`status-vocabulary.test.ts` checks them). An unpaid cash-on-delivery order is "Due on delivery".
- Bangla (`<html lang="bn">`, set before paint) switches the same classes to the Bangla sizes and loads Noto Sans Bengali. Controls size to their line, so vowel signs never clip, and buttons grow instead of truncating. Truncate only with CSS (`truncate`, `line-clamp-*`), never by slicing strings. Keep Latin digits in inputs, SKUs, phones and IDs.

## Rules

1. Content text is 14px (15px in Bangla). Only headings are larger. (lint)
2. Use sentence case. Never `uppercase`. (lint)
3. Never change the font's tracking: no `tracking-*`. (lint)
4. Never use `font-bold`, `font-extrabold` or `font-black`. (lint)
5. Put related text closer together than the content it belongs to: title and description `gap-1`, section and section `gap-4`.
6. Make vertical padding around text smaller than horizontal: `px-3 py-2`, `px-2 py-0.5`.
7. Make hover colour changes instant. Never `transition`, `transition-colors` or `transition-all`. Animate only transform, opacity or a size: `transition-transform`, `transition-opacity`, `transition-[width]`. (lint)
8. Never put a border and a drop shadow together. Use a shadow token, which carries its own ring. (lint)
9. Use concentric radii when two edges are 8px apart or less: outer radius = inner radius + padding. A menu is `rounded-xl` with `p-1.5`, so its items are `rounded-md`.
10. Align icons with the first text line. In multi-line rows, wrap the icon or checkbox in `flex h-lh items-center`. `Alert` does this for you.
11. Give sticky bars a `border-b` or `border-t`. (lint)
12. Keep collapsing content at its size: `Accordion` animates the container height and keeps padding inside.
13. Never put a Card inside a Card. Use sections (`border-t`), a Table or a list inside one card. (lint)
14. Keep dialogs, sheets, alert dialogs, popovers and menus mounted. Drive them with `open` and `onOpenChange`. Never write `{open && <Dialog />}`. (lint for Dialog, AlertDialog and Sheet)

## States

| State | Rule |
| --- | --- |
| Hover | Instant fill: `hover:bg-accent`, `hover:bg-*-hover`. Fields use `hover:border-muted-foreground`. |
| Pressed | Inset shadow (`active:shadow-pressed`, `active:shadow-pressed-strong`) or a darker fill. |
| Focus-visible | 2px `ring-ring`. |
| Disabled | `opacity-50` with no pointer events. Fields use `bg-muted` and `opacity-60`. |
| Loading | `<Button loading>` swaps the label for a spinner, keeps its width and ignores clicks. |
| Selected | `aria-pressed` on toggle buttons. `data-state=active` on tabs (neutral fill). `data-state=selected` on table rows (`bg-accent`). `aria-current=page` on navigation rows (pill). |
| Invalid | `aria-invalid` gives a field a critical border and tint. |

## Which primitive

| Need | Use |
| --- | --- |
| Action | `Button`. Variants: `default` primary, `outline` secondary, `secondary` neutral, `ghost` tertiary and icon, `link` plain, `destructive` critical. Sizes (phone/`sm` up): `default` 44/36px, `sm` 36/32, `lg` 44, `icon` 44/36, `icon-sm` 44/28. |
| Section | `Card` with `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`. |
| Status | `Badge`. Use `default` (strong) only for counts, and the tone variants per the status table below. |
| Page message | `Alert`, with a tone variant. |
| List | `Table` inside a `Card`, with `Tabs` above. Right-align numeric columns (`data-numeric`). |
| Fields | `Input`, `Textarea`, `SearchableSelect`, `DateInput`, `Checkbox`, `RadioGroup`, `Switch`, with `Label` and `Form*`. |
| Small edit or confirmation | `Dialog`: a bottom sheet on phones, centred from `sm`. |
| Destructive or irreversible confirmation | `AlertDialog`: no outside-click dismiss. The title names the object: "Delete 'Cotton panjabi'?". |
| In-context preview | `Sheet`. |
| Menu, hint | `DropdownMenu`, `Tooltip`. |
| Loading | `Skeleton`. Mirror the real layout and keep the real titles. |
| Feedback | `toast` from `~/lib/toast`: noun plus past verb, three words or fewer. A toast with an action gets `duration: 10000`. An error that blocks work is a banner, not a toast. |

### Tables

- The header row is sticky by itself, under the top bar. When the columns are wider than the card, the table scrolls both ways inside a viewport-high box and the header sticks there.
- Any wrapper between a table and the page uses `overflow-clip`, never `overflow-hidden` or `overflow-auto`. Otherwise sticky stops working.
- List tables (`DataTable`) copy Polaris IndexTable's density: 6px each side of a cell, 12px at the table's edges, 6px row padding, a subdued header (`INDEX_CELL`).
- Every cell is one line (two for a title or name over phone, on every row, `min-h-[2lh]`), so rows never change height with their data. Free text truncates at `meta.maxWidth` with the whole value in `title`. An empty cell reads "—".
- A column's `meta.minWidth` is its widest content in the dashboard's language plus padding (`localeWidth({ en, bn })`). Too narrow a table steps the lowest `meta.priority` aside first; the title column and `meta.keep` columns (the orders list's Date) never go. `meta.combines` names a stand-in column that takes the place of two columns that no longer fit side by side (Payment over Fulfillment). `list-layout.test.tsx` measures every list's widest content with the fonts' real glyph widths at 1024, 1280, 1440 and 1920px.
- Apps' columns are data-backed (`dataColumns`): the list asks for them in its one read (`useAppListColumns`, at most 5, sent only when an active app has one) and shows them with a low priority, titled in the dashboard's language; their priority stays below every list's working set. Money arrives in major units, like every amount in the API; a yes/no value is a Yes or No badge. A filterable column adds one "App filter" field (`AppListFilter`, lazy; `appFilter` in the URL) to the list's filters.
- Created and updated dates use `ListDate` (or `createDateColumn`): store time, "Just now", "41 min ago", "Today at 3:42 PM", "Yesterday at …", the weekday within a week, "Oct 3 at …", and "Oct 3, 2025" for another year, the full date and time on hover.

### Overlays

- Overlays never cover the top bar and never run off screen. Popovers, menus and tooltips default to `OVERLAY_COLLISION_PADDING` (`components/ui/overlay.ts`: 64px top, 12px elsewhere).
- A popover with actions uses `flex max-h-(--radix-popover-content-available-height) flex-col overflow-hidden p-0`. Its body scrolls (`min-h-0 flex-1 overflow-y-auto`) and its actions sit in a bordered footer that does not scroll.
- Keep at most two buttons in a `DialogFooter`, `AlertDialogFooter` or `SheetFooter`.
- A centred `Dialog` or `AlertDialog` keeps its top edge while open (`useModalTopAnchor` in `components/ui/dialog.tsx`): it opens centred on its first content, then grows and shrinks downward and never re-centres, so a filtered list, a chip row or an error line cannot move its buttons. Never hand-position a dialog, and never put a `top-*`, `translate-y-*` or viewport `max-h` class on `DialogContent`. A list inside a dialog that filters keeps a box of fixed height (`h-64`), so filtering changes its rows, not its size.
- When a popover cannot fit beside its trigger (phones, short windows), open a Dialog instead (`DateRangePickerWithPresets`).

### Choosing one option

- Use `SearchableSelect` for fixed and data-backed lists. Pass `options` for a loaded list, or `load` and `queryKey` for a large list (it searches on the server, debounced, and pages). The search never goes in the page URL. A fixed list shows its search box only from 8 options (`SEARCH_MIN_OPTIONS`); a status or yes/no list is read, not searched.
- Use `LocationPicker` (`components/admin/location/`) wherever the dashboard picks a delivery address: City, then Thana, then Area, each filtered by the level above.
- Never use `NativeSelect`, Radix Select or a raw `<select>` (lint).

### Page patterns

- `PageHeader` holds an optional back link, a `text-heading-lg` title that wraps and never truncates, badges, then secondary actions and one primary action on the right.
- An empty state is one card with a short title ("No orders match these filters"), one sentence and one primary action. Filtered empties offer "Clear filters".
- Help text is `text-body text-muted-foreground`. Error text is `text-body text-destructive`.

### Navigation shell

Code: `components/admin/layout/`.

- A near-black frame (`bg-sidebar`) holds the navigation and a 56px top bar. From `md`, the page sits on a rounded canvas inset 8px from the frame. From 1100px (`nav:`, `NAV_PANEL_QUERY` in `nav-button.ts`), the navigation is a 240px panel that `Cmd+B` or `Ctrl+B` collapses to a 56px icon rail (saved per browser, read before the first render). Narrower windows (phones, tablets, a 1024px laptop) get a drawer behind a Menu button, as Shopify does: one scrolling list of every section with its sub-pages already open (no accordions), opened at the current page and closed by any link. So a 1024px laptop gives lists the full width.
- The top bar holds one search pill (`Cmd+K` cap), help, notifications and the store menu. While a form is dirty, the contextual save bar replaces the pill (`SaveBar` portals into `#admin-top-bar-pill`) and shakes when leaving is blocked.
- Navigation rows use `NAV_ROW` (`nav-button.ts`). The current page (`aria-current=page`) sits on the `bg-sidebar-accent` pill in semibold.
- Declare every keyboard shortcut once in `shortcuts.ts` (`SHORTCUTS`, `matchesShortcut`). The `?` dialog lists that table.
- The panel animates (180ms slide, 200ms width) only after a change, never on load. The page-loading bar (`AdminNavigationProgress`) appears after 180ms.

### Theme document fields

Use `MediaField` (Files picker) and `LinkField` (made canonical when the field is left) from `components/admin/online-store/schema-form/resource-fields.tsx`. Never hand-write a section or block settings form: `SchemaSettingsForm` draws it from the registry's zod schemas, and `labels.test.ts` fails on a setting without an English and a Bangla label in `i18n/theme-settings.ts`. Ordered picks inside a section move with up and down buttons. Sections and product page modules also reorder by drag handle or by keyboard (Space, arrows, Space).

## Status to badge variant

Code: `components/admin/orderview/status-badges.ts` (`statusBadgeVariant(status, kind)`) and `components/admin/resource/StatusBadge.tsx` (`RESOURCE_STATUS_VARIANT`). A status not listed is `secondary` (neutral). The badge always carries the word. Colour is never the only signal.

| Kind | `success` | `info` | `warning` | `attention` | `destructive` |
| --- | --- | --- | --- | --- | --- |
| Order | delivered | processing, confirmed, shipped | returned | pending | none |
| Payment | none | none | unpaid, partial | none | failed |
| Fulfillment | none | none | partial | pending | none |
| Returns, cash collection, requests, messages | received, collected, sent, delivered | approved, in_transit | partial | requested, submitted, under_review, pending | failed, dead_lettered, rejected |
| Record (products, categories, brands, collections, pages, posts, discounts) | active | scheduled | none | draft | expired, error |

Record states `archived`, `hidden` and `inactive` are `secondary`. A cancelled, refunded, returned or incomplete order shows only its status badge (`orderBadgeVisibility`).

## Read-only mode

Staff who can view a page but not edit it (polish bar R5) see one consistent page:

1. `ReadOnlyNotice` (`components/admin/states`) once, under the page header: an info banner, "You can view this page but not change it", and who grants edit access (the store owner's name from `/rbac/my-permissions`, else "the store owner").
2. Values are text, never disabled inputs: every field renders through `Field` with `readOnly`, which draws `ReadOnlyValue` (the value, "—" when empty, codes in mono, money and dates formatted) in the field's place with its label. Rich text renders as content. A disabled control is for a choice that is unavailable now, not for missing permission.
3. Nothing that writes is drawn: no save bar (an editor registers no save entry), no create, delete, upload, reorder or status controls, no primary action in the header, and "More actions" keeps only reading actions (view, print, copy link). Navigation, search, filters and exports that only read stay.
4. One switch per page: the page reads its edit permission once (`useHasPermission(...)`) and passes `readOnly` down; components never check permissions for their own copy of the rule.

The harness checks it with a view-only session: `[data-slot=read-only-notice]` is present and no enabled control would send a mutating request.

## Right to left

Write sides as the reading direction sees them, so a right-to-left language mirrors the page:

- Use logical utilities: `ms-`/`me-`, `ps-`/`pe-`, `inset-s-`/`inset-e-`, `border-s`/`border-e`, `rounded-s-`/`rounded-e-`, `text-start`/`text-end` (lint: `scripts/check-source-policies.mjs`). Keep a physical side only for centring with a translate or a position measured in pixels from the left; add it to `PHYSICAL_UTILITY_ALLOW` with that reason, or pair it with `rtl:`.
- Write CSS with logical properties (`inset-inline-start`, `margin-inline-end`, `border-inline-start`).
- Arrows and chevrons that point along the line (lucide `chevron-*`, `arrow-*`) mirror by themselves (`global.css`); a rotated disclosure chevron keeps its turn.
- `<html dir>` follows the language (`applyDocumentLocale`). Tests use the pseudo-locale `RTL_PSEUDO_LOCALE` (`ar-XB`); the catalogs stay English and Bangla.

## Checklist for every screen

- Check light and dark, including badge contrast. Cause no layout shift from data or fonts.
- Keep focus visible and never hidden under a sticky bar. `Esc` closes overlays.
- Make touch targets at least 24px, and rows and buttons at least 40px.
- Use `loading` on async actions, so a double submit is impossible.
- Check the Bangla render: no clipped marks, buttons grow.

## The polish bar

The measurable bar for every screen, at any data size: 0 rows or 1,000,000. Each rule has an ID (cite it in reviews and audits) and one check:

- `lint`: ESLint, `scripts/check-source-policies.mjs` or a catalog test fails the build.
- `harness`: `pnpm quality:admin` measures it in a real browser (390, 768, 1024, 1440 px; en and bn; light and dark). The check after `→` is the definition the harness implements. `±1` means one CSS pixel.
- `review`: a person checks it against this text and the reference.

A `lint` or `harness` check that does not exist yet is work for Wave B and the harness. Until it lands, review the rule. A screen passes the bar when it has zero `harness` failures at every width and language, and zero open P1 or P2 findings in `audit/polish-2026-10/`.

Reference: the expanded variant row (product page, Variants): labels above fields, one control height, help under its field, an aligned two-column grid on a quiet inset card, the SKU as a mono subtitle, numbers in fixed-width fields.

Harness hooks. Shared components carry these `data-slot` names; the harness selects by them: `page-header`, `page-title` (the `h1`), `page-actions`, `card`, `inset`, `field`, `field-label`, `field-control`, `field-help`, `field-error`, `index-table`, `bulk-bar`, `pagination`, `empty-state`, `error-state`, `skeleton`, `presence`, `offline-banner`, `read-only-notice`, plus the existing `topbar`, `dialog-content`, `dialog-footer`, `sheet-footer`, `alert`, `[data-save-bar]` and `#admin-main-scroll`. A screen that hand-builds one of these parts fails the harness, because the part has no slot.

### Spacing and alignment

| ID | Rule | Check |
| --- | --- | --- |
| S1 | Use the 4px scale only: 0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48. | lint (`no-arbitrary-values`) |
| S2 | Label to control: 4px (`gap-1`). | harness → for each `label[for]` above its control: `control.top − label.bottom` = 4 ±1 |
| S3 | Control to help or error: 4px. Error replaces help; it never stacks under it. | harness → `[data-slot=field-help],[data-slot=field-error]`: `top − control.bottom` = 4 ±1; never both visible in one field |
| S4 | Field to field in a card: 16px vertical (`gap-4`). In an inset card: 12px (`gap-3`). | harness → vertical gap between sibling `[data-slot=field]` = 16 ±1 (12 ±1 inside `[data-slot=inset]`) |
| S5 | Fields side by side share one grid: equal columns, 16px gap (12px inset), tops aligned. Never mix a ½ and a ⅓ column in one card section. | harness → sibling fields in a row: equal width ±1 and equal `top` ±1 |
| S6 | Card padding 16px (`p-4`); card to card 16px; page side padding 12/16/24px (`px-3 sm:px-4 md:px-6`). | harness → `[data-slot=card]` padding-inline 16; sibling cards 16 apart |
| S7 | Inside one card, every section and row starts at the same inline edge as the card title. | harness → `left` of the first text in each row of a card = card title `left` ±1 |
| S8 | Page widths by page type: index `max-w-7xl`; detail and form `max-w-5xl` (⅔ + ⅓ from 1024px); settings `max-w-3xl`; one-card task `max-w-2xl`. | harness → `main > *` width per route type table in `docs/platform/SCREEN-CENSUS.md` |
| S9 | Help text aligns to the field's start edge, never centred or end-aligned. | harness → `field-help` `text-align` = start |

### Field

| ID | Rule | Check |
| --- | --- | --- |
| F1 | One `Field` primitive (`components/ui/field.tsx`): label, control, help, error. Never write a local `Field`, `FormItem` with `space-y-*`, or a bare `<Label>` beside a control. | lint → no `function *Field(` outside `components/ui`; no `space-y-*` on a parent of `Label` |
| F2 | The label is above the control, sentence case, 1–3 words, `text-body font-medium`. A single checkbox or switch puts its label after the control on the same line. | review |
| F3 | Units and currency are a prefix or suffix inside the control (`৳`, `g`, `%`), never in the label ("Price (৳)"). | harness → no visible `label` text matches `/\(.{1,3}\)$/` |
| F4 | Money, quantities, weights and percentages use `MoneyInput`/`NumberInput`: tabular digits, a fixed width (`w-40`, `w-32` for quantities) in dense rows, full column width in forms. | review |
| F5 | Codes (SKU, barcode, order number, tracking) are `font-mono` in fields and subtitles, never bold. | review |
| F6 | Placeholder shows an example, never the label or an instruction. | review |
| F7 | Optional fields say "(optional)" in the label; required fields have no star. | review |
| F8 | Validate on blur, then on every change while the field is invalid; on a failed submit focus the first invalid field. | harness → submit an empty required form: `document.activeElement` is the first `[aria-invalid=true]` |
| F9 | A yes/no that saves with the form is a `Checkbox`; a setting that applies at once is a `Switch`. Never both styles for the same kind of choice in one card. | review |

### Controls and buttons

| ID | Rule | Check |
| --- | --- | --- |
| C1 | One control height: 36px from 640px, 44px below it, for inputs, selects, date fields and buttons beside them. Bangla keeps the height; the line grows inside it. | harness → visible `input,textarea[rows="1"],button[role=combobox]` heights ∈ {36} (≥640) or {44} (<640) |
| C2 | Controls in one row have one height. `size="sm"` (32px) only in table cells, card headers and menus with no field beside them. | harness → elements of one flex row whose boxes overlap vertically by >50%: max height − min height ≤ 1 |
| C3 | One primary button per view: the page, each open dialog, each sheet. When the save bar shows, the page has no other primary. | harness → visible `.shadow-button-primary` outside overlays ≤ 1; in each `[role=dialog]` ≤ 1 |
| C4 | Order: secondary actions, then the primary at the end. More than two secondary actions go into "More actions". | harness → `[data-slot=page-actions]`: ≤ 3 visible buttons; primary is last |
| C5 | Never a disabled primary as the only cue. Disabled buttons say why (tooltip or help line). | review |
| C6 | Touch targets: ≥24×24px everywhere, ≥44px tall below 640px. A 16px checkbox gets a 24px (44px on phones) hit area. | harness → `button,a[href],[role=checkbox],[role=switch],[role=radio],[role=tab]`: hit box ≥ 24×24; ≥ 44 tall under 640 |
| C7 | Icon-only buttons have an accessible name and a tooltip. | harness → every visible `button` has text, `aria-label` or `aria-labelledby` |
| C8 | Links are `text-link`. Underline only on hover, except inside running text. | review |

### Card and form section

| ID | Rule | Check |
| --- | --- | --- |
| K1 | A card has a title (`text-heading-sm`) and, at most, one sentence of description. Its one action sits in the title row (`CardHeading`). | review |
| K2 | Sections inside a card are separated by `border-t` and 16px, never by nested cards. | lint (rule 13) |
| K3 | A quiet inset (`bg-muted rounded-lg p-3`, no shadow) holds detail that belongs to one row (expanded variant, address, line item). | review |
| K4 | A collapsible card shows its state in one line when closed ("Not a gift card", "2 bundles"). | review |
| K5 | Never place text directly on the page background, except the page title and the empty first-run card. | review |

### Index table

| ID | Rule | Check |
| --- | --- | --- |
| T1 | Every list uses `IndexTable` (today `DataTable` + `ResourceListPage`): never a hand-built `<Table>` for a list of records. | lint → `components/ui/table` imported only by the data-table kit and read-only summaries on the allowlist |
| T2 | Anatomy, top to bottom: page header, view tabs, toolbar (search, filters, sort, columns), rows, pagination. One toolbar layout for every list: search, a "Filters" button, a sort menu, a columns menu. | review |
| T3 | Row height: 52px for rows with a two-line title or a thumbnail, 40px for single-line lists; every row on a page has the same height. | harness → `tbody tr` heights: max − min ≤ 1 |
| T4 | Cells align to the row's vertical centre, including the title cell. | harness → each `td` content box centre = row centre ±2 |
| T5 | Numbers, money and counts align end and use tabular digits; their heading aligns end too. | harness → `td[data-numeric],th[data-numeric]` `text-align: end`, `font-variant-numeric` includes `tabular-nums` |
| T6 | An end-aligned column is followed by ≥24px before a start-aligned column. Put numeric columns at the end of the row where possible. | harness → numeric cell content right edge to next cell content left edge ≥ 24 |
| T7 | Free text truncates at the column's max width with the whole value in a tooltip or `title`. Names may take two lines. Codes never wrap. | harness → every element with `text-overflow: ellipsis` or `-webkit-line-clamp` and overflow has `title` or `aria-describedby` |
| T8 | Column widths follow content: an ID column is as wide as its widest ID, never wider than the name column. | harness → `th` width of an ID/date column ≤ width of the primary column |
| T9 | Sticky header under the top bar; on horizontal scroll the checkbox and title columns stick. | harness → scroll `#admin-main-scroll` 600px: first `thead th` `top` = topbar bottom ±1 |
| T10 | Selection: a checkbox column; Shift+click selects a range. With rows selected, the bulk bar replaces the toolbar in place and stays in view (sticky) while the list scrolls. | harness → select a row, scroll to the end: `[data-slot=bulk-bar]` is inside the viewport |
| T11 | "Select all N" selects the whole filtered set by query, not by gathering rows. At scale the label reads "All 52,341 matching products". | review (needs the API's select-by-filter bulk action) |
| T12 | Default page size 50; the choice is kept per list. One pagination component (`pagination` slot): range label, then Previous/Next. Hide Previous/Next when there is one page. | harness → `[data-slot=pagination]` buttons absent when total ≤ page size |
| T13 | Counts above 1,000 that the API caps read "1,000+"; an exact count is shown only when the API counts it. Never a client-side count of a partial page. | harness → mocked capped total: range label ends with "+" |
| T14 | Phones (<640px container) show cards: title, then one secondary line, then status; the row menu stays. The name keeps priority over the phone number. | review |
| T15 | Rows open by a real link (`<a href>`), so Cmd-click and middle-click open a new tab. | harness → each row has an `a[href]` to its detail page |

### Detail and form page

| ID | Rule | Check |
| --- | --- | --- |
| P1 | Header: back link, title (wraps, never truncates), status badges, one meta line ("Placed Oct 8 at 3:42 PM · Online store"), then secondary actions, "More actions", previous/next. | review |
| P2 | Two columns from 1024px: main ⅔ (the record's content), side ⅓ (status, organization, notes). On phones the side column's status card comes first, the rest after. | harness → at 1440: side column width / main width = 0.5 ±0.05 |
| P3 | One composer per purpose: a record has one place to write a team note. | review |
| P4 | Save is only in the contextual save bar (and Cmd/Ctrl+S). No second Save at the page bottom. | harness → no visible `main button` named Save while `[data-save-bar]` exists |
| P5 | A create page shows its create action (save bar or a footer primary) before the first edit. | review |

### Overlays and feedback

| ID | Rule | Check |
| --- | --- | --- |
| O1 | Dialog: title (names the object), one sentence, body, footer with ≤2 buttons, primary last. Widths: 512px default, 640px for forms, 800px for pickers. | lint (footer ≤2: existing review) · harness → `[data-slot=dialog-content]` width ∈ {512, 640, 800} from 640px |
| O2 | A dialog holds at most 5 fields; more is a page or a sheet. Never a dialog over a dialog. | harness → never two `[role=dialog][data-state=open]` |
| O3 | Destructive confirmation: `AlertDialog`, title "Delete 'Cotton panjabi'?" with the name in quotes, the consequence in one sentence, the destructive button names the action. | review |
| O4 | Sheet: right side, 448px, header, scrolling body, bordered footer. For previews and side tasks that keep the list visible. | review |
| O5 | Toast: noun + past verb, ≤3 words, bottom centre, 4s; 10s with an action. Never for errors that block work (banner) or for validation (field). | lint → catalog test: `toast.*` keys ≤ 3 words |
| O6 | Status badge: always a word, a tone from the status table, never colour alone. | lint (existing) |

### States

Code: `components/admin/states/`. Never hand-build one of these views.

| Situation | Component |
| --- | --- |
| Nothing made yet (E1) | `EmptyState` (icon, action title, one sentence, `action`, `secondaryAction`, help link; one card, or `card={false}` inside one) |
| No match for filters or search (E2) | `FilteredEmptyState` (`title`, `onClearFilters`), where the rows go |
| A card with nothing yet (E3) | `SectionEmpty`, one muted line |
| A failed read (R1, R3) | `ErrorState`: `layout="page"` (the page title stays as h1, Retry is the primary), `"card"` (inside the table or card), and `InlineError` for one card of several (one line and Retry; it downloads nothing more). `what="orders"` reads "Couldn't load orders". The reason comes from the error: offline, unreachable, server down, updated (Reload), fault (Copy details). |
| A record that is gone (R2) | `RecordNotFound`: names the record and links to its list, both from the route path (`record-resource.ts`) |
| No page, no access (R4) | `PageNotFound`, `NoPermissionState` (`area`, `ownerName`) |
| View-only (R5) | `ReadOnlyNotice` (see Read-only mode) |
| Offline (R6) | `OfflineBanner`, drawn by the shell; `useOnlineStatus()` |
| Loading (L1, L2) | `PageSkeleton` (`detail`, `settings`, `index`, `page`) |

Route boundaries come from the router defaults (`lib/route-error.tsx`): a failed loader renders `ErrorState`, a 404 `RecordNotFound`, a 403 `NoPermissionState`; a loader slower than 300 ms (`ROUTE_PENDING_MS`) renders the page's `PageSkeleton` for at least 300 ms. Pages opened most from links (order, product, customer) get their card layout from `PAGE_SHAPES` there; never put a `pendingComponent` in a route file, because the router plugin splits it into a chunk that a cold or offline load must download first. The failed-read view ships with the router; the not-found and no-access views load after the first page. Offline, a page whose code is already in the tab opens with its cached data; any other page waits and opens on reconnect (the banner says so), and failed reads run again. Saves are never queued.

| ID | Rule | Check |
| --- | --- | --- |
| E1 | First-run empty (nothing created yet): one card, icon, an action title ("Add your first product"), one sentence, one primary action, a help link. No table headers, tabs, search or totals around it. | harness → mocked empty list: no `thead`, `[role=tablist]`, search input or second primary in `main` |
| E2 | Filtered empty: inside the table, "No orders match these filters", one sentence, "Clear filters". | harness → search a nonsense term: `[data-slot=empty-state]` contains a "Clear filters" button |
| E3 | Section empty (a card with nothing yet): one muted line, no icon, no illustration. | review |
| L1 | Cold load (a deep link): the shell, the page title and a skeleton paint within 300ms of the app's first render, before data arrives. Never a blank page with a spinner. | harness → API delayed 3s: within 1s of navigation `[data-slot=topbar]` and `h1` are visible |
| L2 | Skeleton shape equals content: the real page title, card titles and table headings; rows to the page size or the viewport; no layout shift on arrival. | harness → API delayed 2s: CLS of `main` from skeleton to data ≤ 0.02 |
| L3 | Show a skeleton or spinner only after 300ms; keep it at least 300ms once shown. | harness → API delayed 200ms: no `.animate-pulse` or `.animate-spin` ever visible |
| L4 | Refetch keeps the old rows readable: no dimming overlay; a 2px progress line or the button's own spinner. | harness → during a refetch, `main` has no element with `bg-background/50` covering rows |
| R1 | One `ErrorState` for a failed read: the page title stays, what failed ("Couldn't load orders"), why when known, Retry, and where to go. Never "Nothing changed" for a read. | harness → main read returns 500: `[data-slot=error-state]` contains `h1` text, a Retry button; topbar and navigation stay |
| R2 | Not found names the record and links to its list: "This gift card doesn't exist or was deleted" + "Back to gift cards". | harness → `/admin/<resource>/missing-id`: `[data-slot=error-state] a[href$=<list route>]` |
| R3 | Partial data: when one read of several fails, the others render; the failed card shows a one-line error with Retry. | harness → fail one secondary read: other cards still render |
| R4 | No permission for the page: a page that names the area and the person to ask (the store owner's name). | review |
| R5 | View-only permission on a page: one `ReadOnlyNotice` banner at the top; values show as plain text, not disabled inputs; no create, delete or save controls. | harness → view-only session: no enabled control that would send a mutating request; `[data-slot=read-only-notice]` present |
| R6 | Offline: a banner under the top bar within 2s ("You're offline. Your changes stay here until you reconnect."); saves wait, never fail silently; reads retry on reconnect. | harness → `context.setOffline(true)`: `[data-slot=offline-banner]` visible within 2s |

### Copy

| ID | Rule | Check |
| --- | --- | --- |
| Y1 | Plain words, newcomer-first, sentence case, no jargon (no cron strings, raw IDs, HTTP codes, "Nothing changed"). | review · lint → catalog test bans `cron`, `HTTP`, `null`, `undefined`, `Error:` |
| Y2 | Buttons: verb + noun ("Add product"), no articles, no "Please", no "!". | lint → catalog test: button keys match `^[A-Z][a-z]+( [^ ]+){0,3}$` and have no `!` |
| Y3 | Titles of empty states are actions; error titles say what failed in ≤6 words. | review |
| Y4 | Use "…" (one character) for loading and for menu items that open a dialog. | lint → catalog test bans `...` |
| Y5 | Every visible word comes from the catalogs in both languages; app, theme and seed defaults that show in the dashboard are translated too. | harness → bn: visible text matching `/\b[A-Za-z]{4,}( [a-z]{3,})+/` outside data cells and the allowlist = 0 |

### Motion and latency

| ID | Rule | Check |
| --- | --- | --- |
| M1 | Every press shows a visual response within 100ms (pressed state, spinner in the button, optimistic change). | harness → click a primary action with the API delayed 2s: within 100ms the button has `aria-busy` or the target changed |
| M2 | Optimistic updates for reversible single-record changes (status, tag, assign, toggle); roll back with an error toast on failure. | review |
| M3 | Hover is instant; animate only transform, opacity or size; ≤200ms; reduced motion turns it off. | lint (existing rule 7) |
| M4 | Mutations under 500ms show no toast-level spinner; longer work (export, import, bulk on >90 rows) runs as a job with progress and a done toast. | review |

### Keyboard and focus

| ID | Rule | Check |
| --- | --- | --- |
| Q1 | Every action reachable by Tab, in reading order; the focus ring is 2px `ring-ring` and never hidden under the top bar or save bar. | harness → Tab through `main`: each focused element's top ≥ topbar bottom and its outline is visible |
| Q2 | `Esc` closes the top overlay and returns focus to its trigger. | harness → open each dialog, press Esc: `document.activeElement` is the trigger |
| Q3 | Shortcuts come from `shortcuts.ts`: `Cmd/Ctrl+K` search, `/` list search, `Cmd/Ctrl+S` save, `Cmd/Ctrl+Enter` send or submit, `?` the list. Index lists add `J`/`K` to move and `X` to select (Linear). | review |
| Q4 | Menus, listboxes and tabs move with arrow keys; Home/End jump. | review (Radix) |

### Collaboration

Presence must be impossible to miss, as in Figma, Google Docs and Linear.

| ID | Rule | Check |
| --- | --- | --- |
| W1 | Avatars of everyone on the record sit in the page header beside the title: 28px circles, a stable colour per person, initials, the name on hover and focus, at most 3 then "+N". The space is reserved, so arriving people never move the page. | harness → inject presence: `[data-slot=page-header] [data-slot=presence]` holds ≥1 avatar with an accessible name; `main` CLS = 0 |
| W2 | When someone else is editing the same record, a banner under the header says "Rahim is editing this product. You can both edit; changes to different fields combine." | harness → inject presence: `[data-slot=presence-banner]` visible |
| W3 | A field another person has focused shows a 2px ring in their colour and their first name on a tag at its top end. | review (needs field-level presence in the hub) |
| W4 | After a merged save, one notice: "Rahim saved changes. Your edits are kept." with "Load latest"; a same-field clash opens the merge choice dialog. | harness → inject `saved`: `[data-slot=alert]` with "Load latest" |
| W5 | Lists show presence: a small avatar on a row someone has open (orders, products, inbox conversations). | review |
| W6 | Presence appears on every editor and on order and conversation pages, not only on forms. | review |

### Bangla and long text

| ID | Rule | Check |
| --- | --- | --- |
| N1 | No clipped text: no fixed height on an element that holds text; Bangla vowel signs never cut. | harness → bn: every visible text element with `overflow: hidden` has `scrollHeight ≤ clientHeight + 1` |
| N2 | No horizontal page scroll at any width ≥ 360px. | harness → `document.scrollingElement` and `#admin-main-scroll`: `scrollWidth ≤ clientWidth` |
| N3 | Buttons, tabs, labels and headings never truncate; they wrap or grow. Placeholders fit their field in both languages. | harness → no `button,label,[role=tab],h1,h2,h3` with `scrollWidth > clientWidth`; input placeholder width ≤ input content width |
| N4 | Long names: two lines then an ellipsis in lists, wrap in titles; long codes and URLs break anywhere (`overflow-wrap: anywhere`). | review |
| N5 | A filter row that does not fit wraps under the search; on phones filters fold into one "Filters" button. | harness → 390px: the toolbar is ≤ 2 rows tall (≤ 96px) |
| N6 | Copy fits Bangla: budget 30% more width than English for buttons and tabs. | review |

### Large stores

Every list and picker must work at 100,000 rows.

| ID | Rule | Check |
| --- | --- | --- |
| X1 | Server paging for every list: ≤100 rows in the DOM per table; no request for "all" records. | lint → no query option with `limit` ≥ 500 outside the allowlist · harness → `tbody tr` ≤ 100 |
| X2 | Search, filter and sort run on the server, debounced 300ms, with the previous rows kept while it loads. | review |
| X3 | Pickers (products, customers, collections, categories, countries, places) search on the server and page (`SearchableSelect` `load`). A picker never downloads its whole list. | review |
| X4 | A list inside one record (variants, line items, menu items, zone areas) shows the first 50 and searches or pages beyond; >100 rows render virtualized. | review |
| X5 | Counts that the API caps show "1,000+"; totals and sums come from the API, never from a page. | harness (T13) |
| X6 | Bulk actions on a filtered set run as one server job with progress, not as client loops over rows. | review |
| X7 | Exports and imports run in the background with a progress row and a notice when done. | review |
| X8 | The theme editor, navigation editor and category tree stay usable with 5,000 products, 500 categories and 200 menu items: lazy children, search, no full-tree render. | review |

## Lint

`eslint.config.js` applies these rules as `error` to `src/**/*.tsx`, including `src/components/ui/**`. Test files are excluded.

`@shadcn/lint` (behavior is defined by the plugin):

| Rule | Approved exception |
| --- | --- |
| `no-restyle` | Pass layout classes (margin, size, position, z-index, grid templates, icon alignment) to primitives. Titles (`CardTitle`, `DialogTitle`, `SheetTitle`, `AlertDialogTitle`) also take a type-scale class. `Card`, `CardContent`, `CardHeader`, `CardFooter`, `DialogContent`, `SheetContent`, `PopoverContent`, `TableCell`, `TableHead` and `TabsContent` also take spacing. |
| `no-raw-colors` | None. |
| `no-arbitrary-values` | Layout values and `transition-[property]`. |
| `no-inline-styles` | Runtime values only as custom properties: `style={{ "--swatch": merchantColour }}` with `bg-(--swatch)`. |
| `no-unknown-classes` | `rich-content` and `ProseMirror` (stylesheet classes). |
| `require-static-classes` | None. |

`no-restricted-syntax` checks class strings in `className`, `cn`, `cva`, `clsx`, `cx` and `...ClassName` constants. It enforces every rule marked (lint) above, `dark:` variants, `NativeSelect` and the raw `<select>`. `no-restricted-imports` (all of `src/**/*.{ts,tsx}`) rejects `@radix-ui/react-select`, `components/ui/select` and `native-select`, and `toast` from `sonner` (import it from `~/lib/toast`; `src/lib/toast.ts` is the one exception).

For any other exception, write `// eslint-disable-next-line <rule> -- reason`.

## Raw color to token

Use this map when you convert pasted code. Delete every `dark:` class, `tracking-*`, `uppercase`, `transition-colors` and `transition-all`.

- Hue: emerald and green are `success`. Amber and orange are `warning`. Yellow is `caution`. Red and rose are `critical` (`destructive` on buttons). Sky, blue, indigo, cyan, teal, violet and purple are `info`.
- Shade: a `-50`/`-100` background is `bg-{tone}-surface`, a `-200`/`-300` border is `border-{tone}`, a `-500`/`-600` background is `bg-{tone}` with `text-{tone}-foreground`, and `-600` to `-800` text is `text-{tone}`.
- Grey (gray, zinc, slate, neutral): a `-50`/`-100` background is `bg-muted`, `-200` is `bg-secondary` or `border-border`, `-400` to `-600` text is `text-muted-foreground`, `-700` to `-900` text is `text-foreground` and a `-800` to `-950` background is `bg-topbar` or `bg-card`.
- `bg-white` is `bg-card`. `bg-black/50` to `bg-black/80` is `bg-overlay`. `text-white` on a fill is `text-{tone}-foreground`.
- Size and weight: `text-xs` is `text-caption` (badges, column headings, shortcuts only), else `text-body`. `text-sm` and `text-[8px]` to `text-[13px]` are `text-body`. `text-base` is `text-body-lg` or `text-heading-md`. `text-lg` and `text-xl` are `text-heading-lg`. `text-2xl` and larger are `text-heading-xl`. `font-bold` is `font-semibold`.
