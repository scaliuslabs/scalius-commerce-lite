// What the store has grown into, read from data it already keeps. The
// dashboard lists an advanced page (Price lists, Translate & adapt) in the
// navigation only once the store uses it. Before that the page is one click
// from where it belongs (Settings › Markets, Settings › Languages) and still
// found by search. This is presentation only: the pages, the API and agents
// are unchanged.
import { useQuery } from "@tanstack/react-query";
import { getApiV1AdminPriceLists, getApiV1AdminSettingsLanguages } from "@scalius/api-client/sdk";
import { apiData } from "./api";
import { priceListKeys } from "./api-query-options/price-lists";
import { translationKeys } from "./api-query-options/translations";
import type { VisibleNavItem } from "~/components/admin/layout/AdminNav";

export interface StoreReach {
  /** The store sells in more than one language. */
  translations: boolean;
  /** The store has a price list. */
  priceLists: boolean;
}

const STORAGE_KEY = "scalius:store-reach";
const REFRESH_MS = 10 * 60_000;

/** The last answer in this browser, so a store that uses these pages never sees them pop in. */
function remembered(): StoreReach {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<StoreReach>;
    return { translations: stored.translations === true, priceLists: stored.priceLists === true };
  } catch {
    return { translations: false, priceLists: false };
  }
}

function remember(reach: StoreReach): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(reach));
  } catch {
    // A browser that refuses storage just asks again next time.
  }
}

/**
 * The pages the store uses. An unreadable answer (a staff member without the
 * settings permission) keeps the page listed: only a confirmed "not used"
 * hides it.
 */
export function useStoreReach(canOpen: (path: string) => boolean): StoreReach {
  const languages = useQuery({
    queryKey: translationKeys.languages(),
    queryFn: async () => (await apiData(getApiV1AdminSettingsLanguages())).items,
    enabled: canOpen("/admin/translations"),
    staleTime: REFRESH_MS,
    refetchOnWindowFocus: false,
  });
  const priceLists = useQuery({
    queryKey: priceListKeys.list(),
    queryFn: async () => (await apiData(getApiV1AdminPriceLists({ query: {} }))).items,
    enabled: canOpen("/admin/price-lists"),
    staleTime: REFRESH_MS,
    refetchOnWindowFocus: false,
  });
  const hint = remembered();
  const reach: StoreReach = {
    translations: languages.data ? languages.data.length > 1 : languages.isError || hint.translations,
    priceLists: priceLists.data ? priceLists.data.length > 0 : priceLists.isError || hint.priceLists,
  };
  if ((languages.data || priceLists.data) && (reach.translations !== hint.translations || reach.priceLists !== hint.priceLists)) {
    remember(reach);
  }
  return reach;
}

/** The sidebar's list: the same sections, minus the advanced pages the store does not use yet. */
export function withoutUnusedPages(nav: readonly VisibleNavItem[], reach: StoreReach): VisibleNavItem[] {
  const unused = new Set<string>();
  if (!reach.priceLists) unused.add("priceLists");
  if (!reach.translations) unused.add("translations");
  if (unused.size === 0) return [...nav];
  return nav.map((item) => {
    const children = item.children.filter((child) => child.label !== undefined || !unused.has(child.key));
    // A section whose only page is an unused one (a translator's Content) keeps it.
    return children.length === 0 ? item : { ...item, children };
  });
}
