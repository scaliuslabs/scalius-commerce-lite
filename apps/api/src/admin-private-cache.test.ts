import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { privateNoStore } from "./middleware/private-no-store";

function appWith(handler: (c: import("hono").Context) => Response | Promise<Response>) {
  const app = new Hono();
  app.onError((error, c) => c.json({ success: false, message: error.message }, 401));
  app.use("/admin/*", privateNoStore);
  app.get("/admin/thing", handler);
  app.get("/public", (c) => c.json({ ok: true }));
  return app;
}

describe("dashboard API cache policy", () => {
  it("marks successful dashboard responses private and uncacheable", async () => {
    const res = await appWith((c) => c.json({ ok: true })).request("/admin/thing");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("marks refusals raised through onError too", async () => {
    const res = await appWith(() => { throw new Error("nope"); }).request("/admin/thing");
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("overrides a handler that tried to make a dashboard response cacheable", async () => {
    const res = await appWith((c) => {
      c.header("Cache-Control", "public, max-age=60");
      return c.json({ ok: true });
    }).request("/admin/thing");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("leaves other routes alone", async () => {
    const res = await appWith((c) => c.json({ ok: true })).request("/public");
    expect(res.headers.get("Cache-Control")).toBeNull();
  });
});
