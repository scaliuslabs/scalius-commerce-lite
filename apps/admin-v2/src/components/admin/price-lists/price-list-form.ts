// A price list's editor values and the requests they save (docs/MARKETS-DESIGN.md
// D5), and the price grid's rows: each SKU's price for one unit, its
// compare-at price and its quantity breaks, as the merchant types them.
// Schedule times are the store's wall time (as discounts show them).
import { MAX_PRICE_LIST_QUANTITY_BREAKS, PRICE_LIST_MIN_QUANTITY_MAX, PRICE_LIST_PRIORITY_MAX } from "@scalius/shared/market-pricing";
import { epochToStoreTime, latinDigits, storeTimeToEpoch } from "~/components/admin/discounts/discount-form";
import { formatOrderTimestamp } from "~/components/admin/orderview/formatters";
import type { PriceListMessageKey } from "~/i18n/price-lists";
import type {
  PriceList,
  PriceListVariant,
  SetPriceListPricesBody,
  UpdatePriceListBody,
} from "~/lib/api-query-options/price-lists";

export type PriceListKind = PriceList["kind"];
export const PRICE_LIST_KINDS: readonly PriceListKind[] = ["market", "segment", "sale"];
export const KIND_LABEL: Readonly<Record<PriceListKind, PriceListMessageKey>> = {
  market: "kindMarket",
  segment: "kindSegment",
  sale: "kindSale",
};
export const KIND_HELP: Readonly<Record<PriceListKind, PriceListMessageKey>> = {
  market: "kindMarketHelp",
  segment: "kindSegmentHelp",
  sale: "kindSaleHelp",
};

type Messages = (key: PriceListMessageKey, vars?: Record<string, string | number>) => string;

/** "Always", "From …", "Until …" or "… to …", in store time. */
export function scheduleText(list: Pick<PriceList, "startsAt" | "endsAt">, t: Messages): string {
  const start = formatOrderTimestamp(list.startsAt);
  const end = formatOrderTimestamp(list.endsAt);
  if (start && end) return t("betweenDates", { start, end });
  if (start) return t("fromDate", { date: start });
  if (end) return t("untilDate", { date: end });
  return t("always");
}

export interface PriceListForm {
  name: string;
  description: string;
  status: "draft" | "active";
  priority: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
}

export const EMPTY_PRICE_LIST_FORM: PriceListForm = {
  name: "",
  description: "",
  status: "draft",
  priority: "0",
  startDate: "",
  startTime: "",
  endDate: "",
  endTime: "",
};

function wallTime(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  return epochToStoreTime(Math.floor(new Date(iso).getTime() / 1_000));
}

/** The editor values of a saved list, with the revision it saves against. */
export function priceListForm(list: PriceList): PriceListForm & { revision: number } {
  const start = wallTime(list.startsAt);
  const end = wallTime(list.endsAt);
  return {
    name: list.name,
    description: list.description ?? "",
    status: list.status,
    priority: String(list.priority),
    startDate: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
    revision: list.revision,
  };
}

function instant(date: string, time: string): string | null | undefined {
  if (!date) return null;
  const epoch = storeTimeToEpoch(date, time || "00:00");
  return epoch === null ? undefined : new Date(epoch * 1_000).toISOString();
}

export type PriceListFormProblems = Partial<Record<"name" | "priority" | "start" | "end", PriceListMessageKey>>;

export function priceListFormProblems(form: PriceListForm): PriceListFormProblems {
  const problems: PriceListFormProblems = {};
  if (!form.name.trim()) problems.name = "nameRequired";
  const priority = Number(latinDigits(form.priority.trim()));
  if (!Number.isInteger(priority) || priority < 0 || priority > PRICE_LIST_PRIORITY_MAX) problems.priority = "priorityInvalid";
  const start = instant(form.startDate, form.startTime);
  const end = instant(form.endDate, form.endTime);
  if (start === undefined) problems.start = "endBeforeStart";
  if (end === undefined) problems.end = "endBeforeStart";
  if (start && end && end <= start) problems.end = "endBeforeStart";
  return problems;
}

/** The PATCH body: every editable field, under the revision the editor loaded. */
export function priceListUpdateBody(form: PriceListForm, expectedRevision: number): UpdatePriceListBody {
  return {
    expectedRevision,
    name: form.name.trim(),
    description: form.description.trim() || null,
    status: form.status,
    priority: Number(latinDigits(form.priority.trim())) || 0,
    startsAt: instant(form.startDate, form.startTime) ?? null,
    endsAt: instant(form.endDate, form.endTime) ?? null,
  };
}

// ---------------------------------------------------------------------------
// The price grid
// ---------------------------------------------------------------------------

export interface GridBreak {
  key: string;
  minQuantity: number | null;
  amount: number | null;
}

/** One SKU of the grid as the merchant edits it (major units; NaN is a refused entry). */
export interface GridRow {
  variantId: string;
  productName: string;
  variantLabel: string | null;
  sku: string;
  basePrice: number;
  amount: number | null;
  compareAt: number | null;
  breaks: GridBreak[];
}

let breakSeed = 0;
export const newBreakKey = () => `b${(breakSeed += 1)}`;

/** A saved SKU's grid row (its prices in the list's currency). */
export function gridRow(variant: PriceListVariant): GridRow {
  const base = variant.prices.find((price) => price.minQuantity === 1);
  return {
    variantId: variant.variantId,
    productName: variant.productName,
    variantLabel: variant.variantLabel,
    sku: variant.sku,
    basePrice: variant.basePrice,
    amount: base?.amount ?? null,
    compareAt: base?.compareAt ?? null,
    breaks: variant.prices
      .filter((price) => price.minQuantity > 1)
      .sort((left, right) => left.minQuantity - right.minQuantity)
      .map((price) => ({ key: newBreakKey(), minQuantity: price.minQuantity, amount: price.amount })),
  };
}

/** A SKU added from the picker: priced at its product price until the merchant types one. */
export function newGridRow(variant: { id: string; productName: string | null; optionLabel: string | null; sku: string; price: number }): GridRow {
  return {
    variantId: variant.id,
    productName: variant.productName ?? "",
    variantLabel: variant.optionLabel,
    sku: variant.sku,
    basePrice: variant.price,
    amount: variant.price,
    compareAt: null,
    breaks: [],
  };
}

export const canAddBreak = (row: GridRow) => row.breaks.length < MAX_PRICE_LIST_QUANTITY_BREAKS - 1;

/** The next break a row offers: twice the largest quantity so far (at least 2), at the row's price. */
export function nextBreak(row: GridRow): GridBreak {
  const largest = Math.max(1, ...row.breaks.map((tier) => tier.minQuantity ?? 1));
  return { key: newBreakKey(), minQuantity: Math.min(largest * 2, PRICE_LIST_MIN_QUANTITY_MAX), amount: null };
}

const positive = (value: number | null) => value !== null && Number.isFinite(value) && value > 0;

/** What is wrong with a row, if anything (the API checks the price increment). */
export function gridRowProblem(row: GridRow): PriceListMessageKey | null {
  if (!positive(row.amount)) return "priceRequired";
  if (row.compareAt !== null && !(Number.isFinite(row.compareAt) && row.compareAt > row.amount!)) return "compareAtAbove";
  const quantities = new Set<number>();
  for (const tier of row.breaks) {
    const quantity = tier.minQuantity;
    if (quantity === null || !Number.isInteger(quantity) || quantity < 2 || quantity > PRICE_LIST_MIN_QUANTITY_MAX) return "breakQuantity";
    if (quantities.has(quantity)) return "breakDuplicate";
    quantities.add(quantity);
    if (!positive(tier.amount)) return "breakPriceRequired";
  }
  return null;
}

/** The tiers a row saves: its price for one unit, then its breaks by quantity. */
export function rowPrices(row: GridRow): NonNullable<SetPriceListPricesBody["set"]>[number]["prices"] {
  return [
    { amount: row.amount!, compareAt: row.compareAt, minQuantity: 1 },
    ...row.breaks
      .map((tier) => ({ amount: tier.amount!, minQuantity: tier.minQuantity! }))
      .sort((left, right) => left.minQuantity - right.minQuantity),
  ];
}

const rowKey = (row: GridRow) => JSON.stringify(rowPrices(row));

/** Whether the merchant changed a row since it was loaded (a new row always counts). */
export function rowChanged(loaded: GridRow | undefined, row: GridRow): boolean {
  return !loaded || rowKey(loaded) !== rowKey(row);
}

/**
 * The PUT body for the grid: the rows that differ from what was loaded (or
 * are new) are set, and loaded rows the merchant removed are removed.
 */
export function gridChanges(loaded: readonly GridRow[], rows: readonly GridRow[], removed: readonly string[], expectedRevision: number): SetPriceListPricesBody {
  const before = new Map(loaded.map((row) => [row.variantId, row]));
  return {
    expectedRevision,
    set: rows
      .filter((row) => rowChanged(before.get(row.variantId), row))
      .map((row) => ({ variantId: row.variantId, prices: rowPrices(row) })),
    remove: removed.filter((variantId) => before.has(variantId)),
  };
}
