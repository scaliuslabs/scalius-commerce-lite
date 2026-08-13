import { describe, expect, it } from "vitest";
import {
  buildInventoryLabelArtifact,
  type InventoryLabelArtifactJob,
  type InventoryLabelArtifactVariant,
} from "./inventory-label-artifacts";

const variant: InventoryLabelArtifactVariant = {
  id: "var_1",
  productName: "Tea & <Coffee>",
  sku: "=FORMULA",
  optionLabel: "Large",
  effectivePrice: 125,
  barcode: "99012345678901",
  barcodeType: "code128",
};

const job: InventoryLabelArtifactJob = {
  format: "csv",
  mode: "job",
  quantities: { var_1: 2 },
  order: "selected",
  preset: {
    pageWidthMm: 210,
    pageHeightMm: 297,
    columns: 3,
    rows: 8,
    marginXmm: 8,
    marginYmm: 8,
    gapXmm: 2,
    gapYmm: 2,
    cropMarks: true,
  },
  startOffset: 1,
  alignment: { xMm: 0, yMm: 0 },
  content: { showProduct: true, showVariant: true, showSku: true, showPrice: true },
};

describe("inventory label server artifacts", () => {
  it("creates formula-safe CSV from authoritative SKU projection", () => {
    const artifact = buildInventoryLabelArtifact([variant], job, "BDT");
    expect(artifact.contentType).toBe("text/csv; charset=utf-8");
    expect(artifact.copyCount).toBe(2);
    expect(String(artifact.body)).toContain("'=FORMULA");
    expect(artifact.byteLength).toBe(new TextEncoder().encode(String(artifact.body)).byteLength);
  });

  it("creates self-contained escaped printable HTML with vector barcodes", () => {
    const artifact = buildInventoryLabelArtifact([variant], { ...job, format: "html" }, "BDT");
    expect(String(artifact.body)).toContain("<!doctype html>");
    expect(String(artifact.body)).toContain("Tea &amp; &lt;Coffee&gt;");
    expect(String(artifact.body)).toContain("<svg");
    expect(String(artifact.body)).not.toContain("https://");
  });

  it("creates a deterministic vector PDF without browser rendering", () => {
    const artifact = buildInventoryLabelArtifact([variant], { ...job, format: "pdf" }, "BDT");
    const pdf = new TextDecoder().decode(artifact.body as Uint8Array);
    expect(pdf.slice(0, 8)).toBe("%PDF-1.4");
    expect(pdf).not.toContain("BDT?");
    expect(artifact.pageCount).toBe(1);
  });

  it("keeps merchant UPC and ISBN-10 text while encoding their retail EAN symbols", () => {
    const upc = { ...variant, id: "upc", barcode: "036000291452", barcodeType: "upc" };
    const isbn = { ...variant, id: "isbn", barcode: "0306406152", barcodeType: "isbn" };
    const artifact = buildInventoryLabelArtifact([upc, isbn], {
      ...job,
      format: "html",
      quantities: { upc: 1, isbn: 1 },
    }, "BDT");
    const html = String(artifact.body);
    expect(html).toContain('<div class="code">036000291452</div>');
    expect(html).not.toContain('<div class="code">0036000291452</div>');
    expect(html).toContain('<div class="code">0306406152</div>');
  });

  it("rejects missing and unbounded copy jobs", () => {
    expect(() => buildInventoryLabelArtifact([variant], {
      ...job,
      quantities: { var_1: 0 },
    }, "BDT")).toThrow("at least one");
    expect(() => buildInventoryLabelArtifact([variant], {
      ...job,
      quantities: { var_1: 1_001 },
    }, "BDT")).toThrow("at most 1000");
  });

  it("fails closed when bounded copy inputs would still produce an oversized download", () => {
    expect(() => buildInventoryLabelArtifact([{
      ...variant,
      productName: "P".repeat(17_000),
    }], {
      ...job,
      quantities: { var_1: 1_000 },
    }, "BDT")).toThrow("exceeds 16777216 bytes");
  });

  it("rejects non-printable custom Code 128 data", () => {
    expect(() => buildInventoryLabelArtifact([{ ...variant, barcode: "বাংলা", barcodeType: "custom" }], job, "BDT"))
      .toThrow("printable ASCII");
  });
});
