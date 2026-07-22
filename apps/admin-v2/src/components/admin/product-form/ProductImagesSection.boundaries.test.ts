import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./ProductImagesSection.tsx", import.meta.url), "utf8");

describe("product media editor boundaries", () => {
  it("keeps mixed media product-scoped and SKU assignment image-only", () => {
    expect(source).toContain('capability="both"');
    expect(source).toContain("unavailableFileIds={attachedMediaIds}");
    expect(source).not.toContain("selectedFiles={selectedLibraryFiles(field.value)}");
    expect(source).toContain('item.kind === "image"');
    expect(source).not.toContain("videos stay in the gallery");
  });

  it("bounds large galleries and preserves room for accessible tile controls", () => {
    expect(source).toContain("field.value.slice(0, 12)");
    expect(source).toContain("Manage all ${field.value.length} media items");
    expect(source).toContain("grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6");
    expect(source).toContain("grid-cols-[88px_minmax(0,1fr)]");
    expect(source).toContain('className="h-11 w-11 sm:h-8 sm:w-8"');
  });

  it("edits one contextual override at a time and preserves blank fallback semantics", () => {
    expect(source).toContain('altText: ""');
    expect(source).toContain("Leave blank to use the Media description");
    expect(source).not.toContain("field.value.map((item, index) => (\n        <Input");
  });
});
