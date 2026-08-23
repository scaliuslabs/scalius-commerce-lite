import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storefrontSourcePath } from "../../lib/test-source-paths";

const source = readFileSync(
  storefrontSourcePath("components", "catalog", "CatalogEmptyState.astro"),
  "utf8",
);

describe("catalog empty state boundaries", () => {
  it("keeps the recovery action touch-friendly without an oversized placeholder", () => {
    expect(source).toContain("min-h-11");
    expect(source).toContain("h-12 w-12");
    expect(source).not.toContain("shadow");
    expect(source).not.toContain("w-16 h-16");
  });

  it("uses a consistent semantic heading and route-provided recovery copy", () => {
    expect(source).toContain('<h2 class=');
    expect(source).toContain("{actionLabel}");
    expect(source).toContain("{description}");
  });
});
