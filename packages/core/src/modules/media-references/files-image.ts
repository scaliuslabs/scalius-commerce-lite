import { media } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { sql } from "drizzle-orm";
import { currentPublicMediaBase, validateMediaObjectKey } from "../../integrations/storage";

/** A rendition of an upload: `<object key>/<width>.webp`. */
const RENDITION = /^(media\/.+)\/[1-9]\d{0,3}\.webp$/;

/**
 * The Files upload a URL names: the object key of an upload (or of the
 * upload a rendition was made from) under this request's public media
 * address, exactly as Files hands it out. Null for any other URL: another
 * host, a query or fragment, a path outside `media/`, or no media address.
 */
export function filesObjectKeyOfUrl(url: string): string | null {
  const base = currentPublicMediaBase();
  if (!base || !url.startsWith(`${base}/`)) return null;
  const path = url.slice(base.length + 1);
  if (/[?#]/.test(path)) return null;
  const key = RENDITION.exec(path)?.[1] ?? path;
  if (!key.startsWith("media/")) return null;
  try {
    return validateMediaObjectKey(key);
  } catch {
    return null;
  }
}

/**
 * The URLs among `urls` that are not a ready image in Files (another host,
 * a video, a file uploading, in trash or being deleted). One read; at most
 * 90 URLs (an image field list is far shorter).
 */
export async function urlsNotReadyFilesImages(db: Database, urls: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(urls)];
  if (unique.length > 90) throw new Error("Check at most 90 image URLs at once.");
  const keys = new Map(unique.map((url) => [url, filesObjectKeyOfUrl(url)] as const));
  const named = [...new Set([...keys.values()].filter((key): key is string => key !== null))];
  const ready = new Set<string>();
  if (named.length > 0) {
    const rows = await db
      .select({ objectKey: media.objectKey })
      .from(media)
      .where(sql`${media.kind} = 'image' AND ${media.status} = 'ready'
        AND ${media.objectKey} IN (SELECT value FROM json_each(${JSON.stringify(named)}))`)
      .all();
    for (const row of rows) ready.add(row.objectKey);
  }
  return new Set(unique.filter((url) => !ready.has(keys.get(url) ?? "")));
}
