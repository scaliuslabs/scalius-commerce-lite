// src/lib/api/types.ts
//
// Centralized type definitions for the Scalius Commerce storefront.
//
// Types are sourced from the shared @scalius/api-client SDK where available,
// with storefront-specific types defined locally.
//
// The SDK types (generated from the OpenAPI spec) are primarily request/response
// wrappers (e.g., GetProductsResponse, PostOrdersData). Storefront-specific
// domain interfaces (Product, Category, etc.) are kept locally because the SDK
// does not yet export standalone domain types. Once the SDK is regenerated with
// extracted domain types, more of these can be replaced with SDK re-exports.

// ---------------------------------------------------------------------------
// SDK Re-exports
// ---------------------------------------------------------------------------

// OrderPostRequest from the SDK closely matches our CreateOrderPayload.
// Differences:
//   - SDK adds: totalAmount (optional), omits: shippingMethodId, paymentMethod
//   - Storefront needs: shippingMethodId, paymentMethod
// We keep the local CreateOrderPayload to preserve the extra fields the
// storefront relies on, but re-export the SDK type for reference/use where
// the stricter API contract is desired.
export type { OrderPostRequest } from "@scalius/api-client/types";

// Re-export SDK response types that consumers may find useful for typing
// raw API responses directly.
export type {
  GetProductsResponse,
  GetProductsBySlugResponse,
  GetCategoriesResponse,
  GetCategoriesBySlugResponse,
  GetCollectionsResponse,
  GetCollectionsByIdResponse,
  GetSearchResponse,
  GetHeaderResponse,
  GetFooterResponse,
  GetNavigationResponse,
  GetPagesResponse,
  GetPagesSlugBySlugResponse,
  GetSeoResponse,
  GetHeroSlidersResponse,
  GetCheckoutLanguagesActiveResponse,
  GetDiscountsValidateResponse,
  GetAnalyticsConfigurationsResponse,
  GetWidgetsActiveHomepageResponse,
  GetWidgetsByIdResponse,
  GetLocationsCitiesResponse,
  GetLocationsZonesResponse,
  GetLocationsAreasResponse,
  PostOrdersResponse,
} from "@scalius/api-client/types";

// ---------------------------------------------------------------------------
// Generic API Responses (storefront-specific wrappers)
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: {
    code: string;
    message: string;
    details?: any[];
  };
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ---------------------------------------------------------------------------
// Product & Category Types
// ---------------------------------------------------------------------------
// TODO: Replace with SDK domain types once @scalius/api-client exports
// standalone Product, ProductVariant, ProductImage, Category, CategorySummary.

export interface ProductRichContent {
  id: string;
  title: string;
  content: string;
}

export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price: number;
  discountType: "percentage" | "flat" | null;
  discountPercentage: number | null;
  discountAmount: number | null;
  discountedPrice: number;
  freeDelivery: boolean;
  isActive: boolean;
  metaTitle: string | null;
  metaDescription: string | null;
  features?: string[];
  additionalInfo?: ProductRichContent[];
  attributes?: Array<{ name: string; value: string; slug: string }>;
  categoryId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  imageUrl?: string | null;
  category?: CategorySummary;
  hasVariants: boolean;
}

export interface ProductVariant {
  id: string;
  productId: string;
  size: string | null;
  color: string | null;
  weight: number | null;
  sku: string;
  price: number;
  stock: number;
  reservedStock?: number;
  discountType: "percentage" | "flat" | null;
  discountPercentage: number | null;
  discountAmount: number | null;
  colorSortOrder: number;
  sizeSortOrder: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ProductImage {
  id: string;
  productId: string;
  url: string;
  alt: string;
  isPrimary: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  createdAt: string;
}

export interface CategorySummary {
  id: string;
  name: string;
  slug: string;
}

// ---------------------------------------------------------------------------
// Collection & Widget Types
// ---------------------------------------------------------------------------
// TODO: Replace with SDK domain types once @scalius/api-client exports
// standalone Collection, CollectionConfig, CollectionWithProducts, ApiWidget.

export interface CollectionConfig {
  categoryIds?: string[];
  productIds?: string[];
  featuredProductId?: string;
  maxProducts?: number;
  title?: string;
  subtitle?: string;
}

export interface Collection {
  id: string;
  name: string;
  type: "manual" | "dynamic" | "AllCategories";
  config: CollectionConfig;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CollectionWithProducts extends Collection {
  categories?: CategorySummary[];
  products?: Product[];
  featuredProduct?: Product | null;
}

export interface ApiWidget {
  id: string;
  name: string;
  htmlContent: string;
  cssContent?: string | null;
  isActive: boolean;
  displayTarget: string;
  placementRule: string;
  referenceCollectionId?: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

// ---------------------------------------------------------------------------
// Page & Site Settings Types
// ---------------------------------------------------------------------------
// TODO: Replace with SDK domain types once @scalius/api-client exports
// standalone Page, NavigationItem, FooterMenu, HeaderData, FooterData, etc.

export interface Page {
  id: string;
  title: string;
  slug: string;
  content: string;
  metaTitle: string | null;
  metaDescription: string | null;
  isPublished: boolean;
  hideHeader: boolean;
  hideFooter: boolean;
  hideTitle: boolean;
  publishedAt: number | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  widgets?: ApiWidget[];
}

// Recursive Navigation Item - supports unlimited nesting depth
export interface NavigationItem {
  id?: string;
  title: string;
  href?: string;
  subMenu?: NavigationItem[];
}

// Flat navigation item - for normalized API response
export interface FlatNavigationItem {
  id: string;
  title: string;
  href: string | null;
  parentId: string | null;
  childIds: string[];
  depth: number;
  sortOrder: number;
}

// Recursive Footer Menu Link - supports nested subMenu
export interface FooterMenuLink {
  id?: string;
  title: string;
  href: string;
  subMenu?: FooterMenuLink[];
}

// Footer Menu - supports both nested (links) and flat (items/rootIds) structures
export interface FooterMenu {
  id: string;
  title: string;
  // Nested format (legacy/converted)
  links?: FooterMenuLink[];
  // Flat format (new backend response)
  items?: Record<string, FlatNavigationItem>;
  rootIds?: string[];
}

// Social Link - supports custom labels and icons
export interface SocialLink {
  id?: string;
  label: string;
  url: string;
  iconUrl?: string;
  // Legacy fields for backwards compatibility
  platform?: string;
  icon?: string;
}

export interface HeaderData {
  topBar: {
    text: string;
    isEnabled?: boolean;
  };
  logo: { src: string; alt: string };
  favicon?: { src: string; alt: string };
  contact: {
    phone: string;
    text: string;
    isEnabled?: boolean;
  };
  social: SocialLink[];
}

export interface FooterData {
  logo: { src: string; alt: string };
  favicon?: { src: string; alt: string };
  tagline: string;
  copyrightText: string;
  description?: string;
  menus: FooterMenu[];
  social: SocialLink[];
}

export interface SeoSettings {
  siteTitle: string | null;
  homepageTitle: string | null;
  homepageMetaDescription: string | null;
  robotsTxt: string | null;
}

// ---------------------------------------------------------------------------
// Order & Cart Types
// ---------------------------------------------------------------------------
// TODO: Replace with SDK domain types once @scalius/api-client exports
// standalone Order, OrderItem types.

export interface OrderItem {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  price: number;
  productName: string | null;
  productImage: string | null;
  variantSize: string | null;
  variantColor: string | null;
}

export interface Order {
  id: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  shippingAddress: string;
  totalAmount: number;
  shippingCharge: number;
  discountAmount: number | null;
  notes: string | null;
  city: string;
  zone: string;
  area: string | null;
  cityName: string | null;
  zoneName: string | null;
  areaName: string | null;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  items: OrderItem[];
  shipments: any[];
  deliveryProviders: any[];
}

// CreateOrderPayload extends the SDK's OrderPostRequest with storefront-specific
// fields (shippingMethodId, paymentMethod) that are not yet in the OpenAPI spec.
export interface CreateOrderPayload {
  customerName: string;
  customerPhone: string;
  customerEmail?: string | null;
  shippingAddress: string;
  city: string;
  zone: string;
  area?: string | null;
  cityName?: string | null;
  zoneName?: string | null;
  areaName?: string | null;
  notes?: string | null;
  items: Array<{
    productId: string;
    variantId?: string | null;
    quantity: number;
    price: number;
  }>;
  shippingCharge: number;
  shippingMethodId?: string;
  discountAmount?: number | null;
  discountCode?: string | null;
  paymentMethod?: "cod" | "stripe" | "sslcommerz";
}

// ---------------------------------------------------------------------------
// Other Types
// ---------------------------------------------------------------------------
// TODO: Replace with SDK domain types once @scalius/api-client exports
// standalone LocationData, ShippingMethod, Discount, AnalyticsConfig, etc.

export interface LocationData {
  id: string;
  name: string;
  type: "city" | "zone" | "area";
  parentId: string | null;
  isActive: boolean;
  sortOrder: number;
}

export interface ShippingMethod {
  id: string;
  name: string;
  fee: number;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface Discount {
  id: string;
  code: string;
  type: string;
  valueType: string;
  discountValue: number;
  minPurchaseAmount?: number | null;
  combineWithProductDiscounts?: boolean;
  combineWithOrderDiscounts?: boolean;
  combineWithShippingDiscounts?: boolean;
}

export interface DiscountValidationResponse {
  valid: boolean;
  error?: string;
  discount?: Discount;
  discountAmount?: number;
  minPurchaseAmount?: number;
  minQuantity?: number;
}

export interface AnalyticsConfig {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  usePartytown: boolean;
  config: string;
  location: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResults {
  products: Product[];
  categories: Category[];
  pages: Page[];
  success: boolean;
  query: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Checkout Language Types
// ---------------------------------------------------------------------------
// TODO: Replace with SDK domain type once @scalius/api-client exports
// standalone CheckoutLanguageData.

export interface CheckoutLanguageData {
  id: string;
  name: string;
  code: string;
  languageData: {
    pageTitle: string;
    checkoutSectionTitle: string;
    cartSectionTitle: string;
    customerNameLabel: string;
    customerNamePlaceholder: string;
    customerPhoneLabel: string;
    customerPhonePlaceholder: string;
    customerPhoneHelp: string;
    customerEmailLabel: string;
    customerEmailPlaceholder: string;
    shippingAddressLabel: string;
    shippingAddressPlaceholder: string;
    cityLabel: string;
    zoneLabel: string;
    areaLabel: string;
    shippingMethodLabel: string;
    orderNotesLabel: string;
    orderNotesPlaceholder: string;
    continueShoppingText: string;
    subtotalText: string;
    shippingText: string;
    discountText: string;
    totalText: string;
    discountCodePlaceholder: string;
    applyDiscountText: string;
    removeDiscountText: string;
    placeOrderText: string;
    processingText: string;
    emptyCartText: string;
    termsText: string;
    processingOrderTitle: string;
    processingOrderMessage: string;
    requiredFieldIndicator: string;
  };
  fieldVisibility: {
    showEmailField: boolean;
    showOrderNotesField: boolean;
    showAreaField: boolean;
  };
  isActive: boolean;
  isDefault: boolean;
}
