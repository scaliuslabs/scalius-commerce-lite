import * as React from "react";
import {
  cashOnDeliveryIncrementMinor,
  defaultPriceIncrementMinor,
  isWholeUnitIncrement,
  resolvePriceIncrementMinor,
} from "@scalius/shared/currency-policy";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { currencySymbol } from "@scalius/shared/money-format";
import { NumberInput } from "~/components/ui/number-input";
import { useCurrency } from "~/hooks/use-currency";
import { formatNumber, useMessages } from "~/i18n";
import { formMessages } from "~/i18n/forms";
import { useRefusalReporter } from "~/lib/input-refusal-reporter";

type MoneyInputProps = Omit<React.ComponentProps<typeof NumberInput>, "integer" | "wholeUnitsMessage" | "onRefusal" | "prefix" | "suffix"> & {
  /** The amount's currency: the store's for catalog prices, the order's for refunds and charges. Its symbol sits inside the field (F3). */
  currencyCode: string;
  /**
   * Cash a rider or the counter collects: on the cash-on-delivery increment
   * (whole taka in BDT) whatever the store's price increment is.
   */
  cashOnDelivery?: boolean;
};

type MoneyFieldProps = Omit<MoneyInputProps, "cashOnDelivery"> & { whole: boolean };

const MoneyField = React.forwardRef<HTMLInputElement, MoneyFieldProps>(({ currencyCode, whole, ...props }, ref) => {
  const t = useMessages(formMessages);
  const store = useCurrency();
  const code = currencyCode.trim().toUpperCase();
  // The store's own symbol for its currency (Settings → Store details), the standard one for any other.
  const symbol = code === store.code && store.symbol ? store.symbol : currencySymbol(code);
  // In a form built with `useFormWithRefusals`, the field `name` (as in the form) gets the fraction's reason as its error.
  const onRefusal = useRefusalReporter(props.name);
  const digits = getDecimalPlaces(code);
  return (
    <NumberInput
      ref={ref}
      {...props}
      display={(amount) => formatNumber(amount, { minimumFractionDigits: digits, maximumFractionDigits: digits })}
      prefix={symbol}
      onRefusal={onRefusal}
      wholeUnitsMessage={whole ? t(code === "BDT" ? "wholeTaka" : "wholeUnits") : undefined}
    />
  );
});
MoneyField.displayName = "MoneyField";

/**
 * Whether amounts in `currencyCode` are whole units: the store's price
 * increment (Settings → Store details; a BDT store's default is whole taka)
 * for its own currency, else that currency's default.
 */
function useWholeUnits(currencyCode: string): boolean {
  const { code, priceIncrementMinor } = useCurrency();
  const amountCode = currencyCode.trim().toUpperCase();
  const increment = amountCode === code
    ? resolvePriceIncrementMinor(code, priceIncrementMinor)
    : defaultPriceIncrementMinor(amountCode);
  return isWholeUnitIncrement(amountCode, increment);
}

const PriceMoneyInput = React.forwardRef<HTMLInputElement, Omit<MoneyInputProps, "cashOnDelivery">>((props, ref) => (
  <MoneyField ref={ref} {...props} whole={useWholeUnits(props.currencyCode)} />
));
PriceMoneyInput.displayName = "PriceMoneyInput";

/**
 * An amount of money, the currency symbol inside the field before it ("৳ 720"),
 * the same way on every screen (F3). While the store prices in whole units (a BDT store's
 * default: whole taka) the field takes no decimal point and says why; a store
 * that prices in paisa or cents keeps its minor units. Cash on delivery
 * (`cashOnDelivery`) follows its own increment. In a react-hook-form form made
 * with `useFormWithRefusals`, pass the field's `name`: a refused fraction then
 * reads "Taka amounts are whole numbers." as the field's error, not "enter a number".
 */
export const MoneyInput = React.forwardRef<HTMLInputElement, MoneyInputProps>(({ cashOnDelivery, ...props }, ref) => {
  if (!cashOnDelivery) return <PriceMoneyInput ref={ref} {...props} />;
  const code = props.currencyCode.trim().toUpperCase();
  return <MoneyField ref={ref} {...props} whole={isWholeUnitIncrement(code, cashOnDeliveryIncrementMinor(code))} />;
});
MoneyInput.displayName = "MoneyInput";

/**
 * A unit cost in the store currency. Not a cash amount, so it keeps paisa even
 * in taka (a price field would refuse them): ৳12.50 per piece is a real
 * supplier price. Empty means no cost.
 */
export const CostInput = React.forwardRef<HTMLInputElement, Omit<MoneyInputProps, "currencyCode" | "cashOnDelivery">>((props, ref) => (
  <MoneyField ref={ref} {...props} currencyCode={useCurrency().code} whole={false} />
));
CostInput.displayName = "CostInput";

/** True when the store prices in whole units (Settings → Store details; a BDT store's default). */
export function useWholeUnitPrices(): boolean {
  const { code } = useCurrency();
  return useWholeUnits(code);
}
