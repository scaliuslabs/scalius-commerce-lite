// A listing page's buyer event (CatalogListingPage.astro writes the facts on
// its root, `data-buyer-listing`): `collection_viewed` for a category, brand
// or collection; `search_submitted` for a search results page, once per query
// in a session (a reload, the next page or a sort says nothing new).

import { BUYER_EVENT_LIMITS } from "@scalius/shared/plugins/buyer-events";
import { normalizeSearchQuery } from "../search-query";
import { emitBuyerEvent } from "./bus";
import { eventText, merchandise } from "./lines";
import { claimOnce } from "./once";

export interface ListingFacts {
  kind: "category" | "brand" | "collection" | "search";
  id: string | null;
  title: string;
  query: string | null;
  products: Array<{ productId: string; title: string; price: number | null }>;
}

/** Emits the listing's event from its facts (the root's JSON); nothing for an unreadable one or a search without words. */
export function emitListingViewed(raw: string): void {
  let facts: ListingFacts;
  try {
    facts = JSON.parse(raw) as ListingFacts;
  } catch {
    return;
  }
  const products = (Array.isArray(facts.products) ? facts.products : [])
    .slice(0, BUYER_EVENT_LIMITS.lines)
    .filter((product) => typeof product?.productId === "string" && product.productId)
    .map((product) => merchandise({ productId: product.productId, title: product.title, price: product.price }));
  if (facts.kind === "search") {
    const query = normalizeSearchQuery(facts.query);
    if (!query || !claimOnce(`Search:${query}`)) return;
    emitBuyerEvent("search_submitted", { query: eventText(query), results: products });
    return;
  }
  if (facts.kind !== "category" && facts.kind !== "brand" && facts.kind !== "collection") return;
  emitBuyerEvent("collection_viewed", {
    collection: { kind: facts.kind, id: typeof facts.id === "string" ? facts.id : null, title: eventText(facts.title) },
    products,
  });
}
