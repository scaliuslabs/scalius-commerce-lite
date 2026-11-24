// One add-on row of a money summary ("GAMEGHOR Protection ৳700"), as every
// surface draws it: the cart page, the drawer, the payment step, the quick
// checkout, the receipt and the account order. A row with the app's detail
// lines opens to them: a native <details> (no script, so the server-drawn
// receipt opens too) whose bar keeps the title and the amount in sight,
// open or closed. Each surface's look (its row and amount classes) is here
// too, so the row reads like the rows around it.
import type { AddOnTotalRow } from "@scalius/shared/add-on-totals";
import { fromMinor } from "@scalius/shared/money";
import { formatMoney } from "@/lib/currency";

/** Each surface's row and amount classes: those of the money rows it draws around the row. */
const LOOKS = {
  cart: ["flex justify-between gap-3 text-sm text-muted-foreground", "shrink-0 font-medium tabular-nums text-foreground"],
  drawer: ["flex items-center justify-between gap-3 text-muted-foreground", "shrink-0 tabular-nums"],
  payment: ["flex justify-between", ""],
  quick: ["flex justify-between gap-3 text-muted-foreground", "shrink-0 font-medium tabular-nums text-foreground"],
  receipt: ["flex justify-between gap-4 text-muted-foreground", "shrink-0 whitespace-nowrap font-medium text-foreground"],
  account: ["flex justify-between gap-4 text-muted-foreground", "text-end tabular-nums"],
} as const;
export type AddOnRowLook = keyof typeof LOOKS;

/** Text and attribute values as HTML (the app's words are never markup). */
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** A row's identity across draws: its app and title (the server's rows are one per app and title). */
export const addOnRowKey = (row: AddOnTotalRow): string => `${row.appId ?? ""}:${row.title}`;

/**
 * The row's markup: `<div data-summary-row="add-on">` without details;
 * with them `<details data-summary-row="add-on" data-part="add-on-details">`,
 * its `<summary>` the title, a decorative chevron and the amount, then the
 * lines in order, each `data-part="add-on-detail"`. Text is escaped.
 */
export function addOnRowHtml(row: AddOnTotalRow, amount: string, look: AddOnRowLook, open = false): string {
  const [rowClass, amountClass] = LOOKS[look];
  const key = ` data-add-on-key="${escapeHtml(addOnRowKey(row))}"`;
  const value = `<span class="${amountClass}">${escapeHtml(amount)}</span>`;
  if (!row.details?.length) return `<div class="${rowClass}" data-summary-row="add-on"${key}><span class="min-w-0">${escapeHtml(row.title)}</span>${value}</div>`;
  return `<details class="group/add-on" data-summary-row="add-on" data-part="add-on-details"${key}${open ? " open" : ""}>`
    // The bar is the control: 44px tall on a phone, the chevron turning as it opens.
    + `<summary class="${rowClass} min-h-11 cursor-pointer list-none items-center rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:min-h-0 [&::-webkit-details-marker]:hidden">`
    + `<span class="min-w-0">${escapeHtml(row.title)}<svg class="ms-1 inline size-4 align-text-bottom transition-transform group-open/add-on:rotate-180 motion-reduce:transition-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>${value}</summary>`
    + `<ul class="mt-1 space-y-1 border-s border-border ps-3 text-xs text-muted-foreground">${row.details.map((line) => `<li data-part="add-on-detail">${escapeHtml(line)}</li>`).join("")}</ul></details>`;
}

/** Appends the row to `parent` (a summary drawn row by row, the payment step's). */
export function appendAddOnRow(parent: HTMLElement, row: AddOnTotalRow, amount: string, look: AddOnRowLook, open = false): void {
  parent.insertAdjacentHTML("beforeend", addOnRowHtml(row, amount, look, open));
}

/** What a live surface keeps between draws: the keys of the server's rows it showed last (none yet: undefined). */
export interface AddOnRowsShown { keys?: Set<string> }

const drawn = new WeakMap<Element, string>();

/**
 * Draws the rows into `root`, which a surface redraws on every cart change:
 * unchanged rows are left as they are (a row the buyer opened stays open,
 * focus and all); changed ones are drawn again with the open rows still
 * open, and a row the server's rows did not hold before opens by itself
 * (the buyer just added it). `checked`: these are the server's rows (a
 * check answered), so a later new row is the buyer's add, never the page's
 * first answer.
 */
export function drawAddOnRows(
  root: HTMLElement,
  rows: readonly AddOnTotalRow[],
  decimalPlaces: number,
  look: "cart" | "drawer",
  shown: AddOnRowsShown,
  checked: boolean,
): void {
  const before = shown.keys;
  if (checked) shown.keys = new Set(rows.map(addOnRowKey));
  const html = (open?: (key: string) => boolean) => rows.map((row) =>
    addOnRowHtml(row, formatMoney(fromMinor(row.amountMinor, decimalPlaces)), look, open?.(addOnRowKey(row)))).join("");
  const closed = html();
  if (drawn.get(root) === closed) return;
  drawn.set(root, closed);
  const open = openAddOnKeys(root);
  root.innerHTML = html((key) => open.has(key) || (before !== undefined && !before.has(key)));
}

/** The keys of the rows open in `root` now. */
export function openAddOnKeys(root: ParentNode | null | undefined): Set<string> {
  return new Set([...root?.querySelectorAll<HTMLElement>("details[open][data-add-on-key]") ?? []].map((row) => row.dataset.addOnKey!));
}
