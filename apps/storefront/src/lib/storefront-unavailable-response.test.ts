import { describe, expect, it } from "vitest";
import { storefrontDataUnavailableResponse } from "./storefront-unavailable-response";

describe("storefrontDataUnavailableResponse", () => {
  it("returns a non-cacheable temporary-unavailable response", async () => {
    const response = storefrontDataUnavailableResponse(
      'Backend <script>alert("x")</script> unavailable',
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(response.headers.get("Content-Type")).toContain("text/html");

    const html = await response.text();
    expect(html).toContain("Storefront temporarily unavailable");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });
});
