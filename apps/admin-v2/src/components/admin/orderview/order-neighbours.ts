import { useQueryClient } from "@tanstack/react-query";
import type { OrdersListPayload } from "~/lib/api-query-options/orders";
import { queryKeys } from "~/lib/query-keys";

export interface OrderNeighbours {
  previous: string | null;
  next: string | null;
}

/**
 * Previous/next orders from the most recently fetched list page that contains
 * this order, so the arrows follow the list view the merchant came from.
 * Returns null when the order is in no cached list (e.g. a deep link).
 */
export function findOrderNeighbours(
  pages: ReadonlyArray<{ updatedAt: number; ids: readonly string[] }>,
  orderId: string,
): OrderNeighbours | null {
  const page = [...pages]
    .filter((candidate) => candidate.ids.includes(orderId))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  if (!page) return null;
  const index = page.ids.indexOf(orderId);
  return { previous: page.ids[index - 1] ?? null, next: page.ids[index + 1] ?? null };
}

/** Reads the cached order list pages; no request is made. */
export function useOrderNeighbours(orderId: string): OrderNeighbours | null {
  const queryClient = useQueryClient();
  const pages = queryClient
    .getQueryCache()
    .findAll({ queryKey: queryKeys.orders.list() })
    .map((query) => ({
      updatedAt: query.state.dataUpdatedAt,
      ids: ((query.state.data as OrdersListPayload | undefined)?.orders ?? []).map((order) => order.id),
    }));
  return findOrderNeighbours(pages, orderId);
}
