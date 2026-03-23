// src/components/admin/product-form/index.ts

// Section Components
export { AdditionalInfoSection } from "./AdditionalInfoSection";
export { AttributesSection } from "./AttributesSection";
export { BasicInfoSection } from "./BasicInfoSection";
export { PricingAvailabilitySection } from "./PricingAvailabilitySection";
export { ProductImagesSection } from "./ProductImagesSection";
export { SeoSection } from "./SeoSection";
export { TitleDescriptionSection } from "./TitleDescriptionSection";
export { PricingCard } from "./PricingCard";
export { StatusCard } from "./StatusCard";
export { OrganizationCard } from "./OrganizationCard";
export { CollapsibleCard } from "./CollapsibleCard";

// Shared Components
export { ProductFormActions } from "./ProductFormActions";
export { ProductStickyHeader } from "./ProductStickyHeader";
export { InfoBanner } from "./InfoBanner";

// Manager Components (legacy/internal use)
export {
  AdditionalInfoManager,
  type RichContentItem,
} from "./AdditionalInfoManager";
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
