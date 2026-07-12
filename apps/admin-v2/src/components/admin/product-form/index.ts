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
export { ProductActionBar } from "./ProductStickyHeader";
export { InfoBanner } from "./InfoBanner";

// Hooks
export { useProductSubmit } from "./hooks/useProductSubmit";

// Types
export {
  DEFAULT_PRODUCT_CONDITION,
  productFormSchema,
  type ProductFormValues,
  type Category,
  type ProductMediaItem,
} from "./types";

// Utils
export * from "./utils";
