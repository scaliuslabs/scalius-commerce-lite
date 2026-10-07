# Dashboard design system

Binding rules for every contributor to `apps/admin-v2`. The look follows Shopify admin (Polaris). The discipline follows Cloudflare Kumo's design rules (a reference, not a dependency). The primitives are shadcn/ui on Radix (`src/components/ui/`). Token values, the type scale and motion are in `src/styles/global.css`, and copy is in `src/i18n/`. `pnpm --filter ./apps/admin-v2 lint` enforces part of this document as errors (see [Lint](#lint)). Rules without a "(lint)" mark are review rules: follow them anyway.

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
- Write counts with the plural syntax in the catalog: `{count, plural, one {# variant} other {# variants}}` (CLDR rules for the dashboard language; `=0 {…}` for an exact number). Never write "1 variants". Bangla needs no branches.
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
- Apps' columns are data-backed (`dataColumns`): the list reads the values in its one read; their priority stays below every list's working set.
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
