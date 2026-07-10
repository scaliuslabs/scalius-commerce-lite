import { describe, expect, it } from "vitest";
import app from "./app";

describe("storefront Flue canary app", () => {
  it("serves a no-store health response without exposing agent routes", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "scalius-storefront-agent-flue-canary",
      runtime: "flue-cloudflare",
      version: "0.1.0",
    });
  });

  it("fails closed before Flue admission when credentials are absent", async () => {
    const [absent, partiallyConfigured] = await Promise.all([
      app.request("/agents/shopping-assistant/guessed-thread"),
      app.request(
        "/agents/shopping-assistant/guessed-thread",
        { headers: { Authorization: `Bearer ${"a".repeat(32)}` } },
        { CANARY_AUTH_TOKEN: "a".repeat(32) } as never,
      ),
    ]);
    expect(absent.status).toBe(404);
    expect(absent.headers.get("cache-control")).toBe("no-store");
    expect(partiallyConfigured.status).toBe(404);
  });
});
