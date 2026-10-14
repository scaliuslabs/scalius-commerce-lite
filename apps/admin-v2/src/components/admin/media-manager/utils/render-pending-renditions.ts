import { MediaApiClient } from "../api";
import { encodeMediaVariants } from "./media-variants";

/** Candidate rows read per page. */
const PAGE_SIZE = 20;
/** Most pages one pass reads, so a long tail of images that never encode cannot make it scan forever. */
const MAX_PAGES = 25;

export interface RenditionPassOptions {
  /** Most images this pass renders or attempts. */
  limit: number;
  /**
   * Images uploaded less than this long ago are left to their own upload,
   * whose browser saves the renditions seconds after the file arrives.
   */
  minAgeMs?: number;
  /** Ids that failed earlier on this page; a pass never retries them. Failures are added to it. */
  skip: Set<string>;
  /** Checked before every image; true ends the pass. */
  shouldStop?: () => boolean;
  /** Awaited after every image so the page stays responsive. */
  pause?: () => Promise<void>;
  onImage?: (outcome: "rendered" | "failed") => void;
  now?: () => number;
}

export interface RenditionPassResult {
  rendered: number;
  failed: number;
  /** Pending images remain that this pass did not attempt. */
  more: boolean;
}

/**
 * Renders the WebP ladder, in this browser, for still images that publish only
 * their original (agent and URL-import uploads, anything uploaded before
 * renditions existed): it downloads each original, encodes it with the same
 * pipeline as a dashboard upload and saves the result. The pending state is the
 * server's own (`variant_width` is NULL), so a pass is idempotent and any tab
 * can pick up where another stopped; a failure never throws.
 */
export async function renderPendingRenditions(options: RenditionPassOptions): Promise<RenditionPassResult> {
  const { limit, minAgeMs = 0, skip, shouldStop, pause, onImage, now = Date.now } = options;
  let rendered = 0;
  let failed = 0;
  let more = false;
  let cursor: string | undefined;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const page = await MediaApiClient.fetchFilesMissingVariants(cursor, PAGE_SIZE);
    for (const file of page.files) {
      if (skip.has(file.id)) continue;
      if (minAgeMs > 0 && file.createdAt && now() - file.createdAt.getTime() < minAgeMs) {
        more = true;
        continue;
      }
      if (rendered + failed >= limit || shouldStop?.()) return { rendered, failed, more: true };
      try {
        const variants = await encodeMediaVariants(await MediaApiClient.fetchOriginal(file.id));
        if (!variants) throw new Error("WebP encoding unavailable");
        await MediaApiClient.saveVariants(file.id, variants);
        rendered += 1;
        onImage?.("rendered");
      } catch {
        skip.add(file.id);
        failed += 1;
        onImage?.("failed");
      }
      await pause?.();
    }
    if (!page.pagination.hasMore || !page.pagination.nextCursor) return { rendered, failed, more };
    cursor = page.pagination.nextCursor;
  }
  return { rendered, failed, more: true };
}
