import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const COMPONENT_DIR = fileURLToPath(new URL(".", import.meta.url));

describe("product shortcode purchase boundaries", () => {
  it("uses buyer-visible variants and disables purchase actions for unavailable products", () => {
    const source = readFileSync(`${COMPONENT_DIR}/ProductShortcode.tsx`, "utf8");

    expect(source).toContain("resolveBuyerVariants");
    expect(source).toContain("const buyerVariants = useMemo(");
    expect(source).toContain("const isUnavailable = buyerVariants.length === 0;");
    expect(source).toContain("This product is not available right now.");
    expect(source.match(/disabled=\{isUnavailable\}/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
