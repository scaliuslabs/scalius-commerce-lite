import { describe, expect, it } from "vitest";

import { createRuntimeApiApp } from "./base-app";

describe("runtime security headers", () => {
  const app = createRuntimeApiApp();
  app.get("/default", (c) => c.text("ok"));
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
});
