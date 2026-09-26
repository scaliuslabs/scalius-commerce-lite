import {
  parseStorefrontBatchParts,
  type StorefrontBatchPartResult,
} from "@scalius/shared/public-api-cache-routes";
import type { StorefrontBatchPartCache } from "@scalius/shared/cache-frontier";

/**
 * One storefront render's public reads in one API invocation.
 *
 * `GET /api/v1/storefront/batch?r=<path>&r=<path>` answers each part exactly
 * as a separate GET of that path would, from the public part cache, so
 * layout, shipping and checkout settings computed for one page are reused by
 * the next. Parts are read together so the dependency-validated cache
 * (strict mode) validates every hit with one statement. Parts must be public
 * cached routes; the batch carries no cookies or credentials and is never
 * cached itself (its parts are).
 */
export interface StorefrontBatchDeps {
  /** The page's generation (header) or the store's current one; unused in strict mode. */
  readGeneration(): Promise<string | null>;
  /** Reads every part; a rejected result fails only its part. */
  readParts(
    parts: readonly Request[],
    generation: string | null,
  ): Promise<Array<PromiseSettledResult<{ response: Response; cache: StorefrontBatchPartCache | null }>>>;
}

const PRIVATE_SIGNALS = ["Authorization", "Cookie", "X-API-Token"] as const;

function batchError(status: number, error: string): Response {
  return Response.json(
    { success: false, error },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

async function readPart(response: Response, cache: StorefrontBatchPartCache | null): Promise<StorefrontBatchPartResult> {
  return {
    status: response.status,
    contentType: response.headers.get("Content-Type") ?? "application/json",
    body: await response.text(),
    ...(cache ? { cache } : {}),
  };
}

const FAILED_PART: StorefrontBatchPartResult = {
  status: 502,
  contentType: "application/json",
  body: '{"success":false,"error":"Batch part failed"}',
};

export async function serveStorefrontBatch(
  request: Request,
  deps: StorefrontBatchDeps,
): Promise<Response> {
  if (request.method !== "GET") return batchError(405, "Method not allowed");
  if (PRIVATE_SIGNALS.some((name) => request.headers.has(name))) {
    return batchError(400, "A storefront batch carries no credentials");
  }
  const urls = parseStorefrontBatchParts(new URL(request.url));
  if (!urls) return batchError(400, "Invalid storefront batch");

  const generation = await deps.readGeneration();
  const parts = urls.map((url) => new Request(url, { method: "GET", headers: { Accept: "application/json" } }));
  const settled = await deps.readParts(parts, generation);
  const results = await Promise.all(settled.map(async (result, index) => {
    try {
      if (result.status === "rejected") throw result.reason;
      return await readPart(result.value.response, result.value.cache);
    } catch (error) {
      console.error("[StorefrontBatch] part failed", urls[index]!.pathname, error instanceof Error ? error.name : "unknown");
      return FAILED_PART;
    }
  }));

  return Response.json(
    { success: true, data: { parts: results } },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
