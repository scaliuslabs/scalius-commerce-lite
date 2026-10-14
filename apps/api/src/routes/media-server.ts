import { OpenAPIHono } from "@hono/zod-openapi";
import {
  validateMediaObjectKey,
} from "@scalius/core/integrations/storage";
import { isInternalServiceUrl } from "@scalius/shared/platform-config";

const app = new OpenAPIHono<{ Bindings: Env }>();

type RangedR2ObjectBody = R2ObjectBody & {
  range?: {
    offset?: number;
    length?: number;
  };
};

/**
 * R2 passthrough for public media. Media keys intentionally contain a
 * `media/` prefix, so this route must capture the complete tail rather than
 * one path segment. Two callers may read it: local development (the media
 * address is this route), and the storefront Worker over its service binding
 * (`https://api.internal`), which serves `/media/<key>` on the store's own
 * origin so a page's images reuse its connection. A request that reached the
 * API on a public address gets a 404: production media is also served by the
 * configured R2 custom domain.
 */
app.use("*", async (c, next) => {
  if (process.env.NODE_ENV !== "development" && !isInternalServiceUrl(c.req.url)) {
    return c.notFound();
  }
  await next();
});

app.get("/:key{.+}", async (c) => {
  let key: string;
  try {
    key = validateMediaObjectKey(c.req.param("key"));
    // `private/` holds sealed agent artifacts in the same bucket; only
    // `media/` objects are public.
    if (!key.startsWith("media/")) return c.notFound();
  } catch {
    // This public development route should not expose storage-policy details
    // or turn an unsupported path into an operational 5xx signal.
    return c.notFound();
  }
  const bucket = c.env.BUCKET || c.env.STORAGE;
  if (!bucket) {
    return c.text(
      "R2 Bucket binding not found. Expected binding 'BUCKET' or 'STORAGE'.",
      500,
    );
  }

  const rangeRequested = Boolean(c.req.header("range"));
  const object = (await bucket.get(
    key,
    rangeRequested ? { range: c.req.raw.headers } : undefined,
  )) as RangedR2ObjectBody | R2Object | null;
  if (!object || !("body" in object)) return c.notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  const offset = object.range?.offset;
  const length = object.range?.length;
  const ranged =
    rangeRequested &&
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset !== undefined &&
    length !== undefined &&
    offset >= 0 &&
    length > 0;
  if (ranged) {
    headers.set("Content-Length", String(length));
    headers.set(
      "Content-Range",
      `bytes ${offset}-${offset + length - 1}/${object.size}`,
    );
  } else {
    headers.set("Content-Length", String(object.size));
  }

  return new Response(object.body, { status: ranged ? 206 : 200, headers });
});

export { app as serveMediaRoute };
