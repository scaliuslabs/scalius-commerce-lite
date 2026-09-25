import { translate } from "~/i18n";
import { productMessages, type ProductMessageKey } from "~/i18n/products";
import { describe, expect, it } from "vitest";
import {
  combinationKey,
  getOptionMatrixIssue,
  followProductDefaults,
  getSimpleSkuIssue,
  guessOptionType,
  materializeCombination,
  materializeVariants,
  materializeVariantsExcluding,
  missingOptionCombinations,
  withGuessedOptionType,
  type DraftOption,
  type DraftVariant,
} from "./option-matrix-editor-model";
import {
  fulfilmentModeOf,
  matrixSaveVariants as saveRows,
  withFulfilmentMode,
  type DraftVariant as FulfilmentRow,
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

const issue = (key: ProductMessageKey, vars?: Record<string, number>) => translate(productMessages, key, vars);

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

  it("keeps partial SKU imagery explicit when a new axis expands the matrix", () => {
    const white = variant("white", ["white"]);
    white.imageId = "img_white";
    const black = variant("black", ["black"]);
    const rows = materializeVariants(
      [
        option("color", "Color", [["white", "White"], ["black", "Black"]]),
        option("size", "Size", [["small", "Small"], ["large", "Large"]]),
      ],
      [white, black],
      "T-shirt",
      100,
      0,
    );

    expect(rows.filter((row) => row.selectedOptionValueIds.includes("white")).map((row) => row.imageId))
      .toEqual(["img_white", "img_white"]);
    expect(rows.filter((row) => row.selectedOptionValueIds.includes("black")).map((row) => row.imageId))
      .toEqual([null, null]);
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
    ], [], false)?.message).toBe(issue("issueDuplicateVariant"));
    expect(getOptionMatrixIssue(options, [variant("one", ["white"])], [], false)?.message)
      .toBe(issue("issueUnusedValue"));
  });

  it("blocks pending topology and normalized duplicate identities", () => {
    const options = [
      option("one", "Finish", [["matte", "Matte"]], "material"),
      option("two", " finish ", [["gloss", "Gloss"]], "material"),
    ];
    expect(getOptionMatrixIssue(options, [], [], true)?.message).toBe(issue("issueOptionNamesUnique"));
  });

  it("blocks duplicate SKUs, barcodes, invalid images, and excessive flat discounts", () => {
    const options = [option("format", "Format", [["print", "Print"], ["digital", "Digital"]])];
    const rows = [variant("one", ["print"]), variant("two", ["digital"])];
    rows[1]!.sku = rows[0]!.sku.toLowerCase();
    expect(getOptionMatrixIssue(options, rows, [], false)?.message).toBe(issue("issueSkuUnique"));

    rows[1]!.sku = "SKU-two";
    rows[0]!.barcode = "123";
    rows[0]!.barcodeType = "custom";
    rows[1]!.barcode = "123";
    rows[1]!.barcodeType = "custom";
    expect(getOptionMatrixIssue(options, rows, [], false)?.message).toBe(issue("issueBarcodeUnique"));

    rows[1]!.barcode = "456";
    rows[0]!.imageId = "missing";
    expect(getOptionMatrixIssue(options, rows, [], false)?.message).toBe(issue("issuePhotoRemoved"));
    expect(getOptionMatrixIssue(options, rows, [], false, { allowSavedImageRemovalConfirmation: true })).toBeNull();

    rows[0]!.imageId = null;
    rows[0]!.discountType = "flat";
    rows[0]!.discountAmount = 101;
    expect(getOptionMatrixIssue(options, rows, [], false)).toEqual({
      message: issue("issueDiscountOverPrice"),
      variantId: "one",
      field: "discount",
    });
  });

  it("puts number problems on the variant's own field", () => {
    const options = [option("format", "Format", [["print", "Print"], ["digital", "Digital"]])];
    const rows = [variant("one", ["print"]), variant("two", ["digital"])];
    rows[1]!.price = Number.NaN;
    expect(getOptionMatrixIssue(options, rows, [], false)).toEqual({ message: issue("issueNotANumber"), variantId: "two", field: "price" });
    rows[1]!.price = 100_000_000;
    expect(getOptionMatrixIssue(options, rows, [], false)).toMatchObject({ variantId: "two", field: "price" });
    rows[1]!.price = 0;
    expect(getOptionMatrixIssue(options, rows, [], false)).toBeNull();
    expect(getOptionMatrixIssue(options, rows, [], false, { requirePositivePrice: true }))
      .toEqual({ message: issue("issueVariantNeedsPrice"), variantId: "two", field: "price" });
    rows[1]!.price = 100;
    rows[0]!.stock = 2.5;
    expect(getOptionMatrixIssue(options, rows, [], false)).toEqual({ message: issue("issueQuantityWhole"), variantId: "one", field: "stock" });
  });

  it("requires exact simple-stock allocation and protects committed units", () => {
    const options = [option("format", "Format", [["print", "Print"]])];
    const rows = [variant("one", ["print"], 4)];
    expect(getOptionMatrixIssue(options, rows, [], false, { requiredStockAllocation: 7 })?.message).toBe(issue("issueAllocateStock", { required: 7, allocated: 4 }));
    expect(getOptionMatrixIssue(options, rows, [], false, { committedByVariantId: new Map([["one", 5]]) })?.message).toBe(issue("issueBelowCommitted"));
  });

  it("asks only the new variants to carry the stock of variants an option change replaced", () => {
    const options = [option("size", "Size", [["m", "M"], ["xl", "XL"]])];
    const saved = variant("var_m", ["m"], 10);
    const added = { ...variant("draft_xl", ["xl"], 0) };
    // Saved rows keep their own stock; the replaced 6 must land on new rows.
    expect(getOptionMatrixIssue(options, [saved, added], [], false, { requiredStockAllocation: 6, allocationScope: "new" }))
      .toMatchObject({ message: issue("issueReplaceStock", { required: 6, allocated: 0 }) });
    added.stock = 6;
    expect(getOptionMatrixIssue(options, [saved, added], [], false, { requiredStockAllocation: 6, allocationScope: "new" })).toBeNull();
  });

  it("marks an option still being filled in, so its message waits for Save", () => {
    expect(getOptionMatrixIssue([option("size", "Size", [])], [], [], true)).toMatchObject({ incomplete: true });
    expect(getOptionMatrixIssue([option("size", "", [["s", "S"]])], [], [], true)).toMatchObject({ incomplete: true });
    expect(getOptionMatrixIssue([
      option("one", "Size", [["s", "S"]]),
      option("two", "size", [["m", "M"]]),
    ], [], [], true)?.incomplete).toBeUndefined();
  });

  it("validates simple product inventory", () => {
    const simple = (draft: { sku: string; trackInventory: boolean; stock: number; barcode?: string | null }) =>
      ({ barcode: null, barcodeType: null, weight: null, ...draft });
    expect(getSimpleSkuIssue(simple({ sku: "", trackInventory: true, stock: 4 }), 0, false)).toBeNull();
    expect(getSimpleSkuIssue(simple({ sku: "", trackInventory: true, stock: 4 }), 0, true)?.message).toBe(issue("issueSkuShort"));
    expect(getSimpleSkuIssue(simple({ sku: "MUG", trackInventory: true, stock: 1 }), 2, true)?.message).toBe(issue("issueBelowCommitted"));
    expect(getSimpleSkuIssue(simple({ sku: "MUG", trackInventory: false, stock: 0 }), 2, true)?.message).toBe(issue("issueUntrackCommitted"));
    expect(getSimpleSkuIssue(simple({ sku: "MUG", trackInventory: false, stock: 0 }), 0, true)).toBeNull();
    expect(getSimpleSkuIssue(simple({ sku: "MUG", trackInventory: true, stock: Number.NaN }), 0, true))
      .toEqual({ message: issue("issueNotANumber"), field: "stock" });
    expect(getSimpleSkuIssue({ ...simple({ sku: "MUG", trackInventory: true, stock: 1 }), barcode: "4006381333932", barcodeType: "upc" }, 0, true))
      .toEqual({ message: issue("issueBarcodeInvalid"), field: "barcode" });
  });

  it("picks the option type from a known name unless the merchant chose one", () => {
    expect(guessOptionType(" Colour ")).toBe("color");
    expect(guessOptionType("রঙ")).toBe("color");
    expect(guessOptionType("Fit")).toBe("none");

    const blank = option("one", "", []);
    const named = withGuessedOptionType(blank, { ...blank, name: "Size" }, [blank]);
    expect(named.standardMapping).toBe("size");

    const chosen = { ...option("one", "Fit", []), standardMapping: "material" as const };
    expect(withGuessedOptionType(chosen, { ...chosen, name: "Size" }, [chosen]).standardMapping).toBe("material");

    const sizeTaken = option("two", "Size", [], "size");
    expect(withGuessedOptionType(blank, { ...blank, name: "size" }, [blank, sizeTaken]).standardMapping).toBe("none");
  });

  it("keeps new variants on the product title and price until the merchant edits them", () => {
    const options = [option("size", "Size", [["s", "S"], ["m", "M"]])];
    const [small, medium] = materializeVariants(options, [], "", 0, 0);
    expect(small!.sku).toBe("SKU-1");

    const edited = { ...medium!, sku: "MY-OWN", price: 99 };
    const saved = { ...small!, id: "var_saved" };
    const followed = followProductDefaults(options, [small!, edited, saved], { name: "", price: 0 }, { name: "Polo", price: 500 });
    expect(followed[0]).toMatchObject({ sku: "POLO-S", price: 500 });
    expect(followed[1]).toMatchObject({ sku: "MY-OWN", price: 99 });
    expect(followed[2]).toBe(saved);
  });
});

describe("product fulfilment mode", () => {
  const row = (id: string, fulfillmentKind?: "physical" | "service") => ({
    id, selectedOptionValueIds: [], imageId: null, sku: id.toUpperCase(), price: 100, stock: 0, trackInventory: false,
    weight: null, barcode: null, barcodeType: null, discountType: "percentage", discountPercentage: null, discountAmount: null,
    ...(fulfillmentKind ? { fulfillmentKind } : {}),
  }) as FulfilmentRow;

  it("reads the saved SKUs as one kind or per variant", () => {
    expect(fulfilmentModeOf([])).toBe("physical");
    expect(fulfilmentModeOf([{ fulfillmentKind: "service", deletedAt: null }])).toBe("service");
    expect(fulfilmentModeOf([{ fulfillmentKind: "service", deletedAt: null }, { fulfillmentKind: "physical", deletedAt: null }])).toBe("mixed");
    // A retired SKU doesn't count.
    expect(fulfilmentModeOf([{ fulfillmentKind: "service", deletedAt: null }, { fulfillmentKind: "physical", deletedAt: "2026-09-01" }])).toBe("service");
  });

  it("sends one kind on every row, new ones included, so a variant save never puts an old kind back", () => {
    const rows = [row("var_a", "physical"), row("draft_b")];
    expect(withFulfilmentMode(rows, "service").map((variant) => variant.fulfillmentKind)).toEqual(["service", "service"]);
    expect(withFulfilmentMode(rows, "mixed")).toBe(rows);
    expect(saveRows(rows, [], "service").map((variant) => variant.fulfillmentKind)).toEqual(["service", "service"]);
  });
});
