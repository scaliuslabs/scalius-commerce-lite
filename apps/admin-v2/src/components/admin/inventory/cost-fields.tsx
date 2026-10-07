// The unit-cost field and figures shared by the product editor and the
// inventory list (both edit costs; neither is ever shown to buyers).
import * as React from "react";
import { cn } from "@scalius/shared/utils";
import { NumberInput } from "~/components/ui/number-input";
import { formatNumber } from "~/i18n";

type CostInputProps = Omit<React.ComponentProps<typeof NumberInput>, "integer" | "wholeUnitsMessage"> & {
  /** The store currency symbol, shown inside the field. */
  symbol: string;
};

/**
 * A unit cost in the store currency. Not a cash amount, so it keeps paisa
 * even in taka (a price field would refuse them): ৳12.50 per piece is a real
 * supplier price. Empty means no cost.
 */
export const CostInput = React.forwardRef<HTMLInputElement, CostInputProps>(({ symbol, className, ...props }, ref) => (
  <div className="relative">
    <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 inset-s-3 flex items-center text-body text-muted-foreground">
      {symbol}
    </span>
    <NumberInput
      ref={ref}
      placeholder="0.00"
      {...props}
      // eslint-disable-next-line shadcn/no-restyle -- room for the currency symbol inside the field
      className={cn("ps-7", className)}
    />
  </div>
));
CostInput.displayName = "CostInput";

/** "32.5%": a margin with one decimal in the dashboard's digits; "—" without one. */
export function formatMargin(margin: number | null | undefined): string {
  if (margin === null || margin === undefined) return "—";
  return formatNumber(margin / 100, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
