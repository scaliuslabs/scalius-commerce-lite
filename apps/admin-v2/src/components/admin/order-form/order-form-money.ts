import { useCurrency } from "~/hooks/use-currency";
import { useOrderCurrency } from "~/hooks/use-order-currency";
import { useOrderForm } from "./OrderFormContext";

/** Money in the order form's currency (a new order's: the store's; an amended order's own): its code and a formatter. */
export function useOrderFormMoney(): { code: string; fmt: (amount: number | string) => string } {
  const { currencyCode } = useOrderForm();
  const { code: storeCode } = useCurrency();
  const { fmtIn } = useOrderCurrency();
  const code = currencyCode ?? storeCode;
  return { code, fmt: (amount) => fmtIn(amount, code) };
}
