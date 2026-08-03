import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/components/catalog/CatalogEmptyState.astro"),
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
