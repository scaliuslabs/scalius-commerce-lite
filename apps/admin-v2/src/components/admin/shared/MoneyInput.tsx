import * as React from "react";
import {
  cashOnDeliveryIncrementMinor,
  defaultPriceIncrementMinor,
  isWholeUnitIncrement,
  resolvePriceIncrementMinor,
} from "@scalius/shared/currency-policy";
import { cn } from "@scalius/shared/utils";
import { NumberInput } from "~/components/ui/number-input";
import { useCurrency } from "~/hooks/use-currency";
import { useMessages } from "~/i18n";
import { formMessages } from "~/i18n/forms";
import { useRefusalReporter } from "~/lib/input-refusals";

type MoneyInputProps = Omit<React.ComponentProps<typeof NumberInput>, "integer" | "wholeUnitsMessage" | "onRefusal"> & {
  /** The amount's currency: the store's for catalog prices, the order's for refunds and charges. */
  currencyCode: string;
  /** Shown inside the field before the amount (the currency symbol, "৳"), for fields without a label that says it. */
  prefix?: string;
  /**
   * Cash a rider or the counter collects: on the cash-on-delivery increment
   * (whole taka in BDT) whatever the store's price increment is.
   */
  cashOnDelivery?: boolean;
};

type MoneyFieldProps = Omit<MoneyInputProps, "cashOnDelivery"> & { whole: boolean };

const MoneyField = React.forwardRef<HTMLInputElement, MoneyFieldProps>(({ currencyCode, prefix, className, whole, ...props }, ref) => {
  const t = useMessages(formMessages);
  // In a form built with `useFormWithRefusals`, the field `name` (as in the form) gets the fraction's reason as its error.
  const onRefusal = useRefusalReporter(props.name);
  const input = (
    <NumberInput
      ref={ref}
      {...props}
      onRefusal={onRefusal}
      // eslint-disable-next-line shadcn/no-restyle -- room for the currency symbol inside the field
      className={cn(prefix && "pl-7", className)}
      wholeUnitsMessage={whole ? t(currencyCode.trim().toUpperCase() === "BDT" ? "wholeTaka" : "wholeUnits") : undefined}
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
 * An amount of money. While the store prices in whole units (a BDT store's
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

/** True when the store prices in whole units (Settings → Store details; a BDT store's default). */
export function useWholeUnitPrices(): boolean {
  const { code } = useCurrency();
  return useWholeUnits(code);
}
