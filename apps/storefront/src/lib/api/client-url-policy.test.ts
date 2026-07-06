import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { storefrontRootPath } from "../test-source-paths";

const storefrontRoot = storefrontRootPath();

describe("storefront browser API URL policy", () => {
  it("does not silently fall back to a nonexistent same-origin /api/v1 proxy", async () => {
    const files = [
      "src/lib/api/client.ts",
      "src/layouts/Layout.astro",
      "src/components/AuthModal.tsx",
      "src/components/search/CommandPalette.tsx",
    ];

    const sources = await Promise.all(
      files.map((file) => readFile(join(storefrontRoot, file), "utf8")),
    );

    for (const source of sources) {
      expect(source).not.toMatch(/\|\|\s*["']\/api\/v1["']/);
      expect(source).not.toMatch(/return\s+["']\/api\/v1["']/);
    }
  });

  it("keeps service-binding fallback limited to safe public reads", async () => {
    const source = await readFile(
      join(storefrontRoot, "src/lib/api/client.ts"),
      "utf8",
    );

    expect(source).toContain("const SERVICE_BINDING_READ_TIMEOUT_MS = 2_000;");
    expect(source).toContain(
      "/authorization|cookie|token|session|proof|secret|key/i",
    );
    expect(source).toContain("isPublicApiReadUrl(url)");
    expect(source).toContain(
      "hasSensitiveRequestHeaders(headers)",
    );
    expect(source).toContain(
      "/^\\/api\\/v1\\/(auth|customer|checkout|orders?|payments?|refunds?|webhooks?|scanner|setup)\\b/i",
    );
    expect(source).toContain("if (!canFallbackToHttp) {");
    expect(source).toContain("throw error;");
    expect(source).toContain("falling back to HTTPS API");
    expect(source).toContain("Storefront API HTTPS fallback");
  });
});
