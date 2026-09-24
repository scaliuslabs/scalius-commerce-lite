import { describe, expect, it } from "vitest";
import app from "./app";

describe("dashboard API cache policy", () => {
  it.each(["/api/v1/admin/orders", "/api/v1/admin/settings/business", "/api/v1/cache/generation"])(
    "marks %s private and uncacheable, even when refused",
    async (path) => {
      const res = await app.request(path);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    },
  );

  it("leaves public reads to the public cache policy", async () => {
    const res = await app.request("/api/v1/health");
    expect(res.headers.get("Cache-Control")).not.toBe("private, no-store");
  });
});
