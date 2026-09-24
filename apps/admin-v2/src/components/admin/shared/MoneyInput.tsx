import * as React from "react";
import { requiresWholeCashAmounts } from "@scalius/shared/money";
import { NumberInput } from "~/components/ui/number-input";
import { useCurrency } from "~/hooks/use-currency";
import { useMessages } from "~/i18n";
import { formMessages } from "~/i18n/forms";

type MoneyInputProps = Omit<React.ComponentProps<typeof NumberInput>, "integer" | "wholeUnitsMessage"> & {
  /** The amount's currency: the store's for catalog prices, the order's for refunds and charges. */
  currencyCode: string;
};

/**
 * An amount of money. Taka amounts are whole numbers, so in BDT the field
 * takes no decimal point and says why; other currencies keep their minor units.
 */
export const MoneyInput = React.forwardRef<HTMLInputElement, MoneyInputProps>(({ currencyCode, ...props }, ref) => {
  const t = useMessages(formMessages);
  return (
    <NumberInput
      ref={ref}
      {...props}
      wholeUnitsMessage={requiresWholeCashAmounts(currencyCode) ? t("wholeTaka") : undefined}
    />
  );
});
MoneyInput.displayName = "MoneyInput";

/** True when the store currency is paid in whole units only (BDT: whole taka). */
export function useWholeCashAmounts(): boolean {
  const { code } = useCurrency();
  return requiresWholeCashAmounts(code);
}
