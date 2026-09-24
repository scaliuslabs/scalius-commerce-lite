import {
  parseStorefrontBatchParts,
  type StorefrontBatchPartResult,
} from "@scalius/shared/public-api-cache-routes";

/**
 * One storefront render's public reads in one API invocation.
 *
 * `GET /api/v1/storefront/batch?r=<path>&r=<path>` answers each part exactly
 * as a separate GET of that path would: through the generation-keyed public
 * cache, so layout, shipping and checkout settings computed for one page are
 * reused by the next. Parts must be public cached routes; the batch carries
 * no cookies or credentials and is never cached itself (its parts are).
 */
export interface StorefrontBatchDeps {
  /** The page's generation (header) or the store's current one. */
  readGeneration(): Promise<string | null>;
  /** Serves one part; `generation` is null when caching is unavailable. */
  fetchPart(part: Request, generation: string | null): Promise<Response>;
}

const PRIVATE_SIGNALS = ["Authorization", "Cookie", "X-API-Token"] as const;

function batchError(status: number, error: string): Response {
  return Response.json(
    { success: false, error },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

async function readPart(response: Response): Promise<StorefrontBatchPartResult> {
  return {
    status: response.status,
    contentType: response.headers.get("Content-Type") ?? "application/json",
    body: await response.text(),
  };
}

export async function serveStorefrontBatch(
  request: Request,
  deps: StorefrontBatchDeps,
): Promise<Response> {
  if (request.method !== "GET") return batchError(405, "Method not allowed");
  if (PRIVATE_SIGNALS.some((name) => request.headers.has(name))) {
    return batchError(400, "A storefront batch carries no credentials");
  }
  const parts = parseStorefrontBatchParts(new URL(request.url));
  if (!parts) return batchError(400, "Invalid storefront batch");

  const generation = await deps.readGeneration();
  const results = await Promise.all(parts.map(async (url) => {
    try {
      const part = new Request(url, { method: "GET", headers: { Accept: "application/json" } });
      return await readPart(await deps.fetchPart(part, generation));
    } catch (error) {
      console.error("[StorefrontBatch] part failed", url.pathname, error instanceof Error ? error.name : "unknown");
      return { status: 502, contentType: "application/json", body: '{"success":false,"error":"Batch part failed"}' };
    }
  }));

  return Response.json(
    { success: true, data: { parts: results } },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
