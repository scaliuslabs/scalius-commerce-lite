// Address rules (MARKETS-DESIGN D7): the countries an address can be in and
// one country's fields, from the public API (the table never ships in the
// dashboard bundle). They change only with a release, so they never go stale.
import { queryOptions } from "@tanstack/react-query";
import { getApiV1AddressRules, getApiV1AddressRulesByCountryCode } from "@scalius/api-client/sdk";
import type { AddressRules } from "@scalius/shared/address";
import { apiData } from "../api";
import { queryKeys } from "../query-keys";

export const addressCountriesQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.addressRules.countries(),
    queryFn: async () => (await apiData(getApiV1AddressRules())).countries,
    staleTime: Infinity,
    gcTime: Infinity,
  });

export const addressRulesQueryOptions = (countryCode: string) =>
  queryOptions({
    queryKey: queryKeys.addressRules.country(countryCode),
    queryFn: async () => (await apiData(getApiV1AddressRulesByCountryCode({ path: { countryCode } }))) as AddressRules,
    staleTime: Infinity,
    gcTime: Infinity,
  });
