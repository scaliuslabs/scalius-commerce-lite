export const discountEditorTypes = [
  "amount_off_products",
  "amount_off_order",
  "free_shipping",
] as const;

export type DiscountEditorType = (typeof discountEditorTypes)[number];
