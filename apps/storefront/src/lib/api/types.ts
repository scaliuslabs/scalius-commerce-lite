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
  PostApiV1DiscountsValidateResponse as PostDiscountsValidateResponse,
  GetApiV1AnalyticsConfigurationsResponse as GetAnalyticsConfigurationsResponse,
  GetApiV1LocationsCitiesResponse as GetLocationsCitiesResponse,
  GetApiV1LocationsZonesResponse as GetLocationsZonesResponse,
  GetApiV1LocationsAreasResponse as GetLocationsAreasResponse,
  PostApiV1OrdersResponse as PostOrdersResponse,
} from "@scalius/api-client/types";
import type { SeoDiscoverySettings } from "@scalius/shared/seo-discovery";
import type { ProductCondition } from "@scalius/shared/product-condition";
import type {
  DeliveryMethodKind,
  FulfillmentKind,
  FulfillmentType,
} from "@scalius/shared/fulfilment";
import type { CustomizationFieldType } from "@scalius/shared/line-properties";
import type { CustomerOrderProgress, CustomerOrderTimelineEvent } from "./customer-auth";

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
  PostDiscountsValidateResponse,
  GetAnalyticsConfigurationsResponse,
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
  priceRange?: BuyerPriceRange;
  facets?: ProductFacet[];
  /** Set when the search matched nothing and these results are for this corrected query. */
  correctedQuery?: string | null;
}

export interface BuyerPriceRange {
  min: number;
  max: number;
}

export interface ProductFacetValue {
  value: string;
  count: number;
}

export interface ProductFacet {
  id: string;
  name: string;
  slug: string;
  values: ProductFacetValue[];
}

// ---------------------------------------------------------------------------
// Product & Category Types (local domain types — SDK only has response wrappers)
// ---------------------------------------------------------------------------

export interface ProductRichContent {
  id: string;
  title: string;
  content: string;
}

export type ProductOptionStandardMapping =
  "size" | "color" | "material" | "pattern" | "none";

export interface ProductOptionDefinition {
  id: string;
  name: string;
  position: number;
  standardMapping: ProductOptionStandardMapping;
  values: Array<{ id: string; value: string; position: number }>;
}

export interface SelectedProductOption {
  optionDefinitionId: string;
  optionValueId: string;
  name: string;
  value: string;
  position: number;
  valuePosition: number;
  standardMapping: ProductOptionStandardMapping;
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
  priceVaries?: boolean;
  freeDelivery: boolean;
  isActive: boolean;
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalPath?: string | null;
  productCondition?: ProductCondition | null;
  options?: ProductOptionDefinition[];
  noIndex?: boolean;
  features?: string[];
  additionalInfo?: ProductRichContent[];
  attributes?: Array<{ name: string; value: string; slug: string }>;
  /** The published brand record (product page, feeds); never a free-text attribute. */
  brand?: ProductBrand | null;
  categoryId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  imageUrl?: string | null;
  imageMediaId?: string | null;
  imageAlt?: string | null;
  /** Listing cards only: the next gallery photo, shown on hover. Never a video. */
  secondaryImageUrl?: string | null;
  category?: CategorySummary;
  hasVariants: boolean;
  availableForSale?: boolean;
  variants?: ProductVariant[];
  /** Automatic Buy X get Y discounts this product counts toward (product page only). */
  offers?: ProductBuyGetOffer[];
  /** Gift-card product (product page only): every SKU is a denomination. */
  isGiftCard?: boolean;
  /** Buyer inputs asked above Add to cart (product page only); null when none. */
  customization?: ProductCustomization | null;
  /** Some buyer input is required: quick-buy must send the buyer to the product page. */
  requiresCustomization?: boolean;
  /** The store's buyer-input setup is unreadable: the product can't be bought. */
  customizationUnavailable?: boolean;
  /** Product page only: the template id from the theme; null is the theme's default page. */
  pageTemplate?: string | null;
  /** Product page only: active quantity tiers, priced by checkout exactly as listed. */
  bundles?: ProductBundleTier[];
  /** Product page only: "EMI on card payment, from X/month"; null when it must not show. */
  emi?: ProductEmiOffer | null;
}

/** A quantity tier ("2 for 10% off", "3 for ৳900") in major units. */
export interface ProductBundleTier {
  quantity: number;
  discountType: "percentage" | "fixed_price";
  discountPercentage: number | null;
  /** The price of the whole set for `fixed_price`. */
  price: number | null;
  label: string | null;
  isActive: boolean;
}

/** The lowest monthly amount of the store's EMI plans for a product. Informational only. */
export interface ProductEmiOffer {
  provider: string;
  months: number;
  monthly: number;
  monthlyMinor: number;
}

/** One buyer input as the product page renders it (schema order). */
export interface ProductCustomizationField {
  key: string;
  label: string;
  type: CustomizationFieldType;
  required: boolean;
  help: string | null;
  /** text/textarea only. */
  maxLength: number | null;
  /** text/textarea/checkbox surcharge per unit, in major units; 0 for selects. */
  price: number;
  priceMinor: number;
  options: Array<{ value: string; label: string; price: number; priceMinor: number }>;
}

export interface ProductCustomization {
  fields: ProductCustomizationField[];
}

/**
 * What a recommendation list mostly is, so its title stays honest:
 * "Customers also bought" only for `also_bought` (real co-purchases by two or
 * more buyers), "You might also like" for `similar`, "Popular right now" and
 * "New arrivals" for lists without source products.
 */
export type ProductRecommendationReason = "also_bought" | "similar" | "popular" | "new_arrivals";

export interface ProductRecommendations {
  reason: ProductRecommendationReason;
  products: Product[];
}

export interface ProductBuyGetOffer {
  promotionId: string;
  title: string;
  /** "buy": `products` are what the buyer gets; "get": this product is given and `products` are what to buy. */
  role: "buy" | "get";
  buyQuantity: number | null;
  buyAmount: number | null;
  getQuantity: number;
  /** 100 means the items to get are free. */
  percentOff: number;
  endsAtEpochSeconds: number | null;
  products: Array<{ id: string; slug: string; name: string; variantId: string | null; price: number | null }>;
}

export interface ProductVariant {
  id: string;
  productId: string;
  optionCombinationKey: string | null;
  imageId: string | null;
  imageMediaId?: string | null;
  imageUrl?: string | null;
  selectedOptions: SelectedProductOption[];
  weight: number | null;
  sku: string;
  price: number;
  stock: number;
  reservedStock?: number;
  availabilityBand?: import("@scalius/shared/buyer-availability").BuyerAvailabilityBand;
  isDefault?: boolean;
  trackInventory?: boolean;
  lowStockThreshold?: number | null;
  barcode?: string | null;
  barcodeType?: "ean13" | "upc" | "isbn" | "gtin" | "custom" | string | null;
  discountType: "percentage" | "flat" | null;
  discountPercentage: number | null;
  discountAmount: number | null;
  /** physical (shipped or picked up), digital, or service (performed, no delivery). */
  fulfillmentKind?: FulfillmentKind;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ProductMedia {
  id: string;
  mediaId: string;
  kind: "image" | "video";
  url: string;
  posterMediaId: string | null;
  posterUrl: string | null;
  altText: string;
  caption: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  isPrimary: boolean;
  sortOrder: number;
  status: "ready" | "trashed";
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  /** Available on category detail responses; omitted from list responses. */
  content?: string | null;
  imageUrl: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalPath?: string | null;
  noIndex?: boolean;
  excludeFromSitemap?: boolean;
  /** Tree placement (catalogue 1a): the parent category and the 0-3 depth. */
  parentId?: string | null;
  depth?: number;
  /** Category detail only: a theme listing template id, or null for the theme default. */
  listingTemplate?: string | null;
  /** Category detail only: published sub-categories (sub-category pills and shelves). */
  children?: CategoryTreeLink[];
  /** Category detail only: published ancestors, root first, ending with this category. */
  breadcrumb?: Array<CategoryTreeLink & { depth: number }>;
  createdAt: string | null;
  updatedAt?: string | null;
}

export interface CategoryTreeLink {
  id: string;
  name: string;
  slug: string;
  canonicalPath: string | null;
  imageUrl?: string | null;
}

export interface ProductBrand {
  id: string;
  name: string;
  slug: string;
  canonicalPath?: string | null;
}

export interface BrandLogo {
  mediaId: string;
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
}

/** A published brand (`/brands/<slug>`). */
export interface Brand extends ProductBrand {
  canonicalPath: string | null;
  logo: BrandLogo | null;
  description: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  noIndex: boolean;
  excludeFromSitemap: boolean;
  listingTemplate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface BrandProductsResponse extends PaginatedResponse<Product> {
  brand: Brand | null;
  brandNotFound?: boolean;
}

export interface CategorySummary {
  id: string;
  name: string;
  slug: string;
  canonicalPath?: string | null;
}

export interface CategoryProductsResponse extends PaginatedResponse<Product> {
  category: Category | null;
  categoryNotFound?: boolean;
}

// ---------------------------------------------------------------------------
// Collection Types (local domain types — SDK only has response wrappers)
// ---------------------------------------------------------------------------

export interface CollectionConfig {
  maxProducts?: number;
  title?: string;
  subtitle?: string;
}

export interface Collection {
  id: string;
  name: string;
  presentation: "grid" | "carousel";
  config: CollectionConfig;
  sortOrder: number;
  isActive: boolean;
  canonicalPath?: string | null;
  noIndex?: boolean;
  excludeFromSitemap?: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CollectionWithProducts extends Collection {
  description: string | null;
  content: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  categories?: CategorySummary[];
  products?: Product[];
  featuredProduct?: Product | null;
  pagination: PaginatedResponse<Product>["pagination"];
  priceRange?: BuyerPriceRange;
  facets?: ProductFacet[];
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
  contentType: "page" | "article";
  title: string;
  slug: string;
  content: string;
  excerpt: string | null;
  author: string | null;
  tags: string[];
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalPath?: string | null;
  noIndex?: boolean;
  excludeFromSitemap?: boolean;
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
}

// Recursive Navigation Item - supports unlimited nesting depth
export interface NavigationItem {
  id?: string;
  title: string;
  href?: string;
  openInNewTab?: boolean;
  /** The linked category's photo, when the item links a category that has one. */
  imageUrl?: string;
  subMenu?: NavigationItem[];
}

// Flat navigation item - for normalized API response
export interface FlatNavigationItem {
  id: string;
  title: string;
  href: string | null;
  openInNewTab?: boolean;
  parentId: string | null;
  childIds: string[];
  depth: number;
  sortOrder: number;
}

// Recursive Footer Menu Link - supports nested subMenu
export interface FooterMenuLink {
  id?: string;
  title: string;
  href?: string;
  openInNewTab?: boolean;
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
  logo: { src: string; alt: string; width?: number };
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
  homepageTitle: string;
  homepageMetaDescription: string;
  socialImage: string;
  discovery: SeoDiscoverySettings;
}

// ---------------------------------------------------------------------------
// Order & Cart Types (local domain types — SDK only has response wrappers)
// ---------------------------------------------------------------------------

/** A buyer input frozen on an order line ("Engraving: Anika (+৳200)"). */
export interface OrderLineProperty {
  key: string;
  type: CustomizationFieldType;
  label: string;
  value: string;
  /** The choice label for selects, "Yes" for ticked boxes, the text otherwise. */
  displayValue: string;
  /** Surcharge per unit, in major units. */
  price: number;
  priceMinor: number;
}

/** How an order line reaches the buyer and what it carries (Wave A). */
export interface OrderLineFulfilmentFacts {
  fulfillmentType?: FulfillmentType;
  /** Units handed over so far (sent, picked up, performed). */
  fulfilledQuantity?: number;
  properties?: OrderLineProperty[];
  propertiesPrice?: number;
  propertiesPriceMinor?: number;
  baseUnitPriceMinor?: number | null;
}

export interface OrderPickup {
  address: string | null;
  hours: string | null;
  /** When the store marked the order ready to collect; null until then. */
  readyAt: string | null;
}

/** One handed-over action as the buyer sees it: a parcel sent, a pickup, a performed service. */
export interface BuyerOrderFulfilment {
  id: string;
  kind: FulfillmentType;
  createdAt: string | null;
  lines: Array<{ orderItemId: string; quantity: number }>;
  tracking: {
    shipmentId: string;
    courierName: string | null;
    trackingId: string | null;
    trackingUrl: string | null;
    status: string;
  } | null;
}

/** Order-level delivery facts every buyer order projection carries (Wave A). */
export interface OrderFulfilmentFacts {
  /** Some line ships, so the order has a delivery address. */
  requiresShipping?: boolean;
  /** The order's one delivery method; null when nothing physical was bought. */
  shippingMethodKind?: DeliveryMethodKind | null;
  pickup?: OrderPickup | null;
}

export interface OrderItem extends OrderLineFulfilmentFacts {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  price: number;
  productName: string | null;
  productImage: string | null;
  variantLabel: string | null;
  unitPriceMinor?: number | null;
  lineSubtotalMinor?: number | null;
  discountAmountMinor?: number | null;
  taxableAmountMinor?: number | null;
  taxAmountMinor?: number;
}

export type OrderReceiptSupportRequestType =
  "cancel_pre_shipment" | "return" | "refund";

export interface OrderReceiptSupportRequest {
  id: string;
  orderId: string;
  customerId: string | null;
  type: OrderReceiptSupportRequestType;
  status: string;
  active: boolean;
  severity: "info" | "success" | "warning" | "danger";
  label: string;
  actionLabel: string;
  reason: string;
  submittedAt: string | null;
  resolvedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface OrderReceiptSupportRequestAction {
  type: OrderReceiptSupportRequestType;
  label: string;
  description: string;
  eligible: boolean;
  disabledReason: string | null;
}

export interface OrderReceiptDiscount {
  promotionId: string;
  title: string;
  code: string | null;
  /** The discount's main effect; delivery savings are in `shippingAmount` whatever the kind. */
  kind: "buy_x_get_y" | "product" | "order" | "shipping";
  amount: number;
  shippingAmount: number;
}

export interface OrderReceipt extends OrderFulfilmentFacts {
  id: string;
  /** Short per-store number ("#1001"); absent until every order has one. */
  orderNumber?: number | null;
  customerName: string;
  /** The phone the courier calls; the receipt is proof-gated to its buyer. */
  customerPhone: string;
  customerEmail: string | null;
  /** True when the order is saved to a customer account. */
  accountLinked: boolean;
  /** Null when nothing ships (pickup, service-only or digital orders). */
  shippingAddress: string | null;
  totalAmount: number;
  shippingCharge: number;
  discountAmount: number | null;
  currencyCode?: string | null;
  currencyDecimalPlaces?: number | null;
  subtotalAmountMinor?: number | null;
  shippingAmountMinor?: number | null;
  shippingMethodId?: string | null;
  shippingMethodName?: string | null;
  shippingMethodDescription?: string | null;
  shippingMethodBaseAmountMinor?: number | null;
  shippingFeeWaived?: boolean | null;
  discountAmountMinor?: number | null;
  /** Each discount used: `amount` off the items, `shippingAmount` off delivery. */
  discounts?: OrderReceiptDiscount[];
  /** The buyer's order note. */
  notes?: string | null;
  taxAmountMinor?: number;
  totalAmountMinor?: number | null;
  taxLabel?: string | null;
  pricesIncludeTax?: boolean;
  /** Null when nothing ships (pickup, service-only or digital orders). */
  city: string | null;
  zone: string | null;
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
  supportRequests: OrderReceiptSupportRequest[];
  supportRequestActions: OrderReceiptSupportRequestAction[];
  supportRequestIntro: string;
  /** Where the order is: the same tracker and dated updates as the account order page. */
  tracking?: OrderReceiptTracking | null;
  /** Each handed-over action: a parcel sent, a pickup, a performed service. */
  fulfillments?: BuyerOrderFulfilment[];
  /** The order thread, once the buyer or the store has written on it. */
  conversationId?: string | null;
}

export interface OrderReceiptTracking {
  progress: CustomerOrderProgress;
  timeline: CustomerOrderTimelineEvent[];
  shipments: Array<{
    statusLabel: string;
    courierName: string | null;
    trackingId: string | null;
    trackingUrl: string | null;
  }>;
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
  /** Delivery is free once the items subtotal (before discounts) reaches this. */
  freeOver?: number | null;
  description: string | null;
  /** Pickup rates name the place the buyer collects from. */
  kind?: "delivery" | "pickup";
  /** True for a default rate that applies outside every delivery zone. */
  everywhereElse?: boolean;
  pickupAddress?: string | null;
  pickupHours?: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AnalyticsConfig {
  id: string;
  type: string;
  usePartytown: boolean;
  config: string;
  location: string;
}

// ---------------------------------------------------------------------------
// Checkout Language Types (local domain type — SDK only has response wrappers)
// ---------------------------------------------------------------------------

import type { CheckoutLanguageData as CheckoutLanguageStrings } from "@scalius/shared/checkout-language";

export interface CheckoutLanguageData {
  id: string;
  name: string;
  code: string;
  languageData: CheckoutLanguageStrings;
  fieldVisibility: {
    showEmailField: boolean;
    showOrderNotesField: boolean;
    showAreaField: boolean;
  };
  isActive: boolean;
  isDefault: boolean;
}
