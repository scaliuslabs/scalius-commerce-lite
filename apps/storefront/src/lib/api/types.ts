// src/lib/api/types.ts
//
// Centralized type definitions for the Scalius Commerce storefront.
//
// SDK response types are re-exported with short aliases from @scalius/api-client.
// Domain interfaces (Product, Category, etc.) are kept locally because the SDK
// exports per-endpoint response wrappers, not standalone domain types.

// ---------------------------------------------------------------------------
// SDK Re-exports (response types, aliased for brevity)
// ---------------------------------------------------------------------------

import type {
  PostApiV1OrdersData,
  GetApiV1ProductsResponse as GetProductsResponse,
  GetApiV1ProductsBySlugResponse as GetProductsBySlugResponse,
  GetApiV1CategoriesResponse as GetCategoriesResponse,
  GetApiV1CategoriesBySlugResponse as GetCategoriesBySlugResponse,
  GetApiV1CollectionsResponse as GetCollectionsResponse,
  GetApiV1CollectionsByIdResponse as GetCollectionsByIdResponse,
  GetApiV1SearchResponse as GetSearchResponse,
  GetApiV1HeaderResponse as GetHeaderResponse,
  GetApiV1FooterResponse as GetFooterResponse,
  GetApiV1NavigationResponse as GetNavigationResponse,
  GetApiV1PagesResponse as GetPagesResponse,
  GetApiV1PagesSlugBySlugResponse as GetPagesSlugBySlugResponse,
  GetApiV1SeoResponse as GetSeoResponse,
  GetApiV1HeroSlidersResponse as GetHeroSlidersResponse,
  GetApiV1CheckoutLanguagesActiveResponse as GetCheckoutLanguagesActiveResponse,
  GetApiV1DiscountsValidateResponse as GetDiscountsValidateResponse,
  GetApiV1AnalyticsConfigurationsResponse as GetAnalyticsConfigurationsResponse,
  GetApiV1WidgetsActiveHomepageResponse as GetWidgetsActiveHomepageResponse,
  GetApiV1WidgetsByIdResponse as GetWidgetsByIdResponse,
  GetApiV1LocationsCitiesResponse as GetLocationsCitiesResponse,
  GetApiV1LocationsZonesResponse as GetLocationsZonesResponse,
  GetApiV1LocationsAreasResponse as GetLocationsAreasResponse,
  PostApiV1OrdersResponse as PostOrdersResponse,
} from "@scalius/api-client/types";

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
};

// Extract the order request body type from the SDK endpoint definition.
export type OrderPostRequest = NonNullable<PostApiV1OrdersData["body"]>;

// ---------------------------------------------------------------------------
// Generic API Responses (storefront-specific wrappers)
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: {
    code: string;
    message: string;
    details?: Array<{ field?: string; message: string }>;
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
// Product & Category Types (local domain types — SDK only has response wrappers)
// ---------------------------------------------------------------------------

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
  imageAlt?: string | null;
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
  isDefault?: boolean;
  trackInventory?: boolean;
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
  createdAt: string | null;
  updatedAt?: string | null;
}

export interface CategorySummary {
  id: string;
  name: string;
  slug: string;
}

export interface CategoryProductsResponse extends PaginatedResponse<Product> {
  category: Category | null;
  categoryNotFound?: boolean;
}

// ---------------------------------------------------------------------------
// Collection & Widget Types (local domain types — SDK only has response wrappers)
// ---------------------------------------------------------------------------

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
  jsContent?: string | null;
  isActive: boolean;
  displayTarget: string;
  placementRule: string;
  referenceCollectionId?: string | null;
  sortOrder: number;
  placements?: ApiWidgetPlacement[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface ApiWidgetPlacement {
  id: string;
  widgetId: string;
  scope: string;
  scopeId?: string | null;
  slot: string;
  anchorType?: string | null;
  anchorId?: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt?: string | number | null;
  updatedAt?: string | number | null;
  deletedAt?: string | number | null;
}

// ---------------------------------------------------------------------------
// Page & Site Settings Types (local domain types — SDK only has response wrappers)
// ---------------------------------------------------------------------------

export interface PageFeaturedImage {
  id: string;
  url: string;
  filename: string;
  size: number;
  mimeType?: string;
  altText?: string | null;
  width?: number | null;
  height?: number | null;
  folderId?: string | null;
  createdAt?: string | number;
  updatedAt?: string | number;
}

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
  featuredImage?: PageFeaturedImage | null;
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
// Order & Cart Types (local domain types — SDK only has response wrappers)
// ---------------------------------------------------------------------------

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

export interface OrderReceipt {
  id: string;
  customerName: string;
  shippingAddress: string;
  totalAmount: number;
  shippingCharge: number;
  discountAmount: number | null;
  city: string;
  zone: string;
  area: string | null;
  cityName: string | null;
  zoneName: string | null;
  areaName: string | null;
  status: string;
  paymentMethod: string | null;
  paymentStatus: string;
  paidAmount: number;
  balanceDue: number;
  createdAt: string | null;
  updatedAt: string | null;
  items: OrderItem[];
}

export type CreateOrderPayload = OrderPostRequest;

// ---------------------------------------------------------------------------
// Other Types (local domain types — SDK only has response wrappers)
// ---------------------------------------------------------------------------

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
// Checkout Language Types (local domain type — SDK only has response wrappers)
// ---------------------------------------------------------------------------

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
