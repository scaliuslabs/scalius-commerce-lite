import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getBucket } from "@scalius/core/integrations/storage";

const app = new OpenAPIHono<{ Bindings: any }>();

// ─── GET /:key ───────────────────────────────────────────────────────────────

const getMediaRoute = createRoute({
  method: "get",
  path: "/{key}",
  tags: ["Media Server"],
  summary: "Serve R2 objects in local development",
  responses: {
    200: { description: "Media file" },
    404: { description: "Not found" },
    500: { description: "R2 bucket not available" }
  }
});

app.openapi(getMediaRoute, async (c) => {
  const key = c.req.valid("param").key;

  const bucket = c.env.BUCKET || c.env.STORAGE || getBucket();
  if (!bucket) {
    return c.text("R2 Bucket binding not found. Expected binding 'BUCKET' or 'STORAGE'.", 500) as any;
  }

  const object = await bucket.get(key);
  if (!object || !object.body) {
    return c.notFound() as any;
  }

  const headers = new Headers();

  if (object.httpMetadata?.contentType) {
    headers.set("Content-Type", object.httpMetadata.contentType);
  }

  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000");

  return new Response(object.body as ReadableStream, { headers }) as any;
});

export { app as serveMediaRoute };
