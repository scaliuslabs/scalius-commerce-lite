// Asks the API what the store uses (more than one language, any price list)
// and records it for the sidebar (`lib/store-reach.ts`). Loaded after the
// first page, reads each list at most every ten minutes, and renders nothing.
// An unreadable answer (a staff member without the settings permission)
// keeps the page listed: only a confirmed "not used" hides it.
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getApiV1AdminPriceLists, getApiV1AdminSettingsLanguages } from "@scalius/api-client/sdk";
import { apiData } from "./api";
import { priceListKeys } from "./api-query-options/price-lists";
import { translationKeys } from "./api-query-options/translations";
import { setStoreReach } from "./store-reach";

const REFRESH_MS = 10 * 60_000;

export default function StoreReachProbe({ languages, priceLists }: { languages: boolean; priceLists: boolean }) {
  const languageList = useQuery({
    queryKey: translationKeys.languages(),
    queryFn: async () => (await apiData(getApiV1AdminSettingsLanguages())).items,
    enabled: languages,
    staleTime: REFRESH_MS,
    refetchOnWindowFocus: false,
  });
  const priceListList = useQuery({
    queryKey: priceListKeys.list(),
    queryFn: async () => (await apiData(getApiV1AdminPriceLists({ query: {} }))).items,
    enabled: priceLists,
    staleTime: REFRESH_MS,
    refetchOnWindowFocus: false,
  });
  const translations = languageList.data ? languageList.data.length > 1 : languageList.isError ? true : undefined;
  const lists = priceListList.data ? priceListList.data.length > 0 : priceListList.isError ? true : undefined;
  useEffect(() => {
    if (translations !== undefined) setStoreReach({ translations });
  }, [translations]);
  useEffect(() => {
    if (lists !== undefined) setStoreReach({ priceLists: lists });
  }, [lists]);
  return null;
}
