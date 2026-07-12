import { OpenAPIHono } from "@hono/zod-openapi";
import {
  getBucket,
  validateMediaObjectKey,
} from "@scalius/core/integrations/storage";

const app = new OpenAPIHono<{ Bindings: Env }>();

type RangedR2ObjectBody = R2ObjectBody & {
  range?: {
    offset?: number;
    length?: number;
  };
};

/**
 * Local-only R2 passthrough. Media keys intentionally contain a `media/`
 * prefix, so this route must capture the complete tail rather than one path
 * segment. Production media is served by the configured R2 custom domain.
 */
app.get("/:key{.+}", async (c) => {
  let key: string;
  try {
    key = validateMediaObjectKey(c.req.param("key"));
  } catch {
    // This public development route should not expose storage-policy details
    // or turn an unsupported path into an operational 5xx signal.
    return c.notFound();
  }
  const bucket = c.env.BUCKET || c.env.STORAGE || getBucket();
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
