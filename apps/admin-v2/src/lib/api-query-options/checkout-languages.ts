import { queryOptions } from "@tanstack/react-query";
import {
  getCheckoutLanguages,
  type CheckoutLanguagesQueryInput,
} from "../api-functions/checkout-languages";
import { queryKeys } from "../query-keys";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;

export const checkoutLanguagesQueryOptions = (
  params: CheckoutLanguagesQueryInput,
) =>
  queryOptions({
    queryKey: queryKeys.settings.checkoutLanguages(params),
    queryFn: () => getCheckoutLanguages({ data: params }),
    staleTime: CONFIG_STALE_TIME_MS,
  });
