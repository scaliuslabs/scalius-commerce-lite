//src/db/schema.ts
import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  unique,
  index,
} from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";

// =============================================
// BETTER AUTH TABLES
// =============================================

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .notNull()
    .default(false),
  image: text("image"),
  role: text("role").default("user"), // 'user' | 'admin'
  banned: integer("banned", { mode: "boolean" }).default(false),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp" }),
  twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" }).default(
    false
  ),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  impersonatedBy: text("impersonated_by"),
  // Two-factor authentication verification status
  twoFactorVerified: integer("two_factor_verified", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", {
    mode: "timestamp",
  }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", {
    mode: "timestamp",
  }),
  scope: text("scope"),
  password: text("password"),
  idToken: text("id_token"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
});

export const twoFactor = sqliteTable("two_factor", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
});

// Better Auth type exports
export type User = InferSelectModel<typeof user>;
export type Session = InferSelectModel<typeof session>;
export type Account = InferSelectModel<typeof account>;
export type Verification = InferSelectModel<typeof verification>;
export type TwoFactor = InferSelectModel<typeof twoFactor>;

// =============================================
// ENUMS
// =============================================

// Order status enum
export const OrderStatus = {
  PENDING: "pending",
  PROCESSING: "processing",
  CONFIRMED: "confirmed",
  SHIPPED: "shipped",
  DELIVERED: "delivered",
  CANCELLED: "cancelled",
  RETURNED: "returned",
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

// Delivery provider enum
export const DeliveryProvider = {
  PATHAO: "pathao",
  STEADFAST: "steadfast",
  // Future providers can be added here
} as const;

export type DeliveryProviderType =
  (typeof DeliveryProvider)[keyof typeof DeliveryProvider];

// =============================================
// PRODUCT RELATED TABLES
// =============================================

export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    price: real("price").notNull(),
    categoryId: text("category_id").notNull(),
    slug: text("slug").notNull(),
    metaTitle: text("meta_title"),
    metaDescription: text("meta_description"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    discountPercentage: real("discount_percentage").default(0),
    discountType: text("discount_type", {
      enum: ["percentage", "flat"],
    }).default("percentage"),
    discountAmount: real("discount_amount").default(0),
    freeDelivery: integer("free_delivery", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [
    index("products_slug_idx").on(table.slug),
    index("products_category_id_idx").on(table.categoryId),
    index("products_active_idx").on(table.isActive, table.deletedAt),
  ],
);

export const productImages = sqliteTable("product_images", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull(),
  url: text("url").notNull(),
  alt: text("alt"),
  isPrimary: integer("is_primary", { mode: "boolean" })
    .notNull()
    .default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const productVariants = sqliteTable("product_variants", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull(),
  size: text("size"),
  color: text("color"),
  weight: real("weight"),
  sku: text("sku").notNull(),
  price: real("price").notNull(),
  stock: integer("stock").notNull().default(0),
  discountPercentage: real("discount_percentage").default(0),
  discountType: text("discount_type", { enum: ["percentage", "flat"] }).default(
    "percentage",
  ),
  discountAmount: real("discount_amount").default(0),
  colorSortOrder: integer("color_sort_order").default(0),
  sizeSortOrder: integer("size_sort_order").default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    imageUrl: text("image_url"),
    metaTitle: text("meta_title"),
    metaDescription: text("meta_description"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => [index("categories_slug_idx").on(table.slug)],
);

export const collections = sqliteTable("collections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type", {
    enum: ["collection1", "collection2"],
  }).notNull(), // UI rendering style only (grid-with-featured vs horizontal-scroll)
  config: text("config").notNull(), // JSON: { categoryIds: string[], productIds: string[], featuredProductId?: string, maxProducts: number, title?: string, subtitle?: string }
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

// =============================================
// PRODUCT ATTRIBUTES RELATED TABLES
// =============================================

export const productAttributes = sqliteTable("product_attributes", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(), // e.g., "Brand", "Warranty", "Color"
  slug: text("slug").notNull().unique(), // e.g., "brand", "warranty", "color"
  filterable: integer("filterable", { mode: "boolean" })
    .notNull()
    .default(true), // Can be used in frontend filters
  options: text("options", { mode: "json" }).$type<string[]>(), // JSON array of predefined values e.g. ["S", "M", "L"]
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

export const productAttributeValues = sqliteTable(
  "product_attribute_values",
  {
    id: text("id").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    attributeId: text("attribute_id")
      .notNull()
      .references(() => productAttributes.id, { onDelete: "cascade" }),
    value: text("value").notNull(), // e.g., "Apple", "2 Years", "15-inch"
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [unique().on(table.productId, table.attributeId)],
);

// Add productRichContent table
export const productRichContent = sqliteTable("product_rich_content", {
  id: text("id").primaryKey(),
  productId: text("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: text("content").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// =============================================
// CUSTOMER RELATED TABLES
// =============================================

export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone").notNull().unique("customer_phone_unique"),
  address: text("address"),
  city: text("city"),
  zone: text("zone"),
  area: text("area"),
  cityName: text("city_name"),
  zoneName: text("zone_name"),
  areaName: text("area_name"),
  totalOrders: integer("total_orders").notNull().default(0),
  totalSpent: real("total_spent").notNull().default(0),
  lastOrderAt: integer("last_order_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

export const customerHistory = sqliteTable("customer_history", {
  id: text("id").primaryKey(),
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone").notNull(),
  address: text("address"),
  city: text("city"),
  zone: text("zone"),
  area: text("area"),
  cityName: text("city_name"),
  zoneName: text("zone_name"),
  areaName: text("area_name"),
  changeType: text("change_type", {
    enum: ["created", "updated", "deleted"],
  }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// =============================================
// ORDER RELATED TABLES
// =============================================

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  customerName: text("customer_name").notNull(),
  customerPhone: text("customer_phone").notNull(),
  customerEmail: text("customer_email"),
  shippingAddress: text("shipping_address").notNull(),
  city: text("city").notNull(),
  zone: text("zone").notNull(),
  area: text("area"),
  cityName: text("city_name"),
  zoneName: text("zone_name"),
  areaName: text("area_name"),
  totalAmount: real("total_amount").notNull(),
  shippingCharge: real("shipping_charge").notNull(),
  discountAmount: real("discount_amount").default(0),
  status: text("status").notNull().default(OrderStatus.PENDING),
  notes: text("notes"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
  customerId: text("customer_id").references(() => customers.id, {
    onDelete: "set null",
  }),
});

export const orderItems = sqliteTable("order_items", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  productId: text("product_id").notNull(),
  variantId: text("variant_id"),
  quantity: integer("quantity").notNull(),
  price: real("price").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
});

// =============================================
// DELIVERY RELATED TABLES
// =============================================

export const deliveryLocations = sqliteTable("delivery_locations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type", { enum: ["city", "zone", "area"] }).notNull(),
  parentId: text("parent_id"), // References parent location (e.g., zone's city or area's zone)
  externalIds: text("external_ids").notNull(), // JSON string mapping provider IDs: { "pathao": "123", "other_provider": "456" }
  metadata: text("metadata").notNull(), // JSON string for additional data like availability, coordinates, etc.
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

export const deliveryProviders = sqliteTable("delivery_providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(), // pathao, steadfast, etc.
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
  credentials: text("credentials").notNull(), // JSON string of provider-specific credentials
  config: text("config").notNull(), // JSON string of additional configuration
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const deliveryShipments = sqliteTable("delivery_shipments", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  providerId: text("provider_id")
    .notNull()
    .references(() => deliveryProviders.id),
  providerType: text("provider_type").notNull(), // pathao, steadfast, etc.
  externalId: text("external_id"), // consignment_id from provider
  trackingId: text("tracking_id"), // Tracking ID (may be same as externalId)
  status: text("status").notNull(), // Mapped status in our system (pending, in_transit, etc.)
  rawStatus: text("raw_status"), // Raw status from the provider
  metadata: text("metadata"), // JSON string containing response data, options, etc.
  lastChecked: integer("last_checked", { mode: "timestamp" }), // When the status was last checked
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// =============================================
// SITE CONTENT & SETTINGS TABLES
// =============================================

export const settings = sqliteTable(
  "settings",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    type: text("type").notNull(), // 'string' | 'number' | 'boolean' | 'json'
    category: text("category").notNull(), // 'general' | 'pathao' | 'shipping' etc
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    expiresAt: integer("expires_at", { mode: "timestamp" }), // For cache expiration
  },
  (table) => [unique("settings_key_category").on(table.key, table.category)],
);

export const siteSettings = sqliteTable("site_settings", {
  id: text("id").primaryKey(),
  logo: text("logo"),
  favicon: text("favicon"),
  siteName: text("site_name").notNull(),
  siteDescription: text("site_description"),
  headerConfig: text("header_config").notNull(), // JSON string for header builder
  footerConfig: text("footer_config").notNull(), // JSON string for footer builder: { logo, tagline, menus: [{id, title, links}], socialLinks: [{id, platform, icon, url}] }
  socialLinks: text("social_links"), // JSON string for social media links
  contactInfo: text("contact_info"), // JSON string for contact information
  siteTitle: text("site_title"), // New: For SEO - overall site title
  homepageTitle: text("homepage_title"), // New: For SEO - specific title for the homepage
  homepageMetaDescription: text("homepage_meta_description"), // New: For SEO - specific meta description for the homepage
  robotsTxt: text("robots_txt"), // New: For robots.txt content
  storefrontUrl: text("storefront_url").default("/"), // New: For configurable storefront URL
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const pages = sqliteTable(
  "pages",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    content: text("content").notNull(),
    metaTitle: text("meta_title"),
    metaDescription: text("meta_description"),
    isPublished: integer("is_published", { mode: "boolean" })
      .notNull()
      .default(true),
    // Add new fields for layout control
    hideHeader: integer("hide_header", { mode: "boolean" })
      .notNull()
      .default(false),
    hideFooter: integer("hide_footer", { mode: "boolean" })
      .notNull()
      .default(false),
    hideTitle: integer("hide_title", { mode: "boolean" })
      .notNull()
      .default(false),
    publishedAt: integer("published_at", { mode: "timestamp" }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => [index("pages_slug_idx").on(table.slug)],
);

export const analytics = sqliteTable("analytics", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(), // 'google_analytics', 'facebook_pixel', 'custom'
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  usePartytown: integer("use_partytown", { mode: "boolean" })
    .notNull()
    .default(true),
  config: text("config").notNull(), // JSON string for analytics configuration
  location: text("location").notNull(), // 'head', 'body_start', 'body_end'
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// =============================================
// UI COMPONENTS & TEMPLATES
// =============================================

export const pageTemplates = sqliteTable("page_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(), // 'home', 'product', 'collection', 'custom'
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  config: text("config").notNull(), // JSON string for template configuration
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const heroSections = sqliteTable("hero_sections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(), // 'slider', 'single', 'grid'
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  config: text("config").notNull(), // JSON string for hero configuration
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const heroSliders = sqliteTable("hero_sliders", {
  id: text("id").primaryKey(),
  type: text("type", { enum: ["desktop", "mobile"] }).notNull(),
  images: text("images").notNull(), // Will store JSON array of {url, link, title}
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

// =============================================
// MEDIA
// =============================================

export const mediaFolders = sqliteTable("media_folders", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  parentId: text("parent_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

export const media = sqliteTable("media", {
  id: text("id").primaryKey(),
  filename: text("filename").notNull(),
  url: text("url").notNull(),
  size: integer("size").notNull(),
  mimeType: text("mime_type").notNull(),
  folderId: text("folder_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

// =============================================
// DISCOUNT & PROMOTION RELATED TABLES
// =============================================

export const DiscountType = {
  AMOUNT_OFF_PRODUCTS: "amount_off_products",
  AMOUNT_OFF_ORDER: "amount_off_order",
  FREE_SHIPPING: "free_shipping",
} as const;

export type DiscountType = (typeof DiscountType)[keyof typeof DiscountType];

export const DiscountValueType = {
  PERCENTAGE: "percentage",
  FIXED_AMOUNT: "fixed_amount",
  FREE: "free",
} as const;

export type DiscountValueType =
  (typeof DiscountValueType)[keyof typeof DiscountValueType];

export const discounts = sqliteTable("discounts", {
  id: text("id").primaryKey(),
  code: text("code").notNull(),
  type: text("type", {
    enum: [
      DiscountType.AMOUNT_OFF_PRODUCTS,
      DiscountType.AMOUNT_OFF_ORDER,
      DiscountType.FREE_SHIPPING,
    ],
  }).notNull(),
  valueType: text("value_type", {
    enum: [
      DiscountValueType.PERCENTAGE,
      DiscountValueType.FIXED_AMOUNT,
      DiscountValueType.FREE,
    ],
  }).notNull(),
  discountValue: real("discount_value").notNull(),
  minPurchaseAmount: real("min_purchase_amount"),
  minQuantity: integer("min_quantity"),
  maxUsesPerOrder: integer("max_uses_per_order"),
  // Usage limitations
  maxUses: integer("max_uses"),
  limitOnePerCustomer: integer("limit_one_per_customer", {
    mode: "boolean",
  }).default(false),
  // Combinability with other discounts
  combineWithProductDiscounts: integer("combine_with_product_discounts", {
    mode: "boolean",
  }).default(false),
  combineWithOrderDiscounts: integer("combine_with_order_discounts", {
    mode: "boolean",
  }).default(false),
  combineWithShippingDiscounts: integer("combine_with_shipping_discounts", {
    mode: "boolean",
  }).default(false),
  // Eligibility - if null/empty, applies to all customers
  customerSegment: text("customer_segment"), // can store JSON with customer group IDs
  // Dates
  startDate: integer("start_date", { mode: "timestamp" }).notNull(),
  endDate: integer("end_date", { mode: "timestamp" }),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

// Table for mapping specific products to discounts
export const discountProducts = sqliteTable("discount_products", {
  id: text("id").primaryKey(),
  discountId: text("discount_id")
    .notNull()
    .references(() => discounts.id, { onDelete: "cascade" }),
  productId: text("product_id")
    .notNull()
    .references(() => products.id),
  // For discount application, we use "get" as the standard type
  applicationType: text("application_type", { enum: ["get"] }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// Table for mapping specific collections to discounts
export const discountCollections = sqliteTable("discount_collections", {
  id: text("id").primaryKey(),
  discountId: text("discount_id")
    .notNull()
    .references(() => discounts.id, { onDelete: "cascade" }),
  collectionId: text("collection_id")
    .notNull()
    .references(() => collections.id),
  // For discount application, we use "get" as the standard type
  applicationType: text("application_type", { enum: ["get"] }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// Table for tracking discount usage by customers
export const discountUsage = sqliteTable("discount_usage", {
  id: text("id").primaryKey(),
  discountId: text("discount_id")
    .notNull()
    .references(() => discounts.id, { onDelete: "cascade" }),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  customerId: text("customer_id").references(() => customers.id),
  amountDiscounted: real("amount_discounted").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// =============================================
// WIDGET RELATED TABLES
// =============================================

export const WidgetPlacementRule = {
  BEFORE_COLLECTION: "before_collection",
  AFTER_COLLECTION: "after_collection",
  FIXED_TOP_HOMEPAGE: "fixed_top_homepage", // Specific fixed position
  FIXED_BOTTOM_HOMEPAGE: "fixed_bottom_homepage", // Specific fixed position
  STANDALONE: "standalone", // For use with shortcodes only
} as const;

export type WidgetPlacementRule =
  (typeof WidgetPlacementRule)[keyof typeof WidgetPlacementRule];

export const widgets = sqliteTable(
  "widgets",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(), // For admin identification
    htmlContent: text("html_content").notNull(),
    cssContent: text("css_content"), // Optional CSS
    aiContext: text("ai_context"), // JSON string for AI context
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    // 'homepage' is the only target for now, but this allows future expansion
    displayTarget: text("display_target", { enum: ["homepage"] })
      .notNull()
      .default("homepage"),
    placementRule: text("placement_rule", {
      enum: [
        WidgetPlacementRule.BEFORE_COLLECTION,
        WidgetPlacementRule.AFTER_COLLECTION,
        WidgetPlacementRule.FIXED_TOP_HOMEPAGE,
        WidgetPlacementRule.FIXED_BOTTOM_HOMEPAGE,
        WidgetPlacementRule.STANDALONE,
      ],
    }).notNull(),
    // Only relevant if placementRule is BEFORE_COLLECTION or AFTER_COLLECTION
    referenceCollectionId: text("reference_collection_id").references(
      () => collections.id,
      { onDelete: "set null" }, // If a collection is deleted, we might want to handle widgets pointing to it
    ),
    // General sort order. For collections, this orders widgets relative to the same collection.
    // For fixed positions, this orders widgets within that fixed block.
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(cast(strftime('%s','now') as int))`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(cast(strftime('%s','now') as int))`),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => [
    index("widgets_target_idx").on(
      table.displayTarget,
      table.isActive,
      table.deletedAt,
    ),
  ],
);

// =============================================
// META CONVERSIONS API RELATED TABLES
// =============================================

export const metaConversionsSettings = sqliteTable(
  "meta_conversions_settings",
  {
    id: text("id").primaryKey(), // Using a single row with a fixed ID e.g., 'singleton'
    pixelId: text("pixel_id"),
    // IMPORTANT: This token is highly sensitive and should be encrypted before being stored.
    accessToken: text("access_token"),
    testEventCode: text("test_event_code"), // For testing events in Meta's Events Manager
    isEnabled: integer("is_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    logRetentionDays: integer("log_retention_days").notNull().default(30), // Days to keep logs before auto-clearing
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(cast(strftime('%s','now') as int))`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(cast(strftime('%s','now') as int))`),
  },
);

export const metaConversionsLogs = sqliteTable("meta_conversions_logs", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull().unique(), // Unique ID for deduplication
  eventName: text("event_name").notNull(), // e.g., 'Purchase', 'AddToCart'
  status: text("status", { enum: ["success", "failed"] }).notNull(),
  requestPayload: text("request_payload").notNull(), // JSON string of the sent data
  responsePayload: text("response_payload"), // JSON string of the response from Meta
  errorMessage: text("error_message"), // Stores the error if the request failed
  eventTime: integer("event_time", { mode: "timestamp" }).notNull(), // The timestamp of when the event occurred
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
});

// =============================================
// TYPE EXPORTS
// =============================================

// Product related types
export type Product = InferSelectModel<typeof products>;
export type ProductImage = InferSelectModel<typeof productImages>;
export type ProductVariant = InferSelectModel<typeof productVariants>;
export type Category = InferSelectModel<typeof categories>;
export type Collection = InferSelectModel<typeof collections>;
export type ProductAttribute = InferSelectModel<typeof productAttributes>;
export type ProductAttributeValue = InferSelectModel<
  typeof productAttributeValues
>;
export type ProductRichContent = InferSelectModel<typeof productRichContent>;

// Customer related types
export type Customer = InferSelectModel<typeof customers>;
export type CustomerHistory = InferSelectModel<typeof customerHistory>;

// Order related types
export type Order = InferSelectModel<typeof orders>;
export type OrderItem = InferSelectModel<typeof orderItems>;

// Abandoned Checkouts
export const abandonedCheckouts = sqliteTable(
  "abandoned_checkouts",
  {
    id: text("id").primaryKey(),
    checkoutId: text("checkout_id").notNull(), // Unique ID for the checkout session from the client
    customerPhone: text("customer_phone"),
    checkoutData: text("checkout_data").notNull(), // JSON string of cart items and customer info
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(cast(strftime('%s','now') as int))`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(cast(strftime('%s','now') as int))`),
  },
  (table) => [unique("ab_checkout_id_unique").on(table.checkoutId)],
);

export type AbandonedCheckout = InferSelectModel<typeof abandonedCheckouts>;

// Delivery related types
export type DeliveryLocation = InferSelectModel<typeof deliveryLocations>;
export type DeliveryProvider = InferSelectModel<typeof deliveryProviders>;
export type DeliveryShipment = InferSelectModel<typeof deliveryShipments>;

// Site content and settings types
export type Setting = InferSelectModel<typeof settings>;
export type SiteSettings = InferSelectModel<typeof siteSettings>;
export type Page = InferSelectModel<typeof pages>;
export type Analytics = InferSelectModel<typeof analytics>;

// UI components and templates types
export type PageTemplate = InferSelectModel<typeof pageTemplates>;
export type HeroSection = InferSelectModel<typeof heroSections>;
export type HeroSlider = InferSelectModel<typeof heroSliders>;

// Media type
export type Media = InferSelectModel<typeof media>;

// Discount related types
export type Discount = InferSelectModel<typeof discounts>;
export type DiscountProduct = InferSelectModel<typeof discountProducts>;
export type DiscountCollection = InferSelectModel<typeof discountCollections>;
export type DiscountUsage = InferSelectModel<typeof discountUsage>;

// Widget type
export type Widget = InferSelectModel<typeof widgets>;

export const widgetHistory = sqliteTable("widget_history", {
  id: text("id").primaryKey(),
  widgetId: text("widget_id")
    .notNull()
    .references(() => widgets.id, { onDelete: "cascade" }),
  htmlContent: text("html_content").notNull(),
  cssContent: text("css_content"),
  reason: text("reason").notNull().default("updated"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
});

export type WidgetHistory = InferSelectModel<typeof widgetHistory>;

// =============================================
// SHIPPING METHODS RELATED TABLES
// =============================================

export const shippingMethods = sqliteTable("shipping_methods", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(), // e.g., "Inside Dhaka", "Outside Dhaka", "Express"
  fee: real("fee").notNull().default(0),
  description: text("description"), // Optional description
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

// =============================================
// ADMIN NOTIFICATION RELATED TABLES
// =============================================

export const adminFcmTokens = sqliteTable("admin_fcm_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(), // Better Auth User ID for the admin
  token: text("token").notNull().unique(), // Keep token unique to prevent duplicates
  deviceInfo: text("device_info"), // Optional: store device/browser info for identification
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true), // Allow soft deletion of tokens
  lastUsed: integer("last_used", { mode: "timestamp" }), // Track when token was last used
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
});

export type AdminFcmToken = InferSelectModel<typeof adminFcmTokens>;

// Type for ShippingMethods
export type ShippingMethod = InferSelectModel<typeof shippingMethods>;

// =============================================
// CHECKOUT LANGUAGE SETTINGS RELATED TABLES
// =============================================

export const checkoutLanguages = sqliteTable("checkout_languages", {
  id: text("id").primaryKey(),
  name: text("name").notNull(), // e.g., "English", "বাংলা", "العربية"
  code: text("code").notNull().unique(), // e.g., "en", "bn", "ar"
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(false), // Only one can be active
  isDefault: integer("is_default", { mode: "boolean" })
    .notNull()
    .default(false), // Fallback language

  // All language data stored as JSON
  languageData: text("language_data").notNull(), // JSON string containing all labels, placeholders, messages, etc.

  // Field visibility settings
  fieldVisibility: text("field_visibility").notNull(), // JSON string for field visibility settings

  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

// Type for CheckoutLanguage
export type CheckoutLanguage = InferSelectModel<typeof checkoutLanguages>;

// Meta Conversions API related types
export type MetaConversionsSettings = InferSelectModel<
  typeof metaConversionsSettings
>;
export type MetaConversionsLog = InferSelectModel<typeof metaConversionsLogs>;
