import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { getProductEditorSaveStep } from "./save-orchestration";

const productFormSource = readFileSync(
  new URL("../ProductForm.tsx", import.meta.url),
  "utf8",
);
const editRouteSource = readFileSync(
  new URL("../../../routes/admin/products/$productId/edit.tsx", import.meta.url),
  "utf8",
);

describe("product editor save orchestration", () => {
  it("persists unsaved product composition before the option matrix", () => {
    expect(getProductEditorSaveStep({
      isEdit: true,
      productFormDirty: true,
      hasRevisionConflict: false,
    })).toBe("save-product");
  });

  it("allows a matrix-only save only after product composition is clean", () => {
    expect(getProductEditorSaveStep({
      isEdit: true,
      productFormDirty: false,
      hasRevisionConflict: false,
    })).toBe("save-matrix");
  });

  it("keeps create atomic and resolves revision conflicts before either write", () => {
    expect(getProductEditorSaveStep({
      isEdit: false,
      productFormDirty: false,
      hasRevisionConflict: false,
    })).toBe("save-product");
    expect(getProductEditorSaveStep({
      isEdit: true,
      productFormDirty: true,
      hasRevisionConflict: true,
    })).toBe("review-conflict");
  });

  it("uses one coordinator from the card through the returned revision handoff", () => {
    expect(productFormSource).toContain("onSave={requestSave}");
    expect(productFormSource).toContain("requestSave,");
    expect(editRouteSource).toContain("onSaveRequest={requestSave}");
    expect(editRouteSource).toContain("if (matrixDirty) matrixRef.current?.save(revision)");
  });
});
