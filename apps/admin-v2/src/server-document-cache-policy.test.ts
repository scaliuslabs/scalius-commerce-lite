import { describe, expect, it } from "vitest";
import { applyAdminDocumentCachePolicy } from "./server-document-cache-policy";

describe("admin document cache policy", () => {
  it("prevents successful dashboard HTML from pinning an old asset manifest", async () => {
    const response = applyAdminDocumentCachePolicy(
      new Request("https://dashboard.example/admin", {
        headers: { Accept: "text/html,application/xhtml+xml" },
      }),
      new Response("<html>current build</html>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );

    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0, must-revalidate",
    );
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("Expires")).toBe("0");
    expect(await response.text()).toContain("current build");
  });

  it("also protects document redirects without rewriting their destination", () => {
    const response = applyAdminDocumentCachePolicy(
      new Request("https://dashboard.example/admin", {
        headers: { Accept: "text/html" },
      }),
      new Response(null, {
        status: 307,
        headers: { Location: "/auth/login" },
      }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/auth/login");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("leaves hashed assets and JSON/RPC responses on their existing policy", () => {
    const assetResponse = new Response("export{}", {
      headers: {
        "Content-Type": "text/javascript",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
    const result = applyAdminDocumentCachePolicy(
      new Request("https://dashboard.example/assets/app-HASH.js", {
        headers: { Accept: "*/*" },
      }),
      assetResponse,
    );

    expect(result).toBe(assetResponse);
    expect(result.headers.get("Cache-Control")).toContain("immutable");
  });
});
