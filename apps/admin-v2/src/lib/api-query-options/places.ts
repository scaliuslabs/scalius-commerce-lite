import { queryOptions } from "@tanstack/react-query";
import { getApiV1AdminSettingsDeliveryLocationsCountries } from "@scalius/api-client/sdk";
import { apiData } from "../api";
import { queryKeys } from "../query-keys";

const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;

// Settings → Delivery areas only: kept out of the delivery query options that
// order and checkout pages load.
/** The countries that have places, with their place counts. */
export const placeCountriesQueryOptions = () =>
  queryOptions({
    queryKey: [...queryKeys.settings.deliveryLocations(), "countries"],
    queryFn: async () => (await apiData(getApiV1AdminSettingsDeliveryLocationsCountries())).countries,
    staleTime: LOOKUP_STALE_TIME_MS,
  });
