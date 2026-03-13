// src/lib/api/types.ts

/**
 * Centralized type definitions for the Scalius Commerce API.
 */

// --- Generic API Responses ---

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

// --- Product & Category Types ---

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

// --- Collection & Widget Types ---

export interface CollectionConfig {
  categoryIds?: string[]; // Array of category IDs (can be empty)
  productIds?: string[]; // Array of specific product IDs (can be empty)
  featuredProductId?: string; // Optional featured product for collection1
  maxProducts?: number; // Max products to display (default: 8, max: 24)
  title?: string; // Display title (optional)
  subtitle?: string; // Display subtitle (optional)
}

export interface Collection {
  id: string;
  name: string;
  type: "collection1" | "collection2" | "AllCategories";
  config: CollectionConfig;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CollectionWithProducts extends Collection {
  categories?: CategorySummary[]; // NEW: Array of categories (was single category)
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

// --- Page & Site Settings Types ---

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
  href?: string; // Optional - some items are menu-only without a link
  subMenu?: NavigationItem[]; // Recursive self-reference
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
  subMenu?: FooterMenuLink[]; // Recursive self-reference
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
  label: string; // e.g., "facebook", "twitter", or custom text
  url: string;
  iconUrl?: string; // Optional custom icon URL
  // Legacy fields for backwards compatibility
  platform?: string;
  icon?: string;
}

export interface HeaderData {
  topBar: {
    text: string;
    isEnabled?: boolean; // Can be disabled
  };
  logo: { src: string; alt: string };
  favicon?: { src: string; alt: string };
  contact: {
    phone: string;
    text: string;
    isEnabled?: boolean; // Can be disabled
  };
  // Social is now an array of SocialLink objects
  social: SocialLink[];
}

export interface FooterData {
  logo: { src: string; alt: string };
  favicon?: { src: string; alt: string };
  tagline: string;
  copyrightText: string;
  description?: string; // HTML description content
  menus: FooterMenu[];
  social: SocialLink[];
}

export interface SeoSettings {
  siteTitle: string | null;
  homepageTitle: string | null;
  homepageMetaDescription: string | null;
  robotsTxt: string | null;
}

// --- Order & Cart Types ---

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
  city: string; // ID
  zone: string; // ID
  area: string | null; // ID
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

// --- Other Types ---

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

// --- Checkout Language Types ---
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
