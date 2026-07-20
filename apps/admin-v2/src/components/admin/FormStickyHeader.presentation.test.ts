import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sharedSource = readFileSync(
  new URL("./FormStickyHeader.tsx", import.meta.url),
  "utf8",
);
const productSource = readFileSync(
  new URL("./product-form/ProductStickyHeader.tsx", import.meta.url),
  "utf8",
);

describe("mobile form action bars", () => {
  it.each([
    ["shared", sharedSource],
    ["product", productSource],
  ])("keeps %s primary actions touch-sized without enlarging desktop", (_name, source) => {
    expect(source).toContain(
      "flex h-14 items-center justify-between gap-2 px-4 sm:h-12 sm:gap-4 sm:px-6",
    );
    expect(source.match(/h-11 text-xs sm:h-8/g)).toHaveLength(2);
    expect(source).toContain("h-11 text-xs font-medium sm:h-8");
  });

  it.each([
    ["shared", sharedSource],
    ["product", productSource],
  ])("keeps %s status copy accessible without crowding narrow actions", (_name, source) => {
    expect(source).toContain("sr-only text-xs");
    expect(source).toContain("sm:not-sr-only");
  });
});
