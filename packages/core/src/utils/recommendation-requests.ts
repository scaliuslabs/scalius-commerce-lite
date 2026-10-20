// Products a public render found without stored recommendations, noted in the
// request's async context so the API can queue them after the response
// (catalog/recommendation-queue.ts). No database work happens inside the
// render's dependency scope; AsyncLocalStorage keeps concurrent requests and
// batch parts apart, and nothing is retained.
import { AsyncLocalStorage } from "node:async_hooks";

/** Most products one request notes (the API reads at most 20 sources). */
export const RECOMMENDATION_REQUEST_LIMIT = 20;

const requests = new AsyncLocalStorage<Set<string>>();

/** Runs `render` collecting the products it found without stored recommendations. */
export async function collectRecommendationRefreshRequests<T>(
  render: () => Promise<T>,
): Promise<{ value: T; productIds: string[] }> {
  const productIds = new Set<string>();
  const value = await requests.run(productIds, render);
  return { value, productIds: [...productIds] };
}

/** Notes products to refresh; a no-op outside `collectRecommendationRefreshRequests`. */
export function requestRecommendationRefresh(productIds: Iterable<string>): void {
  const pending = requests.getStore();
  if (!pending) return;
  for (const id of productIds) {
    if (pending.size >= RECOMMENDATION_REQUEST_LIMIT) return;
    if (id.length > 0 && id.length <= 180) pending.add(id);
  }
}
