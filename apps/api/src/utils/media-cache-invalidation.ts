import type { Database } from "@scalius/database/client";

import {
  invalidateCatalogCaches,
  type WaitUntilExecutionContext,
} from "./cache-invalidation";

/**
 * Media mutations can affect product, category, collection, search, and CMS
 * projections. Their shared semantic product tag already owns that dependency
 * graph, so one purge is complete; scanning product-media rows only adds D1
 * work without making invalidation more precise.
 */
export async function invalidateMediaDependentProductCaches(
  _db: Database,
  _mediaId: string,
  c: { env?: Env; executionCtx?: WaitUntilExecutionContext },
): Promise<void> {
  await invalidateCatalogCaches("products", c);
}
