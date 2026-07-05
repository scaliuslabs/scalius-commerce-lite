import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const VARIANT_MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));
const VARIANT_MANAGER_SOURCE = fileURLToPath(
  new URL("./VariantManager.tsx", import.meta.url),
);
const SIMPLE_SKU_PANEL_SOURCE = fileURLToPath(
  new URL("./SimpleProductSkuPanel.tsx", import.meta.url),
);
const VARIANT_TOOLBAR_SOURCE = fileURLToPath(
  new URL("./VariantActionsToolbar.tsx", import.meta.url),
);
const VARIANT_TABLE_SOURCE = fileURLToPath(
  new URL("./VariantTable.tsx", import.meta.url),
);
const VARIANT_ROW_SOURCE = fileURLToPath(
  new URL("./VariantDisplayRow.tsx", import.meta.url),
);
const VARIANT_STATS_SOURCE = fileURLToPath(
  new URL("./VariantStatsDisplay.tsx", import.meta.url),
);
const VARIANT_FORM_ROW_SOURCE = fileURLToPath(
  new URL("./VariantFormRow.tsx", import.meta.url),
);
const VARIANT_BULK_EDIT_ROW_SOURCE = fileURLToPath(
  new URL("./VariantBulkEditRow.tsx", import.meta.url),
);
const VARIANT_IMPORT_EXPORT_SOURCE = fileURLToPath(
  new URL("./VariantImportExport.tsx", import.meta.url),
);
const BULK_GENERATOR_SOURCE = fileURLToPath(
  new URL("./bulk-generator/BulkVariantGeneratorDialog.tsx", import.meta.url),
);
const BULK_CONFIG_SOURCE = fileURLToPath(
  new URL("./bulk-generator/VariantConfigSection.tsx", import.meta.url),
);
const BULK_PREVIEW_SOURCE = fileURLToPath(
  new URL("./bulk-generator/VariantPreviewTable.tsx", import.meta.url),
);
const CSV_HELPERS_SOURCE = fileURLToPath(
  new URL("./utils/csvHelpers.ts", import.meta.url),
);
const ORDER_ITEM_SELECTION_SOURCE = fileURLToPath(
  new URL("../../order-form/ItemSelection.tsx", import.meta.url),
);
const PRODUCT_VIEW_SOURCE = fileURLToPath(
  new URL("../../ProductView.tsx", import.meta.url),
);

function collectTsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return collectTsxFiles(child);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [child] : [];
  });
}

describe("VariantManager product mode boundaries", () => {
  it("routes one protected no-option SKU to the simple inventory panel", () => {
    const source = readFileSync(VARIANT_MANAGER_SOURCE, "utf8");

    expect(source).toContain("import { SimpleProductSkuPanel }");
    expect(source).toContain("const activeVariants = useMemo");
    expect(source).toContain("variant.deletedAt === null");
    expect(source).toContain("getVariantManagementMode(activeVariants)");
    expect(source).toContain('variantMode.mode === "simple" && !isAdding');
    expect(source).toContain("<SimpleProductSkuPanel");
    expect(source).toContain("variant={variantMode.variant}");
    expect(source).toContain("onAddOption=");
  });

  it("keeps protected simple SKUs out of the customer-option matrix", () => {
    const source = readFileSync(VARIANT_MANAGER_SOURCE, "utf8");
    const toolbarSource = readFileSync(VARIANT_TOOLBAR_SOURCE, "utf8");
    const tableSource = readFileSync(VARIANT_TABLE_SOURCE, "utf8");

    expect(source).toContain("const matrixVariants = useMemo");
    expect(source).toContain('if (variantMode.mode === "optioned") return variantMode.variants;');
    expect(source).toContain('if (variantMode.mode === "simple" && isAdding) return [];');
    expect(source).toContain("const filtered = filterVariants(matrixVariants, filters)");
    expect(source).toContain("getVariantStats(matrixVariants)");
    expect(source).toContain("variants={matrixVariants}");
    expect(source).toContain("reservedVariants={reservedVariants}");
    expect(toolbarSource).toContain("skuConflictVariants");
    expect(tableSource).toContain("addVariantDefaults");
  });

  it("uses merchant-facing SKU language for simple products and option language for option tables", () => {
    const simpleSource = readFileSync(SIMPLE_SKU_PANEL_SOURCE, "utf8");
    const toolbarSource = readFileSync(VARIANT_TOOLBAR_SOURCE, "utf8");
    const tableSource = readFileSync(VARIANT_TABLE_SOURCE, "utf8");
    const rowSource = readFileSync(VARIANT_ROW_SOURCE, "utf8");
    const statsSource = readFileSync(VARIANT_STATS_SOURCE, "utf8");
    const orderItemSelectionSource = readFileSync(ORDER_ITEM_SELECTION_SOURCE, "utf8");
    const productViewSource = readFileSync(PRODUCT_VIEW_SOURCE, "utf8");
    const productFormSource = readFileSync(
      new URL("../../ProductForm.tsx", import.meta.url),
      "utf8",
    );
    const productImagesSource = readFileSync(
      new URL("../ProductImagesSection.tsx", import.meta.url),
      "utf8",
    );

    expect(simpleSource).toContain("Product SKU");
    expect(simpleSource).toContain("One SKU, no option choices.");
    expect(simpleSource).toContain("No stock limit");
    expect(simpleSource).toContain("Set up options");
    expect(simpleSource).toContain("No customer options");
    expect(simpleSource).toContain("Price and discount stay in Pricing.");
    expect(simpleSource).not.toContain('name="price"');
    expect(simpleSource).not.toContain("Discount type");
    expect(toolbarSource).toContain("Search options...");
    expect(toolbarSource).toContain("onClick={onAddVariant}");
    expect(toolbarSource).toContain("Spreadsheet");
    expect(toolbarSource).toContain("Option 1");
    expect(toolbarSource).toContain("Option 2");
    expect(tableSource).toContain("No options yet");
    expect(tableSource).toContain("Option 1");
    expect(tableSource).toContain("Option 2");
    expect(tableSource).toContain("VariantMobileCard");
    expect(tableSource).toContain("const showMobileCards");
    expect(tableSource).toContain("md:hidden");
    expect(tableSource).toContain("hidden md:block");
    expect(tableSource).toContain('const editLabel = isProtectedDefaultSku ? "Edit product SKU" : "Edit option"');
    expect(tableSource).toContain("aria-label={editLabel}");
    expect(tableSource).toContain("Price");
    expect(tableSource).toContain("Available");
    expect(tableSource).toContain("On hand");
    expect(rowSource).toContain("Option actions");
    expect(rowSource).toContain("Edit option");
    expect(rowSource).toContain("Edit product SKU");
    expect(rowSource).toContain("Delete option");
    expect(rowSource).toContain("Product SKU");
    expect(rowSource).toContain("No option");
    expect(rowSource).toContain("No stock limit");
    expect(rowSource).not.toContain("SIMPLE SKU");
    expect(rowSource).not.toContain("NO LIMIT");
    expect(rowSource).not.toContain("NOT TRACKED");
    expect(rowSource).not.toContain("ALWAYS");
    expect(statsSource).toContain("no stock limit");
    expect(statsSource).not.toContain("Not tracked");
    expect(orderItemSelectionSource).toContain("Product SKU");
    expect(orderItemSelectionSource).toContain("No stock limit");
    expect(orderItemSelectionSource).not.toContain("Simple product SKU");
    expect(orderItemSelectionSource).not.toContain("Stock: not tracked");
    expect(productViewSource).toContain("Product SKU");
    expect(productViewSource).toContain("No stock limit");
    expect(productViewSource).toContain("Option 1: ${v.size}");
    expect(productViewSource).toContain("Option 2: ${v.color}");
    expect(productViewSource).not.toContain("Simple product SKU");
    expect(productViewSource).not.toContain("Size: ${v.size}");
    expect(productViewSource).not.toContain("Color: ${v.color}");
    expect(productFormSource).toContain("manage its product SKU or add customer options");
    expect(productFormSource).not.toContain("size/color options");
    expect(productImagesSource).toContain('Product Options → "Reorder"');
    expect(productImagesSource).not.toContain('"Sort Options"');
  });

  it("saves dirty simple SKU changes before entering first option setup", () => {
    const simpleSource = readFileSync(SIMPLE_SKU_PANEL_SOURCE, "utf8");

    expect(simpleSource).toContain("const handleSetUpOptions = async () =>");
    expect(simpleSource).toContain("form.formState.isDirty");
    expect(simpleSource).toContain("const isValid = await form.trigger()");
    expect(simpleSource).toContain("saveSimpleSku(form.getValues())");
  });

  it("prefills first option setup from the protected simple SKU without reusing its SKU or no-limit state", () => {
    const source = readFileSync(VARIANT_MANAGER_SOURCE, "utf8");
    const rowSource = readFileSync(VARIANT_TABLE_SOURCE, "utf8");

    expect(source).toContain("function firstOptionDefaultsFromSimpleSku");
    expect(source).toContain('sku: ""');
    expect(source).toContain("price: variant.price");
    expect(source).toContain("trackInventory: true");
    expect(source).toContain("addVariantDefaults={isFirstOptionSetup ? addVariantDefaults : undefined}");
    expect(rowSource).toContain("defaultValues={addVariantDefaults}");
  });

  it("keeps bulk/import dialogs open when no options are created", () => {
    const source = readFileSync(VARIANT_MANAGER_SOURCE, "utf8");
    const importSource = readFileSync(VARIANT_TOOLBAR_SOURCE, "utf8");

    expect(source).toContain('throw new Error("No options were created.")');
    expect(source).toContain('throw new Error("No options were imported.")');
    expect(importSource).toContain("reservedVariants");
  });

  it("keeps CSV import dialog UI behind an explicit import interaction", () => {
    const toolbarSource = readFileSync(VARIANT_TOOLBAR_SOURCE, "utf8");
    const importExportSource = readFileSync(VARIANT_IMPORT_EXPORT_SOURCE, "utf8");

    expect(toolbarSource).not.toContain(
      'import { VariantImportExport } from "./VariantImportExport"',
    );
    expect(toolbarSource).toContain("const VariantImportExport = lazy(");
    expect(toolbarSource).toContain('import("./VariantImportExport")');
    expect(toolbarSource).toContain("setShouldLoadImportDialog(true)");
    expect(toolbarSource).toContain("const handleExport = async () =>");
    expect(toolbarSource).toContain('import("./utils/csvHelpers")');
    expect(toolbarSource).toContain("initialImportDialogOpen");
    expect(importExportSource).toContain("initialImportDialogOpen");
    expect(importExportSource).toContain("@/components/ui/dialog");
    expect(importExportSource).toContain("<DialogContent");
  });

  it("keeps stock-limit controls visible across row edit, spreadsheet edit, bulk generation, and CSV", () => {
    const formRowSource = readFileSync(VARIANT_FORM_ROW_SOURCE, "utf8");
    const bulkEditSource = readFileSync(VARIANT_BULK_EDIT_ROW_SOURCE, "utf8");
    const generatorSource = readFileSync(BULK_GENERATOR_SOURCE, "utf8");
    const configSource = readFileSync(BULK_CONFIG_SOURCE, "utf8");
    const previewSource = readFileSync(BULK_PREVIEW_SOURCE, "utf8");
    const csvSource = readFileSync(CSV_HELPERS_SOURCE, "utf8");
    const managerSource = readFileSync(VARIANT_MANAGER_SOURCE, "utf8");

    expect(formRowSource).toContain('name="trackInventory"');
    expect(formRowSource).toContain("StockLimitField");
    expect(formRowSource).toContain("Stock limit for this option");
    expect(formRowSource).toContain("Track stock");
    expect(formRowSource).toContain("No stock limit");
    expect(formRowSource).not.toContain("No limit");
    expect(formRowSource).toContain("Math.max(0");
    expect(bulkEditSource).toContain("'trackInventory'");
    expect(bulkEditSource).toContain("Stock limit for option");
    expect(bulkEditSource).toContain("Track stock");
    expect(bulkEditSource).toContain("No stock limit");
    expect(bulkEditSource).not.toContain("No limit");
    expect(generatorSource).toContain("const [trackInventory, setTrackInventory] = useState(true)");
    expect(generatorSource).toContain("trackInventory,");
    expect(generatorSource).toContain("validateSkuTemplate");
    expect(generatorSource).toContain("skuTemplateValidation.valid");
    expect(configSource).toContain("Track stock for generated options");
    expect(previewSource).toContain("variant.trackInventory === false");
    expect(csvSource).toContain('"Track Stock"');
    expect(csvSource).toContain("parseTrackInventory");
    expect(managerSource).toContain("delete withoutIgnoredStock.stock");
  });

  it("renders option add/edit as compact spreadsheet-style editing", () => {
    const tableSource = readFileSync(VARIANT_TABLE_SOURCE, "utf8");
    const formRowSource = readFileSync(VARIANT_FORM_ROW_SOURCE, "utf8");
    const bulkEditSource = readFileSync(VARIANT_BULK_EDIT_ROW_SOURCE, "utf8");

    expect(tableSource).toContain("VariantFormEditor");
    expect(tableSource).toContain("showMobileEditor");
    expect(formRowSource).toContain("VariantOptionForm");
    expect(formRowSource).toContain('layout="row"');
    expect(formRowSource).toContain('layout="card"');
    expect(formRowSource).toContain("BarcodeFields");
    expect(tableSource).toContain("Stock limit");
    expect(tableSource).toContain("min-w-[90px]");
    expect(tableSource).toContain("min-w-[80px]");
    expect(bulkEditSource).toContain("grid h-8 grid-cols-2");
    expect(formRowSource).toContain("grid h-7 grid-cols-2");
    expect(formRowSource).toContain('aria-label="Track stock"');
    expect(formRowSource).toContain("rounded-[4px] bg-background px-2 text-[11px] shadow-none");
    expect(formRowSource).toContain("border border-border/60");
    expect(formRowSource).toContain('label="Option 1"');
    expect(formRowSource).toContain('hint="choice"');
    expect(formRowSource).toContain('placeholder="2KG, XL, 100ml"');
    expect(formRowSource).toContain('label="Option 2"');
    expect(formRowSource).toContain('placeholder="Red, Blue, Pro"');
    expect(formRowSource).not.toContain('hint="size"');
    expect(formRowSource).not.toContain('hint="color"');
    expect(formRowSource).not.toContain("colSpan={11}");
  });

  it("marks every variant-module button as non-submit or explicit submit", () => {
    for (const file of collectTsxFiles(VARIANT_MODULE_DIR)) {
      const source = readFileSync(file, "utf8");
      const buttonTags = source.matchAll(/<Button\b[\s\S]*?>/g);

      for (const match of buttonTags) {
        const tag = match[0];
        const line = source.slice(0, match.index).split("\n").length;

        expect(tag, `${file}:${line}`).toContain("type=");
      }
    }
  });
});
