/**
 * Self-healing for images that still publish only their original.
 *
 * A published media URL is the largest WebP rendition
 * (`media/<id>.<ext>/<w>.webp`) once renditions exist, else the original
 * (`media/<id>.<ext>`). When a public read renders a still original, its
 * media id is queued for the existing delayed `media.render_variants` job, so
 * a failed upload-time render or an image the backfill has not reached yet
 * gets renditions within minutes of a buyer seeing it. The job skips media
 * that are already done or cannot have renditions, and bumps the cache
 * generation when it renders, which replaces the original everywhere.
 *
 * Bounded: only reads that were rendered (cache misses), only the first
 * `MAX_BODY_BYTES` of a body, at most `MAX_IDS_PER_READ` ids, and one queue
 * message per id per `HINT_TTL_SECONDS` (a KV marker). Never throws.
 */

export const MEDIA_RENDITION_HINT_KV_PREFIX = "media:rendition-hint:";
/** One enqueue per media id per cron period: the backfill runs every 15 minutes. */
export const MEDIA_RENDITION_HINT_TTL_SECONDS = 15 * 60;
export const MEDIA_RENDITION_HINT_MAX_IDS_PER_READ = 8;
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
  CACHE?: Pick<KVNamespace, "get" | "put">;
  JOBS_QUEUE?: Pick<Queue, "send">;
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
    const queued: string[] = [];
    for (const ref of refs) {
      const key = `${MEDIA_RENDITION_HINT_KV_PREFIX}${ref.id}`;
      if (await kv.get(key).catch(() => null)) continue;
      const sent = await enqueueMediaVariantsJob(queue, env.IMAGES, {
        id: ref.id,
        kind: "image",
        mimeType: ref.mimeType,
        variantWidth: null,
      });
      if (!sent) continue;
      queued.push(ref.id);
      console.log("[media] rendition job queued from a public read", { mediaId: maskMediaId(ref.id) });
      await kv.put(key, "1", { expirationTtl: MEDIA_RENDITION_HINT_TTL_SECONDS }).catch(() => undefined);
    }
    return queued;
  } catch {
    return [];
  }
}
