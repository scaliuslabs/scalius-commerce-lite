import { describe, expect, it } from "vitest";
import { BUILD_ID } from "../../config/build-id";
import { GET } from "../../pages/health";

describe("storefront health route", () => {
  it("identifies the exact uncached build serving the request", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(response.headers.get("X-Storefront-Build")).toBe(BUILD_ID);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      buildId: BUILD_ID,
      timestamp: expect.any(Number),
    });
  });
});
