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
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("We&#39;ll be right back");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    // Retry reloads the same address, not the homepage.
    expect(html).toContain('<a href="">Try again</a>');
  });

  it("speaks the page's language and names the store when known", async () => {
    const html = await storefrontDataUnavailableResponse("We could not load this product.", {
      lang: "bn-BD",
      storeName: "Rahim <Shop>",
    }).text();

    expect(html).toContain('<html lang="bn">');
    expect(html).toContain("আবার চেষ্টা করুন");
    // The English page message never shows on a Bangla page.
    expect(html).not.toContain("We could not load this product.");
    expect(html).toContain("Rahim &lt;Shop&gt;");
  });
});
