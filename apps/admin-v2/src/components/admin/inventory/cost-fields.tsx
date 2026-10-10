// Figures shared by the product editor and the inventory list (both edit
// costs; neither is ever shown to buyers). The cost field is `CostInput` in
// `shared/MoneyInput`.
import { formatNumber } from "~/i18n";

/** "32.5%": a margin with one decimal in the dashboard's digits; "—" without one. */
export function formatMargin(margin: number | null | undefined): string {
  if (margin === null || margin === undefined) return "—";
  return formatNumber(margin / 100, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
