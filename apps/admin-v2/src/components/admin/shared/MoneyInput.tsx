import * as React from "react";
import { requiresWholeCashAmounts } from "@scalius/shared/money";
import { cn } from "@scalius/shared/utils";
import { NumberInput } from "~/components/ui/number-input";
import { useCurrency } from "~/hooks/use-currency";
import { useMessages } from "~/i18n";
import { formMessages } from "~/i18n/forms";

type MoneyInputProps = Omit<React.ComponentProps<typeof NumberInput>, "integer" | "wholeUnitsMessage"> & {
  /** The amount's currency: the store's for catalog prices, the order's for refunds and charges. */
  currencyCode: string;
  /** Shown inside the field before the amount (the currency symbol, "৳"), for fields without a label that says it. */
  prefix?: string;
};

/**
 * An amount of money. Taka amounts are whole numbers, so in BDT the field
 * takes no decimal point and says why; other currencies keep their minor units.
 */
export const MoneyInput = React.forwardRef<HTMLInputElement, MoneyInputProps>(({ currencyCode, prefix, className, ...props }, ref) => {
  const t = useMessages(formMessages);
  const input = (
    <NumberInput
      ref={ref}
      {...props}
      // eslint-disable-next-line shadcn/no-restyle -- room for the currency symbol inside the field
      className={cn(prefix && "pl-7", className)}
      wholeUnitsMessage={requiresWholeCashAmounts(currencyCode) ? t("wholeTaka") : undefined}
    />
  );
  if (!prefix) return input;
  return (
    <div className="relative">
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-body text-muted-foreground">
        {prefix}
      </span>
      {input}
    </div>
  );
});
MoneyInput.displayName = "MoneyInput";

/** True when the store currency is paid in whole units only (BDT: whole taka). */
export function useWholeCashAmounts(): boolean {
  const { code } = useCurrency();
  return requiresWholeCashAmounts(code);
}
