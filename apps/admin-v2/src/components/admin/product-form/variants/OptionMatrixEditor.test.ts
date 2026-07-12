import { describe, expect, it } from "vitest";
import {
  combinationKey,
  getOptionMatrixIssue,
  materializeCombination,
  materializeVariants,
  materializeVariantsExcluding,
  missingOptionCombinations,
  type DraftOption,
  type DraftVariant,
} from "./option-matrix-editor-model";

const option = (
  id: string,
  name: string,
  values: Array<[string, string]>,
  standardMapping: DraftOption["standardMapping"] = "none",
): DraftOption => ({
  id,
  name,
  standardMapping,
  values: values.map(([valueId, value]) => ({ id: valueId, value })),
});

const variant = (
  id: string,
  selectedOptionValueIds: string[],
  stock = 0,
): DraftVariant => ({
  id,
  selectedOptionValueIds,
  imageId: null,
  sku: `SKU-${id}`,
  price: 100,
  stock,
  trackInventory: true,
  weight: null,
  barcode: null,
  barcodeType: null,
  discountType: "percentage",
  discountPercentage: 0,
  discountAmount: 0,
});

describe("option matrix editor model", () => {
  it("accepts the persisted internal Code 128 barcode type", () => {
    const barcodeType: DraftVariant["barcodeType"] = "code128";
    expect(barcodeType).toBe("code128");
  });

  it("does not treat an optionless simple product as an omitted combination", () => {
    expect(missingOptionCombinations([], [])).toEqual([]);
    expect(missingOptionCombinations([option("format", "Format", [])], [])).toEqual([]);
  });

  it("does not multiply inventory when a new axis expands a saved SKU", () => {
    const rows = materializeVariants(
      [option("size", "Size", [["small", "Small"]]), option("finish", "Finish", [["matte", "Matte"], ["gloss", "Gloss"]])],
      [variant("small", ["small"], 10)],
      "Desk lamp",
      100,
      0,
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.stock)).toEqual([10, 0]);
    expect(rows.reduce((total, row) => total + row.stock, 0)).toBe(10);
    expect(new Set(rows.map((row) => row.sku)).size).toBe(2);
  });

  it("preserves total inventory when removing an axis merges SKUs", () => {
    const rows = materializeVariants(
      [option("size", "Size", [["small", "Small"]])],
      [variant("matte", ["small", "matte"], 4), variant("gloss", ["small", "gloss"], 6)],
      "Desk lamp",
      100,
      0,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.stock).toBe(10);
  });

  it("allocates a simple SKU's on-hand stock exactly once", () => {
    const rows = materializeVariants(
      [option("format", "Format", [["print", "Print"], ["digital", "Digital"]])],
      [],
      "Guide",
      25,
      7,
    );
    expect(rows.map((row) => row.stock)).toEqual([7, 0]);
  });

  it("allows a valid subset of the Cartesian product and reports omitted combinations", () => {
    const options = [
      option("color", "Color", [["white", "White"], ["black", "Black"]]),
      option("weight", "Weight", [["1kg", "1KG"], ["5kg", "5KG"]]),
    ];
    const rows = [
      variant("white-1", ["white", "1kg"]),
      variant("black-1", ["black", "1kg"]),
      variant("black-5", ["black", "5kg"]),
    ];

    expect(getOptionMatrixIssue(options, rows, [], false)).toBeNull();
    expect(missingOptionCombinations(options, rows)).toEqual([["white", "5kg"]]);
  });

  it("preserves an intentional omission when a new option expands the matrix", () => {
    const originalOptions = [
      option("color", "Color", [["white", "White"], ["black", "Black"]]),
      option("weight", "Weight", [["1kg", "1KG"], ["5kg", "5KG"]]),
    ];
    const originalRows = materializeVariants(originalOptions, [], "Protein", 100, 0)
      .filter((row) => combinationKey(row.selectedOptionValueIds) !== combinationKey(["white", "5kg"]));
    const expandedOptions = [
      ...originalOptions,
      option("pack", "Pack", [["single", "Single"], ["case", "Case"]]),
    ];
    const rows = materializeVariantsExcluding(
      expandedOptions,
      originalRows,
      "Protein",
      100,
      0,
      new Set([combinationKey(["white", "5kg"])]),
    );

    expect(rows).toHaveLength(6);
    expect(rows.some((row) => row.selectedOptionValueIds.includes("white")
      && row.selectedOptionValueIds.includes("5kg"))).toBe(false);
  });

  it("restores one omitted combination without restoring the others", () => {
    const options = [
      option("color", "Color", [["white", "White"], ["black", "Black"]]),
      option("weight", "Weight", [["1kg", "1KG"], ["5kg", "5KG"]]),
    ];
    const rows = [variant("white-1", ["white", "1kg"]), variant("black-1", ["black", "1kg"])];
    const restored = materializeCombination(options, rows, ["white", "5kg"], "Protein", 100);

    expect(restored.selectedOptionValueIds).toEqual(["white", "5kg"]);
    expect(restored.stock).toBe(0);
    expect(missingOptionCombinations(options, [...rows, restored])).toEqual([["black", "5kg"]]);
  });

  it("rejects duplicate combinations and option values that no active SKU uses", () => {
    const options = [option("color", "Color", [["white", "White"], ["black", "Black"]])];
    expect(getOptionMatrixIssue(options, [
      variant("one", ["white"]),
      variant("two", ["white"]),
    ], [], false)).toBe("Every option combination must be unique.");
    expect(getOptionMatrixIssue(options, [variant("one", ["white"])], [], false))
      .toContain("unused option values");
  });

  it("blocks pending topology and normalized duplicate identities", () => {
    const options = [
      option("one", "Finish", [["matte", "Matte"]], "material"),
      option("two", " finish ", [["gloss", "Gloss"]], "material"),
    ];
    expect(getOptionMatrixIssue(options, [], [], true)).toBe("Option names must be unique.");
  });

  it("blocks duplicate SKUs, barcodes, invalid images, and excessive flat discounts", () => {
    const options = [option("format", "Format", [["print", "Print"], ["digital", "Digital"]])];
    const rows = [variant("one", ["print"]), variant("two", ["digital"])];
    rows[1]!.sku = rows[0]!.sku.toLowerCase();
    expect(getOptionMatrixIssue(options, rows, [], false)).toBe("Every SKU must be unique.");

    rows[1]!.sku = "SKU-two";
    rows[0]!.barcode = "123";
    rows[0]!.barcodeType = "custom";
    rows[1]!.barcode = "123";
    rows[1]!.barcodeType = "custom";
    expect(getOptionMatrixIssue(options, rows, [], false)).toBe("Every barcode must be unique.");

    rows[1]!.barcode = "456";
    rows[0]!.imageId = "missing";
    expect(getOptionMatrixIssue(options, rows, [], false)).toContain("no longer in this product");

    rows[0]!.imageId = null;
    rows[0]!.discountType = "flat";
    rows[0]!.discountAmount = 101;
    expect(getOptionMatrixIssue(options, rows, [], false)).toContain("cannot exceed its price");
  });

  it("requires exact simple-stock allocation and protects committed units", () => {
    const options = [option("format", "Format", [["print", "Print"]])];
    const rows = [variant("one", ["print"], 4)];
    expect(getOptionMatrixIssue(options, rows, [], false, new Map(), 7, 0)).toContain("Allocate exactly 7");
    expect(getOptionMatrixIssue(options, rows, [], false, new Map([["one", 5]]), 0, 0)).toContain("lower than committed");
  });
});
