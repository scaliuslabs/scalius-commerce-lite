import { describe, expect, it } from "vitest";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA, BANGLA_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import type { ProductCustomization } from "@/lib/api/types";
import {
  buyerInputsSurchargeMinor,
  cartLinePropertiesFromOrderLine,
  characterCount,
  counterText,
  customizationSchemaFromView,
  moneyPlaces,
  pickBuyerInputCopy,
  readPostedBuyerInputs,
  resolveProductPageCopy,
  surchargeText,
  unitPriceWithSurcharge,
  validateBuyerInputs,
} from "./buyer-inputs";

const copy = pickBuyerInputCopy(ENGLISH_CHECKOUT_LANGUAGE_DATA);
const taka = (amount: number) => `৳${amount}`;

function view(): ProductCustomization {
  return {
    fields: [
      { key: "engraving", label: "Engraving text", type: "text", required: false, help: "Up to 12 characters", maxLength: 12, price: 200, priceMinor: 20_000, options: [] },
      { key: "wrap", label: "Gift wrap", type: "checkbox", required: false, help: null, maxLength: null, price: 50, priceMinor: 5_000, options: [] },
      {
        key: "fit", label: "Fit", type: "select", required: true, help: null, maxLength: null, price: 0, priceMinor: 0,
        options: [
          { value: "regular", label: "Regular", price: 0, priceMinor: 0 },
          { value: "slim", label: "Slim", price: 100, priceMinor: 10_000 },
        ],
      },
      { key: "note", label: "Instructions", type: "textarea", required: false, help: null, maxLength: 500, price: 0, priceMinor: 0, options: [] },
    ],
  };
}

describe("buyer inputs", () => {
  it("builds the shared schema from the product page view, in schema order", () => {
    const schema = customizationSchemaFromView(view());
    expect(schema).toMatchObject({
      version: 1,
      fields: [
        { key: "engraving", type: "text", maxLength: 12, priceMinor: 20_000 },
        { key: "wrap", type: "checkbox", priceMinor: 5_000 },
        { key: "fit", type: "select", required: true, options: [{ value: "regular", priceMinor: 0 }, { value: "slim", priceMinor: 10_000 }] },
        { key: "note", type: "textarea", maxLength: 500, priceMinor: 0 },
      ],
    });
    expect(customizationSchemaFromView(null)).toBeNull();
    expect(customizationSchemaFromView({ fields: [] })).toBeNull();
  });

  it("sums the surcharges of filled inputs in minor units", () => {
    const schema = customizationSchemaFromView(view());
    expect(buyerInputsSurchargeMinor(schema, [])).toBe(0);
    expect(buyerInputsSurchargeMinor(schema, [
      { key: "engraving", value: "  Anika " },
      { key: "wrap", value: "true" },
      { key: "fit", value: "slim" },
    ])).toBe(35_000);
    // Whitespace is not a filled input; an unticked box sends nothing.
    expect(buyerInputsSurchargeMinor(schema, [
      { key: "engraving", value: "   " },
      { key: "wrap", value: "" },
      { key: "fit", value: "regular" },
    ])).toBe(0);
  });

  it("adds surcharges to the base price without float drift", () => {
    expect(unitPriceWithSurcharge(1200, 20_000, 2)).toBe(1400);
    expect(unitPriceWithSurcharge(0.1, 20, 2)).toBe(0.3);
    expect(unitPriceWithSurcharge(10.005, 1, 3)).toBe(10.006);
    expect(unitPriceWithSurcharge(99.99, 0, 2)).toBe(99.99);
  });

  it("returns canonical cart properties: schema order, empty optional inputs dropped, ticked box as true", () => {
    const result = validateBuyerInputs(customizationSchemaFromView(view()), [
      { key: "note", value: "" },
      { key: "fit", value: "slim" },
      { key: "wrap", value: "true" },
      { key: "engraving", value: "  Anika  " },
    ], copy);
    expect(result).toEqual({
      ok: true,
      canonical: [
        { key: "engraving", value: "Anika" },
        { key: "wrap", value: "true" },
        { key: "fit", value: "slim" },
      ],
      properties: [
        { key: "engraving", value: "Anika", label: "Engraving text", displayValue: "Anika", priceMinor: 20_000 },
        { key: "wrap", value: "true", label: "Gift wrap", displayValue: "Yes", priceMinor: 5_000 },
        { key: "fit", value: "slim", label: "Fit", displayValue: "Slim", priceMinor: 10_000 },
      ],
      propertiesPriceMinor: 35_000,
    });
  });

  it("says which field is missing or too long, in schema order", () => {
    const schema = customizationSchemaFromView({
      fields: [
        ...view().fields,
        { key: "consent", label: "Proof approval", type: "checkbox", required: true, help: null, maxLength: null, price: 0, priceMinor: 0, options: [] },
        { key: "name", label: "Name", type: "text", required: true, help: null, maxLength: 20, price: 0, priceMinor: 0, options: [] },
      ],
    });
    const result = validateBuyerInputs(schema, [
      { key: "engraving", value: "Thirteen chars" },
    ], copy);
    expect(result).toEqual({
      ok: false,
      errors: [
        { key: "engraving", message: "Use at most 12 characters." },
        { key: "fit", message: "Choose Fit." },
        { key: "consent", message: "Tick Proof approval to continue." },
        { key: "name", message: "Fill in Name." },
      ],
    });
  });

  it("counts Unicode characters of the NFC text, as the server does", () => {
    // "é" typed as e + combining accent is one character after NFC.
    expect(characterCount("é")).toBe(1);
    expect(characterCount("আনিকা")).toBe(5);
    expect(characterCount("😀")).toBe(1);
    expect(counterText(copy, "Anika", 12)).toBe("5/12");
    const schema = customizationSchemaFromView(view());
    expect(validateBuyerInputs(schema, [
      { key: "engraving", value: "😀".repeat(12) },
      { key: "fit", value: "regular" },
    ], copy).ok).toBe(true);
  });

  it("formats surcharge pills and skips free inputs", () => {
    expect(surchargeText(copy, 20_000, 2, taka)).toBe("+৳200");
    expect(surchargeText(copy, 0, 2, taka)).toBeNull();
    expect(moneyPlaces(2, "BDT")).toBe(2);
    expect(moneyPlaces(6, "USD")).toBe(2);
  });

  it("reads the product page copy in the store language, merchant edits first", () => {
    const bangla = resolveProductPageCopy({ languageCode: "bn", addToCartText: "ব্যাগে রাখুন" });
    expect(bangla.addToCartText).toBe("ব্যাগে রাখুন");
    expect(bangla.customizationOptionalText).toBe(BANGLA_CHECKOUT_LANGUAGE_DATA.customizationOptionalText);
    expect(resolveProductPageCopy(undefined).updateCartItemText).toBe("Update cart");
  });

  it("maps the server's resolved inputs to cart line properties", () => {
    expect(cartLinePropertiesFromOrderLine([
      { key: "fit", type: "select", label: "Fit", value: "slim", displayValue: "Slim", price: 100, priceMinor: 10_000 },
    ])).toEqual([{ key: "fit", value: "slim", label: "Fit", displayValue: "Slim", priceMinor: 10_000 }]);
    expect(cartLinePropertiesFromOrderLine(undefined)).toEqual([]);
  });

  it("reads a bounded no-JavaScript form body", () => {
    const body = new URLSearchParams([
      ["variant", "var_1"],
      ["quantity", "২"],
      ["property.engraving", "Anika"],
      ["property.fit", "slim"],
      ["unrelated", "ignored"],
    ]);
    expect(readPostedBuyerInputs(body.entries())).toEqual({
      ok: true,
      variantId: "var_1",
      quantity: "২",
      properties: [
        { key: "engraving", value: "Anika" },
        { key: "fit", value: "slim" },
      ],
    });
    const tooMany = new URLSearchParams(
      Array.from({ length: 11 }, (_, index) => [`property.field_${index}`, "x"] as [string, string]),
    );
    expect(readPostedBuyerInputs(tooMany.entries())).toEqual({ ok: false });
    expect(readPostedBuyerInputs(new URLSearchParams([["property.note", "x".repeat(1_001)]]).entries())).toEqual({ ok: false });
    expect(readPostedBuyerInputs(new URLSearchParams([["property.a", "1"], ["property.a", "2"]]).entries())).toEqual({ ok: false });
  });
});
