export type ProductEditorSaveStep = "review-conflict" | "save-product" | "save-matrix";

export function getProductEditorSaveStep({
  isEdit,
  productFormDirty,
  hasRevisionConflict,
}: {
  isEdit: boolean;
  productFormDirty: boolean;
  hasRevisionConflict: boolean;
}): ProductEditorSaveStep {
  if (hasRevisionConflict) return "review-conflict";
  if (!isEdit || productFormDirty) return "save-product";
  return "save-matrix";
}
