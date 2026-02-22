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
  role: text("role").default("user"),
  isSuperAdmin: integer("is_super_admin", { mode: "boolean" })
    .notNull()
    .default(false),
  banned: integer("banned", { mode: "boolean" }).default(false),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp" }),
  twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" }).default(false),
  twoFactorMethod: text("two_factor_method"),
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
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
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

export type User = InferSelectModel<typeof user>;
export type Session = InferSelectModel<typeof session>;
export type Account = InferSelectModel<typeof account>;
export type Verification = InferSelectModel<typeof verification>;
export type TwoFactor = InferSelectModel<typeof twoFactor>;

// =============================================
// RBAC (Role-Based Access Control) TABLES
// =============================================

export const permissions = sqliteTable("permissions", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  resource: text("resource").notNull(),
  action: text("action").notNull(),
  category: text("category").notNull(),
  isSensitive: integer("is_sensitive", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
});

export const roles = sqliteTable("roles", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
});

export const rolePermissions = sqliteTable(
  "role_permissions",
  {
    id: text("id").primaryKey(),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: text("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(cast(strftime('%s','now') as int))`),
  },
  (table) => [
    unique("role_permission_unique").on(table.roleId, table.permissionId),
    index("role_permissions_role_idx").on(table.roleId),
    index("role_permissions_permission_idx").on(table.permissionId),
  ]
);

export const userRoles = sqliteTable(
  "user_roles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    assignedBy: text("assigned_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(cast(strftime('%s','now') as int))`),
  },
  (table) => [
    unique("user_role_unique").on(table.userId, table.roleId),
    index("user_roles_user_idx").on(table.userId),
    index("user_roles_role_idx").on(table.roleId),
  ]
);

export const userPermissions = sqliteTable(
  "user_permissions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    permissionId: text("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
    granted: integer("granted", { mode: "boolean" }).notNull(),
    assignedBy: text("assigned_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(cast(strftime('%s','now') as int))`),
  },
  (table) => [
    unique("user_permission_unique").on(table.userId, table.permissionId),
    index("user_permissions_user_idx").on(table.userId),
    index("user_permissions_permission_idx").on(table.permissionId),
  ]
);

export type Permission = InferSelectModel<typeof permissions>;
export type Role = InferSelectModel<typeof roles>;
export type RolePermission = InferSelectModel<typeof rolePermissions>;
export type UserRole = InferSelectModel<typeof userRoles>;
export type UserPermission = InferSelectModel<typeof userPermissions>;

// =============================================
// ENUMS
// =============================================

export const OrderStatus = {
  PENDING: "pending",
  PROCESSING: "processing",
  CONFIRMED: "confirmed",
  SHIPPED: "shipped",
  DELIVERED: "delivered",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  RETURNED: "returned",
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const PaymentMethod = {
  STRIPE: "stripe",
  SSLCOMMERZ: "sslcommerz",
  COD: "cod",
} as const;

export type PaymentMethodType = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const PaymentStatus = {
  UNPAID: "unpaid",
  PARTIAL: "partial",
  PAID: "paid",
  REFUNDED: "refunded",
  FAILED: "failed",
} as const;

export type PaymentStatusType = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const FulfillmentStatus = {
  PENDING: "pending",
  PARTIAL: "partial",
  COMPLETE: "complete",
} as const;

export type FulfillmentStatusType = (typeof FulfillmentStatus)[keyof typeof FulfillmentStatus];

export const InventoryPool = {
  REGULAR: "regular",
  PREORDER: "preorder",
  BACKORDER: "backorder",
} as const;

export type InventoryPoolType = (typeof InventoryPool)[keyof typeof InventoryPool];

export const ItemFulfillmentStatus = {
  PENDING: "pending",
  PICKED: "picked",
  PACKED: "packed",
  SHIPPED: "shipped",
  DELIVERED: "delivered",
} as const;

export type ItemFulfillmentStatusType = (typeof ItemFulfillmentStatus)[keyof typeof ItemFulfillmentStatus];

export const DeliveryProvider = {
  PATHAO: "pathao",
  STEADFAST: "steadfast",
} as const;

export type DeliveryProviderType = (typeof DeliveryProvider)[keyof typeof DeliveryProvider];

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
    discountType: text("discount_type", { enum: ["percentage", "flat"] }).default("percentage"),
    discountAmount: real("discount_amount").default(0),
    freeDelivery: integer("free_delivery", { mode: "boolean" }).notNull().default(false),
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
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("product_images_product_id_idx").on(table.productId),
  index("product_images_primary_idx").on(table.productId, table.isPrimary),
]);

export const productVariants = sqliteTable("product_variants", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull(),
  size: text("size"),
  color: text("color"),
  weight: real("weight"),
  sku: text("sku").notNull(),
  price: real("price").notNull(),
  stock: integer("stock").notNull().default(0),
  // Inventory management fields
  reservedStock: integer("reserved_stock").notNull().default(0),
  preorderStock: integer("preorder_stock").notNull().default(0),
  version: integer("version").notNull().default(1), // Optimistic locking
  lowStockThreshold: integer("low_stock_threshold"), // Alert when stock <= this value
  // Pre-order / backorder settings
  allowPreorder: integer("allow_preorder", { mode: "boolean" }).notNull().default(false),
  preorderDate: text("preorder_date"), // ISO date string: when stock arrives / ships
  preorderMessage: text("preorder_message"), // Customer-facing message e.g. "Ships Feb 28"
  allowBackorder: integer("allow_backorder", { mode: "boolean" }).notNull().default(false),
  backorderLimit: integer("backorder_limit").notNull().default(0), // 0 = unlimited
  // Existing discount fields
  discountPercentage: real("discount_percentage").default(0),
  discountType: text("discount_type", { enum: ["percentage", "flat"] }).default("percentage"),
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
}, (table) => [
  index("product_variants_product_id_idx").on(table.productId),
  index("product_variants_sku_idx").on(table.sku),
]);

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
  type: text("type", { enum: ["collection1", "collection2"] }).notNull(),
  config: text("config").notNull(),
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
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
  filterable: integer("filterable", { mode: "boolean" }).notNull().default(true),
  options: text("options", { mode: "json" }).$type<string[]>(),
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
    value: text("value").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [unique().on(table.productId, table.attributeId)],
);

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
  changeType: text("change_type", { enum: ["created", "updated", "deleted"] }).notNull(),
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
  // Payment fields
  paymentMethod: text("payment_method").notNull().default(PaymentMethod.COD),
  paymentStatus: text("payment_status").notNull().default(PaymentStatus.UNPAID),
  paymentIntentId: text("payment_intent_id"), // Stripe PI ID or SSLCommerz session key
  paidAmount: real("paid_amount").notNull().default(0),
  balanceDue: real("balance_due").notNull().default(0),
  // Fulfillment fields
  fulfillmentStatus: text("fulfillment_status").notNull().default(FulfillmentStatus.PENDING),
  inventoryPool: text("inventory_pool").notNull().default(InventoryPool.REGULAR),
  expectedDelivery: text("expected_delivery"), // ISO date string for pre-orders
  // Relations
  customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
  index("orders_status_idx").on(table.status),
  index("orders_payment_status_idx").on(table.paymentStatus),
  index("orders_customer_id_idx").on(table.customerId),
  index("orders_created_at_idx").on(table.createdAt),
]);

export const orderItems = sqliteTable("order_items", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  productId: text("product_id").notNull(),
  variantId: text("variant_id"),
  quantity: integer("quantity").notNull(),
  price: real("price").notNull(),
  // Snapshot fields (captured at order time)
  productName: text("product_name"), // Snapshot of product name
  variantLabel: text("variant_label"), // e.g. "Red / XL"
  // Fulfillment tracking per item
  fulfillmentStatus: text("fulfillment_status").notNull().default(ItemFulfillmentStatus.PENDING),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
}, (table) => [
  index("order_items_order_id_idx").on(table.orderId),
  index("order_items_product_id_idx").on(table.productId),
]);

// =============================================
// PAYMENT RELATED TABLES
// =============================================

// Tracks all individual payment transactions for an order
export const orderPayments = sqliteTable("order_payments", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  amount: real("amount").notNull(),
  currency: text("currency").notNull().default("BDT"),
  paymentMethod: text("payment_method").notNull(), // stripe | sslcommerz | cod
  paymentType: text("payment_type").notNull().default("full"), // full | deposit | balance
  status: text("status").notNull().default("pending"), // pending | succeeded | failed | refunded
  // Stripe-specific fields
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  stripeChargeId: text("stripe_charge_id"),
  // SSLCommerz-specific fields
  sslcommerzTranId: text("sslcommerz_tran_id"),
  sslcommerzValId: text("sslcommerz_val_id"),
  sslcommerzBankTranId: text("sslcommerz_bank_tran_id"),
  // COD-specific fields
  codCollectedBy: text("cod_collected_by"),
  codCollectedAt: integer("cod_collected_at", { mode: "timestamp" }),
  codReceiptUrl: text("cod_receipt_url"),
  // Metadata for extra context
  metadata: text("metadata"), // JSON string
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
}, (table) => [
  index("order_payments_order_id_idx").on(table.orderId),
  index("order_payments_stripe_pi_idx").on(table.stripePaymentIntentId),
  index("order_payments_ssl_tran_idx").on(table.sslcommerzTranId),
]);

// Payment plan for deposit + balance orders
export const paymentPlans = sqliteTable("payment_plans", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" })
    .unique(),
  totalAmount: real("total_amount").notNull(),
  depositAmount: real("deposit_amount").notNull(),
  balanceDue: real("balance_due").notNull(),
  depositPaidAt: integer("deposit_paid_at", { mode: "timestamp" }),
  balancePaidAt: integer("balance_paid_at", { mode: "timestamp" }),
  balanceDueDate: text("balance_due_date"), // ISO date string
  status: text("status").notNull().default("pending"), // pending | deposit_paid | fully_paid
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
});

// COD delivery tracking
export const codTracking = sqliteTable("cod_tracking", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" })
    .unique(),
  deliveryAttempts: integer("delivery_attempts").notNull().default(0),
  lastAttemptAt: integer("last_attempt_at", { mode: "timestamp" }),
  codStatus: text("cod_status").notNull().default("pending"), // pending | collected | failed | returned
  failureReason: text("failure_reason"), // not_home | refused | no_cash | wrong_address
  collectedBy: text("collected_by"), // courier name/ID
  collectedAmount: real("collected_amount"),
  collectedAt: integer("collected_at", { mode: "timestamp" }),
  receiptUrl: text("receipt_url"), // Photo of delivery/receipt
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
});

// Idempotency store for webhook events
export const webhookEvents = sqliteTable("webhook_events", {
  id: text("id").primaryKey(), // Stripe event ID or SSLCommerz tran_id
  provider: text("provider").notNull(), // stripe | sslcommerz
  eventType: text("event_type").notNull(),
  orderId: text("order_id"),
  status: text("status").notNull().default("processed"), // processed | failed
  result: text("result"), // JSON string of processing result
  processedAt: integer("processed_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
}, (table) => [
  index("webhook_events_provider_idx").on(table.provider),
  index("webhook_events_order_id_idx").on(table.orderId),
]);

// =============================================
// INVENTORY TRACKING TABLES
// =============================================

// Audit log for all stock movements
export const inventoryMovements = sqliteTable("inventory_movements", {
  id: text("id").primaryKey(),
  variantId: text("variant_id").notNull(),
  orderId: text("order_id"), // Nullable: null for manual adjustments
  type: text("type").notNull(), // reserved | deducted | released | adjusted | preorder_reserved | preorder_deducted
  quantity: integer("quantity").notNull(), // Positive = added, negative = removed
  previousStock: integer("previous_stock").notNull(),
  newStock: integer("new_stock").notNull(),
  notes: text("notes"),
  createdBy: text("created_by"), // Admin user ID for manual adjustments
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
}, (table) => [
  index("inventory_movements_variant_idx").on(table.variantId),
  index("inventory_movements_order_idx").on(table.orderId),
  index("inventory_movements_created_at_idx").on(table.createdAt),
]);

// Low stock alerts configuration and state
export const productLowStockAlerts = sqliteTable("product_low_stock_alerts", {
  id: text("id").primaryKey(),
  variantId: text("variant_id").notNull().unique(),
  productId: text("product_id").notNull(),
  currentQty: integer("current_qty").notNull(),
  threshold: integer("threshold").notNull(),
  alertStatus: text("alert_status").notNull().default("active"), // active | acknowledged | resolved
  alertSentAt: integer("alert_sent_at", { mode: "timestamp" }),
  acknowledgedAt: integer("acknowledged_at", { mode: "timestamp" }),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
}, (table) => [
  index("pls_alerts_product_idx").on(table.productId),
  index("pls_alerts_status_idx").on(table.alertStatus),
]);

// =============================================
// DELIVERY RELATED TABLES
// =============================================

export const deliveryLocations = sqliteTable("delivery_locations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type", { enum: ["city", "zone", "area"] }).notNull(),
  parentId: text("parent_id"),
  externalIds: text("external_ids").notNull(),
  metadata: text("metadata").notNull(),
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
  type: text("type").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
  credentials: text("credentials").notNull(),
  config: text("config").notNull(),
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
  // Nullable for manual shipments that don't use an integrated provider
  providerId: text("provider_id").references(() => deliveryProviders.id),
  providerType: text("provider_type").notNull().default("manual"),
  externalId: text("external_id"),
  trackingId: text("tracking_id"), // Tracking number
  trackingUrl: text("tracking_url"),
  courierName: text("courier_name"), // For manual shipments
  status: text("status").notNull().default("pending"),
  rawStatus: text("raw_status"),
  note: text("note"),
  metadata: text("metadata"),
  lastChecked: integer("last_checked", { mode: "timestamp" }),
  // Partial fulfillment: which items are in this shipment
  shipmentItems: text("shipment_items"), // JSON array of orderItem IDs
  shipmentAmount: real("shipment_amount"), // Amount captured for this shipment (Stripe multicapture)
  isFinalShipment: integer("is_final_shipment", { mode: "boolean" }).default(false),
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
    type: text("type").notNull(),
    category: text("category").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
  },
  (table) => [unique("settings_key_category").on(table.key, table.category)],
);

export const siteSettings = sqliteTable("site_settings", {
  id: text("id").primaryKey(),
  logo: text("logo"),
  favicon: text("favicon"),
  siteName: text("site_name").notNull(),
  siteDescription: text("site_description"),
  headerConfig: text("header_config").notNull(),
  footerConfig: text("footer_config").notNull(),
  socialLinks: text("social_links"),
  contactInfo: text("contact_info"),
  siteTitle: text("site_title"),
  homepageTitle: text("homepage_title"),
  homepageMetaDescription: text("homepage_meta_description"),
  robotsTxt: text("robots_txt"),
  storefrontUrl: text("storefront_url").default("/"),
  // Auth & Guest Checkout Settings
  authVerificationMethod: text("auth_verification_method", { enum: ["email", "phone", "both"] }).notNull().default("email"),
  guestCheckoutEnabled: integer("guest_checkout_enabled", { mode: "boolean" }).notNull().default(true),
  whatsappAccessToken: text("whatsapp_access_token"),
  whatsappPhoneNumberId: text("whatsapp_phone_number_id"),
  whatsappTemplateName: text("whatsapp_template_name").default("auth_otp"),
  // Timestamps
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
    isPublished: integer("is_published", { mode: "boolean" }).notNull().default(true),
    hideHeader: integer("hide_header", { mode: "boolean" }).notNull().default(false),
    hideFooter: integer("hide_footer", { mode: "boolean" }).notNull().default(false),
    hideTitle: integer("hide_title", { mode: "boolean" }).notNull().default(false),
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
  type: text("type").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  usePartytown: integer("use_partytown", { mode: "boolean" }).notNull().default(true),
  config: text("config").notNull(),
  location: text("location").notNull(),
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
  type: text("type").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  config: text("config").notNull(),
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
  type: text("type").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  config: text("config").notNull(),
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
  images: text("images").notNull(),
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

export type DiscountValueType = (typeof DiscountValueType)[keyof typeof DiscountValueType];

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
  maxUses: integer("max_uses"),
  limitOnePerCustomer: integer("limit_one_per_customer", { mode: "boolean" }).default(false),
  combineWithProductDiscounts: integer("combine_with_product_discounts", { mode: "boolean" }).default(false),
  combineWithOrderDiscounts: integer("combine_with_order_discounts", { mode: "boolean" }).default(false),
  combineWithShippingDiscounts: integer("combine_with_shipping_discounts", { mode: "boolean" }).default(false),
  customerSegment: text("customer_segment"),
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

export const discountProducts = sqliteTable("discount_products", {
  id: text("id").primaryKey(),
  discountId: text("discount_id")
    .notNull()
    .references(() => discounts.id, { onDelete: "cascade" }),
  productId: text("product_id")
    .notNull()
    .references(() => products.id),
  applicationType: text("application_type", { enum: ["get"] }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const discountCollections = sqliteTable("discount_collections", {
  id: text("id").primaryKey(),
  discountId: text("discount_id")
    .notNull()
    .references(() => discounts.id, { onDelete: "cascade" }),
  collectionId: text("collection_id")
    .notNull()
    .references(() => collections.id),
  applicationType: text("application_type", { enum: ["get"] }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

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
  FIXED_TOP_HOMEPAGE: "fixed_top_homepage",
  FIXED_BOTTOM_HOMEPAGE: "fixed_bottom_homepage",
  STANDALONE: "standalone",
} as const;

export type WidgetPlacementRule = (typeof WidgetPlacementRule)[keyof typeof WidgetPlacementRule];

export const widgets = sqliteTable(
  "widgets",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    htmlContent: text("html_content").notNull(),
    cssContent: text("css_content"),
    aiContext: text("ai_context"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    displayTarget: text("display_target", { enum: ["homepage"] }).notNull().default("homepage"),
    placementRule: text("placement_rule", {
      enum: [
        WidgetPlacementRule.BEFORE_COLLECTION,
        WidgetPlacementRule.AFTER_COLLECTION,
        WidgetPlacementRule.FIXED_TOP_HOMEPAGE,
        WidgetPlacementRule.FIXED_BOTTOM_HOMEPAGE,
        WidgetPlacementRule.STANDALONE,
      ],
    }).notNull(),
    referenceCollectionId: text("reference_collection_id").references(
      () => collections.id,
      { onDelete: "set null" },
    ),
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
    index("widgets_target_idx").on(table.displayTarget, table.isActive, table.deletedAt),
  ],
);

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

// =============================================
// META CONVERSIONS API RELATED TABLES
// =============================================

export const metaConversionsSettings = sqliteTable("meta_conversions_settings", {
  id: text("id").primaryKey(),
  pixelId: text("pixel_id"),
  accessToken: text("access_token"),
  testEventCode: text("test_event_code"),
  isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(false),
  logRetentionDays: integer("log_retention_days").notNull().default(30),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
});

export const metaConversionsLogs = sqliteTable("meta_conversions_logs", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull().unique(),
  eventName: text("event_name").notNull(),
  status: text("status", { enum: ["success", "failed"] }).notNull(),
  requestPayload: text("request_payload").notNull(),
  responsePayload: text("response_payload"),
  errorMessage: text("error_message"),
  eventTime: integer("event_time", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
});

// =============================================
// SHIPPING METHODS
// =============================================

export const shippingMethods = sqliteTable("shipping_methods", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  fee: real("fee").notNull().default(0),
  description: text("description"),
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
// ABANDONED CHECKOUTS
// =============================================

export const abandonedCheckouts = sqliteTable(
  "abandoned_checkouts",
  {
    id: text("id").primaryKey(),
    checkoutId: text("checkout_id").notNull(),
    customerPhone: text("customer_phone"),
    checkoutData: text("checkout_data").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(cast(strftime('%s','now') as int))`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(cast(strftime('%s','now') as int))`),
  },
  (table) => [unique("ab_checkout_id_unique").on(table.checkoutId)],
);

// =============================================
// ADMIN NOTIFICATION TABLES
// =============================================

export const adminFcmTokens = sqliteTable("admin_fcm_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  token: text("token").notNull().unique(),
  deviceInfo: text("device_info"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  lastUsed: integer("last_used", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
});

// =============================================
// CHECKOUT LANGUAGE SETTINGS
// =============================================

export const checkoutLanguages = sqliteTable("checkout_languages", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  code: text("code").notNull().unique(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  languageData: text("language_data").notNull(),
  fieldVisibility: text("field_visibility").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(cast(strftime('%s','now') as int))`),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
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
export type ProductAttributeValue = InferSelectModel<typeof productAttributeValues>;
export type ProductRichContent = InferSelectModel<typeof productRichContent>;

// Customer related types
export type Customer = InferSelectModel<typeof customers>;
export type CustomerHistory = InferSelectModel<typeof customerHistory>;

// Order related types
export type Order = InferSelectModel<typeof orders>;
export type OrderItem = InferSelectModel<typeof orderItems>;
export type OrderPayment = InferSelectModel<typeof orderPayments>;
export type PaymentPlan = InferSelectModel<typeof paymentPlans>;
export type CodTracking = InferSelectModel<typeof codTracking>;
export type WebhookEvent = InferSelectModel<typeof webhookEvents>;

// Inventory related types
export type InventoryMovement = InferSelectModel<typeof inventoryMovements>;
export type ProductLowStockAlert = InferSelectModel<typeof productLowStockAlerts>;

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
export type WidgetHistory = InferSelectModel<typeof widgetHistory>;

// Misc types
export type AbandonedCheckout = InferSelectModel<typeof abandonedCheckouts>;
export type AdminFcmToken = InferSelectModel<typeof adminFcmTokens>;
export type ShippingMethod = InferSelectModel<typeof shippingMethods>;
export type CheckoutLanguage = InferSelectModel<typeof checkoutLanguages>;
export type MetaConversionsSettings = InferSelectModel<typeof metaConversionsSettings>;
export type MetaConversionsLog = InferSelectModel<typeof metaConversionsLogs>;
