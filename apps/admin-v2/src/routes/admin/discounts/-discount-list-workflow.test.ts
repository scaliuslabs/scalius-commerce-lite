import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./index.tsx", import.meta.url)),
  "utf8",
);

describe("discount list workflow", () => {
  it("uses a mobile-specific card instead of squeezing the desktop table", () => {
    expect(source).toContain("<DiscountMobileCard");
    expect(source).toContain("mobileCardRenderer={mobileCardRenderer}");
  });

  it("surfaces query failure with a retry instead of rendering a misleading empty list", () => {
    expect(source).toContain("error={error}");
    expect(source).toContain("onRetry={() => void refetch()}");
  });
});
