import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import { RateLimitError } from "../utils/api-error";
import { adminProductsRoutes } from "../routes/admin/products";
import { createRuntimeApiApp } from "./base-app";

describe("runtime security headers", () => {
  const app = createRuntimeApiApp();
  app.get("/default", (c) => c.text("ok"));
  app.get("/limited", () => {
    throw new RateLimitError("Too many codes requested. Please wait and try again.", 95);
  });
  app.get("/strict", (c) => {
    c.header("Referrer-Policy", "no-referrer");
    return c.text("ok");
  });
  const env = { DB: {} } as unknown as Env;

  it("applies the default referrer policy", async () => {
    const res = await app.request("/api/v1/default", {}, env);
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("keeps a stricter policy chosen by the route", async () => {
    const res = await app.request("/api/v1/strict", {}, env);
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("tells rate-limited callers exactly how long to wait", async () => {
    const res = await app.request("/api/v1/limited", {}, env);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("95");
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "rate_limited", details: { retryAfterSeconds: 95 } },
    });
  });
});

describe("request schema refusals", () => {
  const app = createRuntimeApiApp();
  app.route("/admin/products", adminProductsRoutes);
  const plain = new OpenAPIHono<{ Bindings: Env }>();
  plain.openapi(createRoute({
    method: "get",
    path: "/",
    request: { query: z.object({ limit: z.coerce.number().int().max(10) }) },
    responses: { 200: { description: "ok" } },
  }), (c) => c.json({ ok: true }) as never);
  app.route("/probe", plain);
  app.get("/refused", (c) => c.json({ success: false, error: { code: "invalid_cursor", message: "Bad cursor" } }, 400));
  const env = { DB: {} } as unknown as Env;

  it("products.create with a media file id where the attachment id goes: validation_error naming the field and what it expects", async () => {
    const res = await app.request("/api/v1/admin/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Mug", media: [{ id: "media_abc12345", mediaId: "media_abc12345" }] }),
    }, env);
    expect(res.status).toBe(400);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = await res.json() as { success: boolean; error: { code: string; message: string; details: { issues: Array<{ path: unknown[]; message: string }> } } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).not.toMatch(/^\s*\[/u);
    expect(body.error.message).toMatch(/^[A-Za-z0-9.]+: /u);
    expect(body.error.message).toContain("see details.issues");
    const media = body.error.details.issues.find((issue) => issue.path.join(".") === "media.0.id");
    expect(media?.message).toContain("pmed_");
  });

  it("a query refusal reads the same; a route's own 400 is left as it is", async () => {
    const res = await app.request("/api/v1/probe?limit=50", {}, env);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: { code: "validation_error", message: expect.stringMatching(/^limit: /u), details: { issues: [{ path: ["limit"] }] } },
    });
    const own = await app.request("/api/v1/refused", {}, env);
    await expect(own.json()).resolves.toEqual({ success: false, error: { code: "invalid_cursor", message: "Bad cursor" } });
  });
});
