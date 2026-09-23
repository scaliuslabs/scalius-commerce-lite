import { describe, expect, it } from "vitest";

import { getProductEditorSaveStep } from "./save-orchestration";

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
});
