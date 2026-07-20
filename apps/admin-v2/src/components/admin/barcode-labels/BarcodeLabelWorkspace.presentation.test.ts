import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./BarcodeLabelWorkspace.tsx", import.meta.url),
  "utf8",
);

describe("BarcodeLabelWorkspace presentation boundary", () => {
  it("stacks selected SKU facts above controls on narrow screens", () => {
    expect(source).toContain(
      'className="grid gap-2 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"',
    );
    expect(source).toContain(
      'className="flex items-center justify-end gap-1 sm:contents"',
    );
  });

  it("truncates long identities without hiding their full value", () => {
    expect(source).toContain(
      'className="truncate font-mono" title={variant.sku}',
    );
    expect(source).toContain(
      'title={variant.barcode ?? "No barcode"}',
    );
  });

  it("names each SKU picker checkbox", () => {
    expect(source).toContain(
      'aria-label={`${selected ? "Remove" : "Add"} ${variant.productName} ${variant.optionLabel || variant.sku}`}',
    );
  });

  it("keeps print blockers and their recovery beside the selected SKUs", () => {
    const readinessNotice = source.indexOf("not safely fit this format");
    const skuPicker = source.indexOf(">Add SKUs</");
    const pagePreview = source.indexOf(">Page preview</");

    expect(readinessNotice).toBeGreaterThan(-1);
    expect(readinessNotice).toBeLessThan(skuPicker);
    expect(readinessNotice).toBeLessThan(pagePreview);
  });

  it("warns only when a merchant deliberately skips sheet cells", () => {
    expect(source).toContain("Leave the first ${startOffset}");
    expect(source).toContain("{startOffset > 0 ? (");
    expect(source).toContain(
      "Do not re-feed cut, damaged, or adhesive sheets unless the sheet maker and printer allow it.",
    );
  });

  it("keeps the primary mobile print targets at least 44 pixels tall", () => {
    expect(source.match(/className="min-h-11 shrink-0"/g)).toHaveLength(2);
  });

  it("uses mobile-safe targets throughout the progressive workspace without loosening desktop density", () => {
    expect(source).toContain('className="mt-0.5 h-11 w-11 shrink-0 sm:h-8 sm:w-8"');
    expect(source).toContain('className="h-11 pl-8 text-sm sm:h-8"');
    expect(source).toContain('className="h-11 sm:h-9"');
    expect(source).toContain('className="flex h-11 items-center overflow-hidden rounded-md border bg-background sm:h-8"');
    expect(source.match(/className="h-11 w-11 sm:h-7 sm:w-7"/g)).toHaveLength(4);
  });
});
