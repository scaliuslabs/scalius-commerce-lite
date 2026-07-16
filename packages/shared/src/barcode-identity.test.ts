import { describe, expect, it } from "vitest";

import {
  BARCODE_TYPES,
  generateInternalCode128Barcode,
  getBarcodeIdentityKey,
  getBarcodeValidationError,
  normalizeBarcodeValue,
} from "./barcode-identity";

describe("barcode identity", () => {
  it("preserves merchant casing while trimming the stored value", () => {
    expect(normalizeBarcodeValue("  AbC-123  ")).toBe("AbC-123");
  });

  it("uses trim plus deterministic en-US case folding for identity", () => {
    expect(getBarcodeIdentityKey("  AbC-123  ")).toBe("abc-123");
  });

  it("normalizes missing and blank values to null", () => {
    expect(normalizeBarcodeValue(null)).toBeNull();
    expect(normalizeBarcodeValue(undefined)).toBeNull();
    expect(normalizeBarcodeValue(" \n\t ")).toBeNull();
    expect(getBarcodeIdentityKey("   ")).toBeNull();
  });
});

describe("barcode validation", () => {
  it("exports a stable supported type list", () => {
    expect(BARCODE_TYPES).toEqual(["ean13", "upc", "isbn", "gtin", "code128", "custom"]);
  });

  it("generates a deterministic compact numeric internal Code 128 identity", () => {
    const generated = generateInternalCode128Barcode("var_abc-123");
    expect(generated).toMatch(/^99\d{12}$/);
    expect(generateInternalCode128Barcode("var_abc-123")).toBe(generated);
    expect(generateInternalCode128Barcode("var_abc-124")).not.toBe(generated);
    expect(getBarcodeValidationError(
      generated,
      "code128",
    )).toBeNull();
  });

  it("requires barcode and type together while allowing both to be absent", () => {
    expect(getBarcodeValidationError(null, null)).toBeNull();
    expect(getBarcodeValidationError("   ", undefined)).toBeNull();
    expect(getBarcodeValidationError("5901234123457", null)).toBe(
      "Barcode and barcode type must be provided together.",
    );
    expect(getBarcodeValidationError(null, "ean13")).toBe(
      "Barcode and barcode type must be provided together.",
    );
    expect(getBarcodeValidationError("ABC", "qr")).toBe(
      "Unsupported barcode type.",
    );
  });

  it("validates EAN-13 without losing leading zeroes", () => {
    expect(getBarcodeValidationError("5901234123457", "ean13")).toBeNull();
    expect(getBarcodeValidationError("  4006381333931  ", "ean13")).toBeNull();
    expect(getBarcodeValidationError("0123456789012", "ean13")).toBeNull();
    expect(normalizeBarcodeValue("  0123456789012  ")).toBe("0123456789012");
    expect(getBarcodeValidationError("5901234123458", "ean13")).toBe(
      "EAN-13 must be 13 digits with a valid checksum.",
    );
  });

  it("validates UPC-A as a 12-digit GTIN checksum", () => {
    expect(getBarcodeValidationError("036000291452", "upc")).toBeNull();
    expect(getBarcodeValidationError("036000291453", "upc")).toBe(
      "UPC-A must be 12 digits with a valid checksum.",
    );
    expect(getBarcodeValidationError("36000291452", "upc")).toBe(
      "UPC-A must be 12 digits with a valid checksum.",
    );
  });

  it("validates every supported GTIN length", () => {
    expect(getBarcodeValidationError("96385074", "gtin")).toBeNull();
    expect(getBarcodeValidationError("036000291452", "gtin")).toBeNull();
    expect(getBarcodeValidationError("5901234123457", "gtin")).toBeNull();
    expect(getBarcodeValidationError("10012345000017", "gtin")).toBeNull();
    expect(getBarcodeValidationError("10012345000018", "gtin")).toBe(
      "GTIN must be 8, 12, 13, or 14 digits with a valid checksum.",
    );
    expect(getBarcodeValidationError("1234567890", "gtin")).toBe(
      "GTIN must be 8, 12, 13, or 14 digits with a valid checksum.",
    );
  });

  it("validates ISBN-10, ISBN-10 with X, and ISBN-13", () => {
    expect(getBarcodeValidationError("0306406152", "isbn")).toBeNull();
    expect(getBarcodeValidationError("097522980X", "isbn")).toBeNull();
    expect(getBarcodeValidationError("097522980x", "isbn")).toBeNull();
    expect(getBarcodeValidationError("9780306406157", "isbn")).toBeNull();
    expect(getBarcodeValidationError("9770306406158", "isbn")).toBe(
      "ISBN must be a valid ISBN-10 or ISBN-13.",
    );
    expect(getBarcodeValidationError("0306406153", "isbn")).toBe(
      "ISBN must be a valid ISBN-10 or ISBN-13.",
    );
  });

  it("accepts nonblank custom values up to 50 characters", () => {
    expect(getBarcodeValidationError(" Custom-Code ", "custom")).toBeNull();
    expect(getBarcodeValidationError("x".repeat(50), "custom")).toBeNull();
    expect(getBarcodeValidationError("x".repeat(51), "custom")).toBe(
      "Custom barcode must be 50 characters or fewer.",
    );
    expect(getBarcodeValidationError("   ", "custom")).toBe(
      "Barcode and barcode type must be provided together.",
    );
  });

  it("accepts printable Code 128B text but rejects non-ASCII and oversized values", () => {
    expect(getBarcodeValidationError("SCALIUS:C128:var_123", "code128")).toBeNull();
    expect(getBarcodeValidationError("SKU 123", "code128")).toBeNull();
    expect(getBarcodeValidationError("পণ্য-১", "code128")).toBe(
      "Code 128 must be 50 printable ASCII characters or fewer.",
    );
    expect(getBarcodeValidationError("x".repeat(51), "code128")).toBe(
      "Code 128 must be 50 printable ASCII characters or fewer.",
    );
  });
});
