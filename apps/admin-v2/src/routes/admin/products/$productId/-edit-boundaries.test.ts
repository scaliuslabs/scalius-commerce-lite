import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const EDIT_ROUTE_SOURCE = fileURLToPath(new URL("./edit.tsx", import.meta.url));
const PRODUCT_FORM_SOURCE = fileURLToPath(
  new URL("../../../../components/admin/ProductForm.tsx", import.meta.url),
);
const TITLE_DESCRIPTION_SOURCE = fileURLToPath(
  new URL(
    "../../../../components/admin/product-form/TitleDescriptionSection.tsx",
    import.meta.url,
  ),
);

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

  it("keeps product description on the deferred Tiptap boundary", () => {
    const source = readFileSync(TITLE_DESCRIPTION_SOURCE, "utf8");

    expect(source).toContain(
      'import { DeferredTiptapEditor } from "@/components/ui/tiptap/DeferredTiptapEditor"',
    );
    expect(source).toContain("<DeferredTiptapEditor");
    expect(source).not.toContain(
      'from "@/components/ui/tiptap/TiptapEditor"',
    );
  });

  it("passes merchant option labels into product edit media and variants", () => {
    const routeSource = readFileSync(EDIT_ROUTE_SOURCE, "utf8");
    const productFormSource = readFileSync(PRODUCT_FORM_SOURCE, "utf8");

    expect(routeSource).toContain("VariantOptionLabels");
    expect(routeSource).toContain("option1: defaultValues.variantOption1Label");
    expect(routeSource).toContain("option2: defaultValues.variantOption2Label");
    expect(routeSource).toContain("optionLabels={variantOptionLabels}");

    expect(productFormSource).toContain('form.watch("variantOption1Label")');
    expect(productFormSource).toContain('form.watch("variantOption2Label")');
    expect(productFormSource).toContain("const variantOptionLabels = React.useMemo");
    expect(productFormSource).toContain("optionLabels={variantOptionLabels}");
  });
});
