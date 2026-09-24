import { describe, expect, it } from "vitest";

import { RateLimitError } from "../utils/api-error";
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
      error: { code: "RATE_LIMIT", details: { retryAfterSeconds: 95 } },
    });
  });
});
