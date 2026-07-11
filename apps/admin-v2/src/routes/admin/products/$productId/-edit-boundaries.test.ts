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

  it("keeps query refresh separate from the explicit editor reload generation", () => {
    const source = readFileSync(EDIT_ROUTE_SOURCE, "utf8");

    expect(source).toContain(
      "const [editorSnapshot, setEditorSnapshot] = useState(initialProduct)",
    );
    expect(source).toContain(
      "const [currentAggregateRevision, setCurrentAggregateRevision] = useState(",
    );
    expect(source).toContain(
      "const [formGeneration, setFormGeneration] = useState(0)",
    );
    expect(source).toContain("key={formGeneration}");
    expect(source).toContain("key={`option-editor-${formGeneration}`}");
    expect(source).not.toContain("key={currentAggregateRevision}");
    expect(source).toContain("const latest = (await queryClient.fetchQuery({");
    expect(source).toContain("setEditorSnapshot(latest)");
    expect(source).toContain("setFormGeneration((generation) => generation + 1)");
    expect(source).toContain('getElementById("product-form-heading")?.focus()');
    expect(source).toContain("onAggregateRevisionChange={handleAggregateRevisionChange}");
  });

  it("starts from a fresh detail and keeps one editor-owned SKU snapshot", () => {
    const routeSource = readFileSync(EDIT_ROUTE_SOURCE, "utf8");
    const productFormSource = readFileSync(PRODUCT_FORM_SOURCE, "utf8");

    expect(routeSource).toContain(".fetchQuery({");
    expect(routeSource).not.toContain("staleTime: Infinity");
    expect(routeSource).toContain(
      "const [editorVariants, setEditorVariants] = useState<LocalProductVariant[]>",
    );
    expect(routeSource).toContain("editorVariants={editorVariants}");
    expect(routeSource).toContain("onVariantsChange={setEditorVariants}");
    expect(productFormSource).not.toContain("useProductVariants(");
  });

  it("updates option-editor identity after a product save without remounting", () => {
    const source = readFileSync(EDIT_ROUTE_SOURCE, "utf8");

    expect(source).toContain("const handleProductSaved = useCallback(");
    expect(source).toContain("name: values.name");
    expect(source).toContain("slug: values.slug");
    expect(source).toContain("variantOption1Label: values.variantOption1Label");
    expect(source).toContain("onProductSaved={handleProductSaved}");
  });
});
