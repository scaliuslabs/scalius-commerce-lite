/**
 * Self-healing for images that still publish only their original.
 *
 * A published media URL is the largest WebP rendition
 * (`media/<id>.<ext>/<w>.webp`) once renditions exist, else the original
 * (`media/<id>.<ext>`). When a public read renders a still original, its
 * media id is queued for the `media.render_variants` job with no delay, so a
 * failed upload-time render, an image the backfill has not reached yet, or
 * one the rendition ladder migration (0094) sent back to its original gets
 * renditions within seconds of a buyer seeing its placeholder. The job skips media
 * that are already done or cannot have renditions, and bumps the cache
 * generation when it renders, which replaces the original everywhere.
 *
 * Bounded: only reads that were rendered (cache misses), only the first
 * `MAX_BODY_BYTES` of a body, at most `MAX_IDS_PER_READ` ids (a listing
 * page's cards), and one queue message per id per `HINT_TTL_SECONDS` (a KV
 * marker). Never throws.
 */

import type { MediaVariantsQueue } from "@scalius/core/modules/media";

export const MEDIA_RENDITION_HINT_KV_PREFIX = "media:rendition-hint:";
/** One enqueue per media id per cron period: the backfill runs every 15 minutes. */
export const MEDIA_RENDITION_HINT_TTL_SECONDS = 15 * 60;
/** A listing page's first cards: 24 KV reads and at most 24 queue sends per rendered read. */
export const MEDIA_RENDITION_HINT_MAX_IDS_PER_READ = 24;
const MAX_BODY_BYTES = 512 * 1024;

const STILL_MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
};

/**
 * `media/<id>.<still ext>` not followed by a rendition path. The id grammar is
 * `buildMediaObjectKey`'s. GIFs keep their animation and never get renditions.
 */
const STILL_ORIGINAL = /(?:^|[/"])media\/([A-Za-z0-9][A-Za-z0-9_-]{7,127})\.(jpe?g|png|webp|avif)(?![A-Za-z0-9_./-])/gi;

export interface OriginalMediaRef {
  id: string;
  mimeType: string;
}

/** Own-media still originals referenced by a rendered body, first seen first. */
export function findStillOriginalMedia(
  text: string,
  limit = MEDIA_RENDITION_HINT_MAX_IDS_PER_READ,
): OriginalMediaRef[] {
  const found = new Map<string, OriginalMediaRef>();
  for (const match of text.matchAll(STILL_ORIGINAL)) {
    const id = match[1]!;
    if (found.has(id)) continue;
    found.set(id, { id, mimeType: STILL_MIME_BY_EXTENSION[match[2]!.toLowerCase()]! });
    if (found.size >= limit) break;
  }
  return [...found.values()];
}

async function readBoundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes >= MAX_BODY_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

function maskMediaId(id: string): string {
  return `${id.slice(0, 10)}…`;
}

export interface MediaRenditionHintEnv {
  CACHE?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
  };
  JOBS_QUEUE?: MediaVariantsQueue;
  IMAGES?: ImagesBinding;
}

/**
 * Queues the rendition job for each still original in `response` (a clone
 * the caller no longer needs). Returns the ids it queued.
 */
export async function queueRenditionsForRenderedOriginals(
  response: Response,
  env: MediaRenditionHintEnv,
): Promise<string[]> {
  try {
    const queue = env.JOBS_QUEUE;
    const kv = env.CACHE;
    // Without Images nothing could render the job; the queue drops it.
    if (!queue || !kv || !env.IMAGES) {
      await response.body?.cancel().catch(() => undefined);
      return [];
    }
    const refs = findStillOriginalMedia(await readBoundedText(response));
    if (refs.length === 0) return [];
    const { enqueueMediaVariantsJob } = await import("@scalius/core/modules/media");
    const images = env.IMAGES;
    // All ids at once: a card waits on this render, so no id queues behind another.
    const outcomes = await Promise.all(refs.map(async (ref) => {
      const key = `${MEDIA_RENDITION_HINT_KV_PREFIX}${ref.id}`;
      if (await kv.get(key).catch(() => null)) return null;
      const sent = await enqueueMediaVariantsJob(queue, images, {
        id: ref.id,
        kind: "image",
        mimeType: ref.mimeType,
        variantWidth: null,
      }, { delaySeconds: 0 });
      if (!sent) return null;
      await kv.put(key, "1", { expirationTtl: MEDIA_RENDITION_HINT_TTL_SECONDS }).catch(() => undefined);
      return ref.id;
    }));
    const queued = outcomes.filter((id): id is string => id !== null);
    if (queued.length > 0) {
      console.log("[media] rendition jobs queued from a public read", { count: queued.length, first: maskMediaId(queued[0]!) });
    }
    return queued;
  } catch {
    return [];
  }
}
