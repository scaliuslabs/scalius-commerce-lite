import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { storefrontSourcePath } from "../lib/test-source-paths";

const COMPONENT_DIR = storefrontSourcePath("components");

describe("product shortcode purchase boundaries", () => {
  it("uses buyer-visible variants and disables purchase actions for unavailable products", () => {
    const source = readFileSync(`${COMPONENT_DIR}/ProductShortcode.tsx`, "utf8");

    expect(source).toContain("resolveBuyerVariants");
    expect(source).toContain("const buyerVariants = useMemo(");
    expect(source).toContain("const isUnavailable = buyerVariants.length === 0;");
    expect(source).toContain("This product is not available right now.");
    expect(source.match(/disabled=\{isUnavailable\}/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("uses merchant-defined option labels for cart context and visible selectors", () => {
    const source = readFileSync(`${COMPONENT_DIR}/ProductShortcode.tsx`, "utf8");

    expect(source).toContain("product.variantOption1Label");
    expect(source).toContain("product.variantOption2Label");
    expect(source).toContain("type CartItemOption");
    expect(source).toContain("name: option1Label");
    expect(source).toContain("name: option2Label");
    expect(source).not.toContain("(size/weight)");
    expect(source).not.toContain("(color/style)");
  });
});
