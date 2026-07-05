import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const EDIT_ROUTE_SOURCE = fileURLToPath(new URL("./edit.tsx", import.meta.url));

describe("product edit route lazy boundaries", () => {
  it("keeps option management out of the SSR critical path", () => {
    const source = readFileSync(EDIT_ROUTE_SOURCE, "utf8");

    expect(source).toContain('import { useHydrated } from "~/hooks/use-hydrated"');
    expect(source).toContain("const VariantManager = lazy(");
    expect(source).toContain(
      'import("~/components/admin/product-form/variants/VariantManager")',
    );
    expect(source).toContain("const isHydrated = useHydrated()");
    expect(source).toContain("isHydrated ? (");
    expect(source).toContain("<LoadingFallback height=\"h-48\" />");
    expect(source).not.toMatch(
      /import\s+\{\s*VariantManager\s*\}\s+from\s+["']~\/components\/admin\/product-form\/variants["']/,
    );
  });
});
