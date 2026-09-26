import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { cacheControlRoutes } from "./cache";

let fixture: ReturnType<typeof createSqliteD1Database>;
let app: OpenAPIHono<{ Bindings: Env }>;
let env: Env;
beforeEach(() => {
  fixture = createSqliteD1Database();
  app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.route("/cache", cacheControlRoutes);
  env = { DB: fixture.binding } as unknown as Env;
});
afterEach(() => fixture.sqlite.close());
const clear = () => app.request("/api/v1/cache/clear", { method: "POST" }, env);
const sequence = () => (fixture.sqlite.prepare("select seq from cache_clock where id = 1").get() as { seq: number }).seq;

describe("cache control routes", () => {
  it("advances the store dependency atomically for concurrent refreshes", async () => {
    const before = sequence();
    const responses = await Promise.all([clear(), clear()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await expect(responses[0]!.json()).resolves.toEqual({ success: true, data: { message: "Store refreshed" } });
    expect(sequence()).toBe(before + 2);
    expect(fixture.sqlite.prepare("select seq from cache_dep where dep = 'store'").get()).toEqual({ seq: before + 2 });
  });

  it("rolls the clock back when publishing the store dependency fails", async () => {
    const before = sequence();
    fixture.sqlite.exec("CREATE TRIGGER reject_store BEFORE INSERT ON cache_dep WHEN NEW.dep = 'store' BEGIN SELECT RAISE(ABORT, 'blocked'); END");
    expect((await clear()).status).toBe(500);
    expect(sequence()).toBe(before);
  });

  it("fails closed if the migrated clock row is missing", async () => {
    fixture.sqlite.exec("DELETE FROM cache_clock");
    expect((await clear()).status).toBe(500);
  });

  it("does not expose cache group purges", async () => {
    expect((await app.request("/api/v1/cache/groups")).status).toBe(404);
    expect((await app.request("/api/v1/cache/clear-group", { method: "POST" })).status).toBe(404);
  });
});
