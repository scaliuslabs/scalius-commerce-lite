import type { Database } from "@scalius/database/client";
import { media, productMedia, products } from "@scalius/database/schema";
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";

import {
  invalidateCatalogCaches,
  invalidateProductAvailabilityCacheSubjects,
  MAX_STOREFRONT_EXACT_HTML_PATHS,
  type ProductAvailabilityCacheSubject,
  type WaitUntilExecutionContext,
} from "./cache-invalidation";

export interface MediaDependentProductCachePage {
  subjects: ProductAvailabilityCacheSubject[];
  nextProductId: string | null;
}

/**
 * Resolve one bounded page of products whose buyer presentation depends on a
 * Media asset. The indexed direct association covers normal image/video use;
 * the indexed poster subquery covers videos that use a changed image as their
 * poster. Product IDs provide a stable keyset cursor without offsets.
 */
export async function resolveMediaDependentProductCachePage(
  db: Database,
  mediaId: string,
  afterProductId?: string,
): Promise<MediaDependentProductCachePage> {
  const posterVideoIds = db
    .select({ id: media.id })
    .from(media)
    .where(and(eq(media.posterMediaId, mediaId), eq(media.kind, "video")));

  const rows = await db
    .selectDistinct({
      productId: products.id,
      slug: products.slug,
      categoryId: products.categoryId,
    })
    .from(productMedia)
    .innerJoin(products, eq(products.id, productMedia.productId))
    .where(and(
      afterProductId ? gt(products.id, afterProductId) : undefined,
      or(
        eq(productMedia.mediaId, mediaId),
        inArray(productMedia.mediaId, posterVideoIds),
      ),
    ))
    .orderBy(asc(products.id))
    .limit(MAX_STOREFRONT_EXACT_HTML_PATHS);

  return {
    subjects: rows,
    nextProductId: rows.length === MAX_STOREFRONT_EXACT_HTML_PATHS
      ? rows.at(-1)?.productId ?? null
      : null,
  };
}

/**
 * Invalidate every dependent product in sequential D1-safe pages. A product
 * association created concurrently performs its own aggregate invalidation,
 * so keyset traversal cannot leave a newly attached product stale.
 */
export async function invalidateMediaDependentProductCaches(
  db: Database,
  mediaId: string,
  c: { env?: Env; executionCtx?: WaitUntilExecutionContext },
): Promise<void> {
  try {
    let afterProductId: string | undefined;

    do {
      const page = await resolveMediaDependentProductCachePage(
        db,
        mediaId,
        afterProductId,
      );
      if (page.subjects.length === 0) return;

      await invalidateProductAvailabilityCacheSubjects(page.subjects, c, db);
      afterProductId = page.nextProductId ?? undefined;
    } while (afterProductId);
  } catch (error) {
    console.error(
      "[Cache] Failed to invalidate media-dependent products; falling back to catalog invalidation:",
      error,
    );
    await invalidateCatalogCaches("products", c);
  }
}
