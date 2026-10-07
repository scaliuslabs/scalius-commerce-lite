// What the store has grown into, so the dashboard shows an advanced page
// (Price lists, Translate & adapt) in the sidebar only once the store uses
// it. Before that the page is one click from where it belongs (Settings ›
// Markets, Settings › Languages) and still found by search. Presentation
// only: the pages, the API and agents are unchanged.
//
// This module is in the first download, so it is small: the answer lives in
// a tiny store. The probe that asks the API (`StoreReachProbe`) loads after
// the first page, and the last answer is kept in this browser so a store
// that uses these pages never sees them pop in.
import { useSyncExternalStore } from "react";
import type { VisibleNavItem } from "~/components/admin/layout/AdminNav";

export interface StoreReach {
  /** The store sells in more than one language. */
  translations: boolean;
  /** The store has a price list. */
  priceLists: boolean;
}

const STORAGE_KEY = "scalius:store-reach";
const listeners = new Set<() => void>();

function remembered(): StoreReach {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<StoreReach>;
    return { translations: stored.translations === true, priceLists: stored.priceLists === true };
  } catch {
    return { translations: false, priceLists: false };
  }
}

let current: StoreReach = remembered();

/** Records what the API said (the probe's job); an unchanged answer changes nothing. */
export function setStoreReach(next: Partial<StoreReach>): void {
  const merged = { ...current, ...next };
  if (merged.translations === current.translations && merged.priceLists === current.priceLists) return;
  current = merged;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // A browser that refuses storage just asks again next time.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The pages the store uses: the last answer, until the probe replaces it. */
export function useStoreReach(): StoreReach {
  return useSyncExternalStore(subscribe, () => current, () => current);
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
