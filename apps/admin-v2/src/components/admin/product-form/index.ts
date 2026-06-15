// src/components/admin/product-form/index.ts

// Section Components
export { AttributesSection } from "./AttributesSection";
export { ProductImagesSection } from "./ProductImagesSection";
export { SeoSection } from "./SeoSection";
export { TitleDescriptionSection } from "./TitleDescriptionSection";
export { PricingCard } from "./PricingCard";
export { StatusCard } from "./StatusCard";
export { OrganizationCard } from "./OrganizationCard";
export { CollapsibleCard } from "./CollapsibleCard";

// Shared Components
export { ProductStickyHeader } from "./ProductStickyHeader";
export { InfoBanner } from "./InfoBanner";

// Manager Components (legacy/internal use)
export { AttributeManager } from "./AttributeManager";

// Hooks
export { useProductSubmit } from "./hooks/useProductSubmit";
export { useProductVariants } from "./hooks/useProductVariants";

// Types
export {
  productFormSchema,
  type ProductFormValues,
  type Category,
  type ProductImage,
} from "./types";

// Utils
export * from "./utils";
