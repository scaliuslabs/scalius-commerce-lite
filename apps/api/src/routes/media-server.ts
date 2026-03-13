import { Hono } from "hono";
import { getBucket } from "@scalius/core/integrations/storage";

const app = new Hono<{ Bindings: any }>();

// Simple route to serve R2 objects in local development
app.get("/:key", async (c) => {
    const key = c.req.param("key");

    const bucket = c.env.BUCKET || c.env.STORAGE || getBucket();
    if (!bucket) {
        return c.text("R2 Bucket binding not found. Expected binding 'BUCKET' or 'STORAGE'.", 500);
    }

    const object = await bucket.get(key);
    if (!object || !object.body) {
        return c.notFound();
    }

    const headers = new Headers();

    // Workaround for Miniflare V3 proxy IPC bug with writeHttpMetadata
    if (object.httpMetadata?.contentType) {
        headers.set("Content-Type", object.httpMetadata.contentType);
    }

    headers.set("etag", object.httpEtag);

    // Basic Cache-Control for local media
    headers.set("Cache-Control", "public, max-age=31536000");

    return new Response(object.body as ReadableStream, { headers });
});

export { app as serveMediaRoute };
