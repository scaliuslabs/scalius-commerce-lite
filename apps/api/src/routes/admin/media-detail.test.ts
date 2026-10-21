import { OpenAPIHono } from "@hono/zod-openapi";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { media } from "@scalius/database/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorResponseFromError } from "../../utils/api-response";
import { adminMediaRoutes } from "./media";

describe("authoritative admin media detail", () => {
  let harness: ReturnType<typeof createSqliteD1Database>;
  let app: OpenAPIHono<{ Bindings: Env }>;
  beforeEach(() => {
    harness = createSqliteD1Database();
    app = new OpenAPIHono<{ Bindings: Env }>();
    app.use("*", async (c, next) => { c.set("db", harness.db); await next(); });
    app.onError((error, c) => {
      const result = errorResponseFromError(error);
      return c.json(result.body, result.status);
    });
    app.route("/media", adminMediaRoutes);
  });
  afterEach(() => harness.sqlite.close());

  it("keeps the folders collection reachable beside the detail route", async () => {
    const response = await app.request("/media/folders");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { folders: [] } });
  });

  it.each(["ready", "trashed"] as const)("reads the exact %s file's current revision", async (status) => {
    await harness.db.insert(media).values({ id: "media_fresh", filename: "Renamed.webp", objectKey: "media/renamed.webp", kind: "image", mimeType: "image/webp", size: 100, status, version: 7, altText: "Current alt text", trashedAt: status === "trashed" ? new Date("2026-10-12T00:00:00Z") : null });
    const response = await app.request("/media/media_fresh");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ success: true, data: { file: { id: "media_fresh", filename: "Renamed.webp", revision: 7, altText: "Current alt text", status } } });
  });

  it.each(["deleting", "deleted"] as const)("does not return %s file metadata as available", async (status) => {
    await harness.db.insert(media).values({ id: "media_removed", filename: "Removed.webp", objectKey: "media/removed.webp", kind: "image", mimeType: "image/webp", size: 100, status, version: 3, trashedAt: new Date("2026-10-12T00:00:00Z"), deletedAt: status === "deleted" ? new Date("2026-10-13T00:00:00Z") : null });
    expect((await app.request("/media/media_removed")).status).toBe(404);
    expect((await app.request("/media/media_missing")).status).toBe(404);
  });
});
