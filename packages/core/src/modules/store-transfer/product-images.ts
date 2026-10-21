// Remote product images for imported products. Every image becomes a media
// asset named after a hash of its source URL (`media_u<hash>_<suffix>`), so a
// URL is downloaded once per store however many products or runs name it,
// and a product that already shows an image is left alone. An image of this
// store's own media library (a re-imported Scalius export) is reused without
// downloading. Downloads go through the guarded media URL import (public
// HTTPS only, bounded size, signature checked), which the API injects.
//
// New images are appended after the product's current media in one
// aggregate-revision write; the first becomes featured when the product has
// none, and a SKU that has no image of its own gets the image the file named
// for it. Nothing already on the product is changed or removed.

import type { Database } from "@scalius/database/client";
import { media, productMedia, productVariants, products } from "@scalius/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { BatchItem } from "drizzle-orm/batch";
import type { ProductImageBatch } from "@scalius/shared/store-transfer/products";
import { AppError } from "@scalius/core/errors";
import { executeProductAggregateMutationBatch, ProductRevisionConflictError } from "../product-admin";
import { MAX_PRODUCT_MEDIA_ASSOCIATIONS } from "../products";
import { ImportBudget, isWorkerLimitError } from "./budget";
import { sha256Hex } from "@scalius/shared/hash";

export type ImageImportStatus = "attached" | "already_attached" | "failed" | "pending";

export interface ImageImportResult {
  url: string;
  status: ImageImportStatus;
  mediaId: string | null;
  message: string | null;
}

export interface ProductImageImportResult {
  productId: string;
  images: ImageImportResult[];
  aggregateRevision: number | null;
  /** The product could not take the images (missing, in trash, changed). */
  error: string | null;
}

export interface ProductImageImportResponse {
  results: ProductImageImportResult[];
  /** True when the time budget ran out: images left `pending` should be sent again. */
  stoppedEarly: boolean;
}

/** Downloads one remote file into the media library under `mediaId`. */
export type RemoteMediaImporter = (input: { sourceUrl: string; mediaId: string; filename?: string }) => Promise<{ id: string; kind: "image" | "video" }>;

const PRODUCT_MEDIA_INSERT_CHUNK = 12;

/** The id prefix every media downloaded from `url` carries. */
export async function importedMediaIdPrefix(url: string): Promise<string> {
  return `media_u${(await sha256Hex(url.trim())).slice(0, 24)}_`;
}

/** This store's own media id in a media URL (`…/media/<id>.<ext>`, or a rendition of it). */
export function ownMediaIdFromUrl(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const match = /\/media\/([A-Za-z0-9][A-Za-z0-9_-]{7,127})\.(?:jpe?g|png|gif|webp|avif|mp4|webm)(?:\/\d{1,4}\.webp)?$/i.exec(path);
  return match ? match[1]! : null;
}

function filenameFromUrl(url: string): string | undefined {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "").replace(/[^\p{L}\p{N}._-]+/gu, "-");
    return last && last.length <= 120 && /\.[A-Za-z0-9]{2,5}$/.test(last) ? last : undefined;
  } catch {
    return undefined;
  }
}

function failureMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return error instanceof Error && error.message ? error.message : "The image could not be downloaded.";
}

type ReadyMedia = { id: string; kind: "image" | "video" };

/** Ready media downloaded earlier from these URLs (by id prefix), and own media referenced by URL. */
async function findReusableMedia(db: Database, urls: readonly string[], prefixes: Map<string, string>): Promise<Map<string, ReadyMedia>> {
  const found = new Map<string, ReadyMedia>();
  const own = new Map(urls.flatMap((url) => {
    const id = ownMediaIdFromUrl(url);
    return id ? [[url, id] as const] : [];
  }));
  const ranges = urls.map((url) => prefixes.get(url)!);
  for (let index = 0; index < ranges.length; index += 40) {
    const chunk = ranges.slice(index, index + 40);
    const rows = await db.select({ id: media.id, kind: media.kind }).from(media)
      .where(and(
        eq(media.status, "ready"),
        sql`(${sql.join(chunk.map((prefix) => sql`(${media.id} >= ${prefix} AND ${media.id} < ${`${prefix}~`})`), sql` OR `)})`,
      ));
    for (const row of rows) {
      const url = urls.find((candidate) => row.id.startsWith(prefixes.get(candidate)!));
      if (url && !found.has(url)) found.set(url, { id: row.id, kind: row.kind });
    }
  }
  const ownIds = [...new Set(own.values())];
  if (ownIds.length > 0) {
    const rows = await db.select({ id: media.id, kind: media.kind }).from(media)
      .where(and(eq(media.status, "ready"), sql`${media.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ownIds)}))`));
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const [url, id] of own) {
      const row = byId.get(id);
      if (row && !found.has(url)) found.set(url, row);
    }
  }
  return found;
}

/** Downloads (or reuses) each image and attaches the new ones to their products. */
export async function importProductImages(
  db: Database,
  batch: ProductImageBatch,
  options: { importMedia: RemoteMediaImporter; budget?: ImportBudget },
): Promise<ProductImageImportResponse> {
  const budget = options.budget ?? new ImportBudget();
  const urls = [...new Set(batch.items.flatMap((item) => item.images.map((image) => image.url)))];
  const prefixes = new Map(await Promise.all(urls.map(async (url) => [url, await importedMediaIdPrefix(url)] as const)));
  const reusable = await findReusableMedia(db, urls, prefixes);
  const results: ProductImageImportResult[] = [];
  let stoppedEarly = false;

  for (const item of batch.items) {
    const result: ProductImageImportResult = { productId: item.productId, images: [], aggregateRevision: null, error: null };
    results.push(result);
    const product = await db.select({ id: products.id, aggregateRevision: products.aggregateRevision })
      .from(products)
      .where(and(eq(products.id, item.productId), isNull(products.deletedAt)))
      .get();
    if (!product) {
      result.error = "This product is not in the store (or is in trash).";
      result.images = item.images.map((image) => ({ url: image.url, status: "failed", mediaId: null, message: result.error }));
      continue;
    }
    const attached = await db.select({ mediaId: productMedia.mediaId }).from(productMedia).where(eq(productMedia.productId, product.id));
    const attachedIds = new Set(attached.map((row) => row.mediaId));

    const ready: Array<{ url: string; media: ReadyMedia; alt: string | null; skus: string[] }> = [];
    for (const image of item.images) {
      const prefix = prefixes.get(image.url)!;
      const ownId = ownMediaIdFromUrl(image.url);
      const already = [...attachedIds].find((id) => id.startsWith(prefix) || id === ownId);
      if (already) {
        result.images.push({ url: image.url, status: "already_attached", mediaId: already, message: null });
        continue;
      }
      let asset = reusable.get(image.url);
      if (!asset) {
        if (stoppedEarly || budget.exhausted()) {
          stoppedEarly = true;
          result.images.push({ url: image.url, status: "pending", mediaId: null, message: null });
          continue;
        }
        try {
          const filename = filenameFromUrl(image.url);
          const created = await options.importMedia({ sourceUrl: image.url, mediaId: `${prefix}${nanoid(8).replace(/[^A-Za-z0-9]/g, "x")}`, ...(filename ? { filename } : {}) });
          asset = { id: created.id, kind: created.kind };
          reusable.set(image.url, asset);
        } catch (error) {
          if (isWorkerLimitError(error)) {
            stoppedEarly = true;
            result.images.push({ url: image.url, status: "pending", mediaId: null, message: null });
            continue;
          }
          result.images.push({ url: image.url, status: "failed", mediaId: null, message: failureMessage(error) });
          continue;
        }
      }
      ready.push({ url: image.url, media: asset, alt: image.alt, skus: image.skus });
      result.images.push({ url: image.url, status: "attached", mediaId: asset.id, message: null });
    }
    if (ready.length === 0) {
      result.aggregateRevision = product.aggregateRevision;
      continue;
    }
    try {
      result.aggregateRevision = await attachImages(db, product.id, ready);
    } catch (error) {
      if (isWorkerLimitError(error)) {
        stoppedEarly = true;
        for (const image of result.images) if (image.status === "attached") Object.assign(image, { status: "pending" });
        continue;
      }
      result.error = failureMessage(error);
      for (const image of result.images) {
        if (image.status === "attached") Object.assign(image, { status: "failed", message: result.error });
      }
    }
  }
  return { results, stoppedEarly };
}

/** Appends media to a product (and to SKUs without an image) under its aggregate revision; retried once on a race. */
async function attachImages(
  db: Database,
  productId: string,
  images: ReadonlyArray<{ media: ReadyMedia; alt: string | null; skus: string[] }>,
): Promise<number> {
  for (let attempt = 0; ; attempt += 1) {
    const [current, existing, variants] = await Promise.all([
      db.select({ aggregateRevision: products.aggregateRevision }).from(products).where(eq(products.id, productId)).get(),
      db.select({ id: productMedia.id, mediaId: productMedia.mediaId, isPrimary: productMedia.isPrimary, sortOrder: productMedia.sortOrder })
        .from(productMedia).where(eq(productMedia.productId, productId)),
      db.select({ id: productVariants.id, sku: productVariants.sku, imageId: productVariants.imageId, isDefault: productVariants.isDefault })
        .from(productVariants).where(and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt))),
    ]);
    if (!current) throw new AppError(404, "not_found", "This product is not in the store.");
    const attachedMedia = new Set(existing.map((row) => row.mediaId));
    const room = MAX_PRODUCT_MEDIA_ASSOCIATIONS - existing.length;
    const fresh = images.filter((image) => !attachedMedia.has(image.media.id)).slice(0, Math.max(0, room));
    if (fresh.length === 0) return current.aggregateRevision;
    let sortOrder = existing.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1;
    const hasPrimary = existing.some((row) => row.isPrimary);
    const rows = fresh.map((image, index) => ({
      id: `pmed_${nanoid()}`,
      productId,
      mediaId: image.media.id,
      altText: image.alt,
      isPrimary: !hasPrimary && index === 0,
      sortOrder: sortOrder++,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    }));
    const statements: BatchItem<"sqlite">[] = [];
    for (let index = 0; index < rows.length; index += PRODUCT_MEDIA_INSERT_CHUNK) {
      statements.push(db.insert(productMedia).values(rows.slice(index, index + PRODUCT_MEDIA_INSERT_CHUNK)));
    }
    // A SKU keeps its own image; one without gets the image the file named for it.
    const skuOwner = new Map(variants.filter((variant) => !variant.isDefault && variant.imageId === null)
      .map((variant) => [variant.sku.trim().toLowerCase(), variant.id]));
    fresh.forEach((image, index) => {
      if (image.media.kind !== "image") return;
      const variantIds = image.skus.flatMap((sku) => {
        const id = skuOwner.get(sku.trim().toLowerCase());
        if (!id) return [];
        skuOwner.delete(sku.trim().toLowerCase());
        return [id];
      });
      if (variantIds.length === 0) return;
      statements.push(db.update(productVariants).set({ imageId: rows[index]!.id, updatedAt: sql`unixepoch()` }).where(and(
        eq(productVariants.productId, productId),
        isNull(productVariants.imageId),
        isNull(productVariants.deletedAt),
        sql`${productVariants.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(variantIds)}))`,
      )));
    });
    try {
      const result = await executeProductAggregateMutationBatch(db, productId, current.aggregateRevision, statements);
      return result.aggregateRevision;
    } catch (error) {
      // The merchant saved the product meanwhile: read it again and append once more.
      if (attempt === 0 && error instanceof ProductRevisionConflictError) continue;
      throw error;
    }
  }
}
