/**
 * Self-healing for images that still publish only their original.
 *
 * A published media URL is the largest WebP rendition
 * (`media/<id>.<ext>/<w>.webp`) once renditions exist, else the original
 * (`media/<id>.<ext>`). When a public read renders a still original, the
 * image's renditions are rendered right after the response, so an image the
 * browser upload pipeline did not finish, or one the backfill has not reached
 * yet, gets renditions within seconds of a buyer seeing its placeholder. The
 * render skips media that are already done or cannot have renditions, and
 * advances the media dependency when it renders, which replaces the original
 * everywhere.
 *
 * Bounded: only reads that were rendered (cache misses), only the first
 * `MAX_BODY_BYTES` of a body, at most the plan's `renditionsPerPublicRead`
 * images, and one render per id per `HINT_TTL_SECONDS` (a per-colo Cache API
 * marker keyed by Worker version; a hint, never authority). Never throws.
 */

import { readWorkerVersion } from "@scalius/shared/cache-generation";
import { planLimits } from "@scalius/shared/plan-limits";

const MARKER_CACHE_NAME = "scalius-media-rendition-hints";
/** One render per media id per sweep period: the backfill runs every 15 minutes. */
export const MEDIA_RENDITION_HINT_TTL_SECONDS = 15 * 60;
/** A listing page's first cards: the ids one rendered read considers. */
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
  CF_VERSION_METADATA?: { id?: unknown } | null;
  BUCKET: R2Bucket;
  IMAGES?: ImagesBinding;
}

/** The per-colo "already requested" marker; null without the Cache API or a Worker version. */
async function openMarker(env: MediaRenditionHintEnv) {
  const version = readWorkerVersion(env);
  if (!version || typeof caches === "undefined") return null;
  const cache = await caches.open(MARKER_CACHE_NAME);
  const url = (id: string) => `https://media-rendition-hint.internal/${version}/${id}`;
  return {
    seen: async (id: string) => (await cache.match(url(id))) !== undefined,
    mark: (id: string) => cache.put(
      url(id),
      new Response("1", { headers: { "Cache-Control": `max-age=${MEDIA_RENDITION_HINT_TTL_SECONDS}` } }),
    ),
  };
}

/**
 * Renders the renditions of the first still originals in `response` (a clone
 * the caller no longer needs) that no read in this colo started recently, at
 * most `planLimits().background.renditionsPerPublicRead`. Runs after the
 * response. Returns the ids it rendered or tried.
 */
export async function renderRenditionsForRenderedOriginals(
  response: Response,
  env: MediaRenditionHintEnv,
): Promise<string[]> {
  try {
    const limit = planLimits().background.renditionsPerPublicRead;
    const marker = await openMarker(env);
    // Without Images nothing could render; where the plan profile leaves
    // renditions to the scheduled backfill (Workers Free), a read renders nothing.
    if (!marker || !env.IMAGES || limit < 1) {
      await response.body?.cancel().catch(() => undefined);
      return [];
    }
    const refs = findStillOriginalMedia(await readBoundedText(response));
    if (refs.length === 0) return [];
    const [{ renderMissingMediaVariants }, { getDb }] = await Promise.all([
      import("@scalius/core/modules/media"),
      import("@scalius/database/client"),
    ]);
    const db = getDb(env as unknown as Env);
    const rendered: string[] = [];
    for (const ref of refs) {
      if (rendered.length >= limit) break;
      if (await marker.seen(ref.id).catch(() => false)) continue;
      // Marked first: a parallel read in this colo does not render it too.
      await marker.mark(ref.id).catch(() => undefined);
      // Updating the media row advances its dependency in the same transaction.
      await renderMissingMediaVariants(db, ref.id, env.BUCKET, env.IMAGES);
      rendered.push(ref.id);
    }
    if (rendered.length > 0) {
      console.log("[media] renditions rendered after a public read", { count: rendered.length, first: maskMediaId(rendered[0]!) });
    }
    return rendered;
  } catch {
    return [];
  }
}
