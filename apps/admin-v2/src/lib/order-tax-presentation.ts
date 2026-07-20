export interface SavedOrderMoneyFields {
  currencyCode?: string | null;
  currencyDecimalPlaces?: number | null;
  subtotalAmountMinor?: number | null;
  shippingAmountMinor?: number | null;
  discountAmountMinor?: number | null;
  taxAmountMinor?: number | null;
  totalAmountMinor?: number | null;
  taxLabel?: string | null;
  pricesIncludeTax?: boolean | null;
}

export interface SavedOrderMoneySummary {
  currencyCode: string;
  decimalPlaces: number;
  subtotalMinor: number;
  shippingMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  taxLabel: string;
  pricesIncludeTax: boolean;
}

export interface SavedOrderLineMoneyFields {
  unitPriceMinor?: number | null;
  lineSubtotalMinor?: number | null;
  discountAmountMinor?: number | null;
  taxableAmountMinor?: number | null;
  taxAmountMinor?: number | null;
}

type CompleteSavedOrderLineMoney = {
  unitPriceMinor: number;
  lineSubtotalMinor: number;
  discountAmountMinor: number;
  taxableAmountMinor: number;
  taxAmountMinor: number;
};

export interface SavedOrderLineMoneyPresentation {
  unitPriceMinor: number;
  grossSubtotalMinor: number;
  discountMinor: number;
  taxableMinor: number;
  taxMinor: number;
  totalMinor: number;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function resolveSavedOrderMoneySummary(
  order: SavedOrderMoneyFields,
): SavedOrderMoneySummary | null {
  const currencyCode = order.currencyCode?.trim().toUpperCase() ?? "";
  const decimalPlaces = order.currencyDecimalPlaces;
  const taxLabel = order.taxLabel?.trim() ?? "";
  const amounts = [
    order.subtotalAmountMinor,
    order.shippingAmountMinor,
    order.discountAmountMinor,
    order.taxAmountMinor,
    order.totalAmountMinor,
  ];

  if (
    !/^[A-Z]{3}$/.test(currencyCode)
    || decimalPlaces == null
    || !Number.isInteger(decimalPlaces)
    || decimalPlaces < 0
    || decimalPlaces > 3
    || !taxLabel
    || typeof order.pricesIncludeTax !== "boolean"
    || !amounts.every(isNonNegativeSafeInteger)
  ) return null;

  const [subtotalMinor, shippingMinor, discountMinor, taxMinor, totalMinor] = amounts as number[];
  const expectedTotal = subtotalMinor + shippingMinor - discountMinor
    + (order.pricesIncludeTax ? 0 : taxMinor);
  if (!Number.isSafeInteger(expectedTotal) || expectedTotal !== totalMinor) return null;

  return {
    currencyCode,
    decimalPlaces,
    subtotalMinor,
    shippingMinor,
    discountMinor,
    taxMinor,
    totalMinor,
    taxLabel,
    pricesIncludeTax: order.pricesIncludeTax,
  };
}

export function hasSavedOrderLineMoney(
  line: SavedOrderLineMoneyFields,
  summary: SavedOrderMoneySummary | null,
): line is SavedOrderLineMoneyFields & CompleteSavedOrderLineMoney {
  if (!summary) return false;
  const amounts = [
    line.unitPriceMinor,
    line.lineSubtotalMinor,
    line.discountAmountMinor,
    line.taxableAmountMinor,
    line.taxAmountMinor,
  ];
  if (!amounts.every(isNonNegativeSafeInteger)) return false;
  const lineTotalMinor = Number(line.lineSubtotalMinor) - Number(line.discountAmountMinor)
    + (summary.pricesIncludeTax ? 0 : Number(line.taxAmountMinor));
  return Number(line.discountAmountMinor) <= Number(line.lineSubtotalMinor)
    && Number.isSafeInteger(lineTotalMinor)
    && lineTotalMinor >= 0;
}

export function resolveSavedOrderLineMoney(
  line: SavedOrderLineMoneyFields,
  summary: SavedOrderMoneySummary | null,
): SavedOrderLineMoneyPresentation | null {
  if (!hasSavedOrderLineMoney(line, summary) || !summary) return null;
  return {
    unitPriceMinor: line.unitPriceMinor,
    grossSubtotalMinor: line.lineSubtotalMinor,
    discountMinor: line.discountAmountMinor,
    taxableMinor: line.taxableAmountMinor,
    taxMinor: line.taxAmountMinor,
    totalMinor: line.lineSubtotalMinor - line.discountAmountMinor
      + (summary.pricesIncludeTax ? 0 : line.taxAmountMinor),
  };
}

export function formatSavedMinorAmount(
  amountMinor: number,
  summary: Pick<SavedOrderMoneySummary, "currencyCode" | "decimalPlaces">,
): string {
  const amount = amountMinor / 10 ** summary.decimalPlaces;
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: summary.decimalPlaces,
    maximumFractionDigits: summary.decimalPlaces,
    useGrouping: true,
  }).format(amount);
  return `${summary.currencyCode} ${formatted}`;
}

export function formatSavedMajorAmount(
  amountMajor: number,
  summary: Pick<SavedOrderMoneySummary, "currencyCode" | "decimalPlaces">,
): string {
  const factor = 10 ** summary.decimalPlaces;
  return formatSavedMinorAmount(Math.round(amountMajor * factor), summary);
}
