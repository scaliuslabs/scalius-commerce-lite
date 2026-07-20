// apps/api/src/schemas/entities.ts
// Zod schemas for domain entities used in API responses.
// Derived from the actual shapes returned by core service functions.
//
// Entity schemas define strict shapes for OpenAPI documentation and SDK type generation.

import { z } from "@hono/zod-openapi";
import { PRODUCT_CONDITION_VALUES } from "@scalius/shared/product-condition";
import { categoryStatusSchema } from "@scalius/shared/category-publication";
import {
  nullableTimestampSchema,
  optionalNullableTimestampSchema,
  optionalTimestampSchema,
  timestampSchema,
} from "./timestamps";

// ─────────────────────────────────────────
// Products
// ─────────────────────────────────────────

/** Product summary — returned by listProducts (admin). */
export const productSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    price: z.number(),
    description: z.string().nullable(),
    isActive: z.boolean(),
    discountPercentage: z.number(),
    discountType: z.string(),
    discountAmount: z.number(),
    freeDelivery: z.boolean(),
    aggregateRevision: z.number().int().min(1),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    category: z.object({ name: z.string() }),
    variantCount: z.number(),
    mediaCount: z.number(),
    primaryImage: z.string().nullable(),
    sku: z.string().optional(),
  })

/** Ordered image/video association returned by product detail. */
export const productMediaSchema = z
  .object({
    id: z.string(),
    mediaId: z.string(),
    kind: z.enum(["image", "video"]),
    url: z.string(),
    posterMediaId: z.string().nullable(),
    posterUrl: z.string().nullable(),
    altText: z.string(),
    contextualAltText: z.string().nullable().optional(),
    caption: z.string().nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    isPrimary: z.boolean(),
    sortOrder: z.number().int().nonnegative(),
    status: z.enum(["ready", "trashed"]),
  })

/** Product variant — returned by variant CRUD endpoints. */
export const selectedProductOptionSchema = z.object({
  optionDefinitionId: z.string(),
  optionValueId: z.string(),
  name: z.string(),
  value: z.string(),
  position: z.number().int(),
  valuePosition: z.number().int(),
  standardMapping: z.enum(["size", "color", "material", "pattern", "none"]),
});

export const productOptionDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number().int(),
  standardMapping: z.enum(["size", "color", "material", "pattern", "none"]),
  values: z.array(z.object({
    id: z.string(),
    value: z.string(),
    position: z.number().int(),
  })),
});

export const productVariantSchema = z
  .object({
    id: z.string(),
    productId: z.string(),
    optionCombinationKey: z.string().nullable(),
    imageId: z.string().nullable(),
    selectedOptions: z.array(selectedProductOptionSchema).optional(),
    weight: z.number().nullable(),
    sku: z.string(),
    price: z.number(),
    stock: z.number(),
    reservedStock: z.number(),
    preorderStock: z.number().optional(),
    isDefault: z.boolean().optional(),
    trackInventory: z.boolean().optional(),
    lowStockThreshold: z.number().nullable().optional(),
    allowPreorder: z.boolean().optional(),
    preorderDate: optionalNullableTimestampSchema,
    preorderMessage: z.string().nullable().optional(),
    allowBackorder: z.boolean().optional(),
    backorderLimit: z.number().optional(),
    discountPercentage: z.number().nullable().optional(),
    discountType: z.string().nullable().optional(),
    discountAmount: z.number().nullable().optional(),
    barcode: z.string().nullable().optional(),
    barcodeType: z.string().nullable().optional(),
    createdAt: optionalTimestampSchema,
    updatedAt: optionalTimestampSchema,
    deletedAt: optionalNullableTimestampSchema,
    stockVersion: z.number().optional(),
    version: z.number().optional(),
  });

/** Product variant returned by aggregate-mutating variant endpoints. */
export const productVariantMutationSchema = productVariantSchema.extend({
  aggregateRevision: z.number().int().min(1),
});

/** Rich content block for product detail. */
export const productRichContentSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    content: z.string(),
    sortOrder: z.number(),
  })

/** Product attribute value. */
export const productAttributeValueSchema = z
  .object({
    attributeId: z.string(),
    value: z.string(),
  })

/** Product detail — returned by getProductDetails (admin). */
export const productDetailSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    price: z.number(),
    categoryId: z.string().nullable(),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    canonicalPath: z.string().nullable(),
    isActive: z.boolean(),
    noIndex: z.boolean(),
    excludeFromSitemap: z.boolean(),
    excludeFromProductFeed: z.boolean(),
    productCondition: z.enum(PRODUCT_CONDITION_VALUES).nullable(),
    options: z.array(productOptionDefinitionSchema),
    aggregateRevision: z.number().int().min(1),
    discountPercentage: z.number().nullable(),
    discountType: z.enum(["percentage", "flat"]).nullable(),
    discountAmount: z.number().nullable(),
    freeDelivery: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: nullableTimestampSchema,
    category: z.object({ name: z.string().nullable() }).nullable(),
    variants: z.array(productVariantSchema),
    media: z.array(productMediaSchema),
    additionalInfo: z.array(productRichContentSchema),
    attributes: z.array(productAttributeValueSchema),
  })

/** Product stats — returned by getProductStats (admin). */
export const productStatsSchema = z
  .object({
    totalProducts: z.number(),
    activeProducts: z.number(),
    productsWithImages: z.number(),
    categoriesCount: z.number(),
  })

// ─────────────────────────────────────────
// Orders
// ─────────────────────────────────────────

/** Shipment summary attached to order list items. */
export const orderShipmentSummarySchema = z
  .object({
    id: z.string(),
    providerId: z.string().nullable(),
    providerType: z.string().nullable(),
    providerName: z.string().nullable(),
    status: z.string(),
    rawStatus: z.string().nullable(),
    externalId: z.string().nullable(),
    trackingId: z.string().nullable(),
    lastChecked: nullableTimestampSchema,
    updatedAt: timestampSchema,
    createdAt: timestampSchema,
  })

export const orderPaymentRecoverySchema = z
  .object({
    state: z.enum(["none", "awaiting_payment", "processing", "needs_attention"]),
    label: z.string(),
    message: z.string().nullable(),
    gateway: z.string().nullable(),
    paymentType: z.string().nullable(),
    status: z.string().nullable(),
    attempts: z.number(),
    activeProcessing: z.boolean(),
    staleProcessing: z.boolean(),
    updatedAt: nullableTimestampSchema,
  })

export const orderShipmentRecoverySchema = z
  .object({
    state: z.enum(["none", "creating", "needs_attention", "failed"]),
    severity: z.enum(["info", "warning", "danger"]),
    activeLock: z.boolean(),
    label: z.string(),
    message: z.string().nullable(),
    shipmentId: z.string().nullable(),
    status: z.string().nullable(),
    providerType: z.string().nullable(),
    canRefresh: z.boolean(),
    canRetryCreate: z.boolean(),
    updatedAt: nullableTimestampSchema,
  })

export const orderListActiveRefundOperationSchema = z.object({
  active: z.literal(true),
  status: z.string(),
  severity: z.enum(["info", "success", "warning", "danger"]),
  label: z.string(),
  message: z.string(),
  amount: z.number(),
  currency: z.string(),
  gateway: z.string(),
  attemptCount: z.number(),
  nextProbeAt: nullableTimestampSchema,
  lastProbeAt: nullableTimestampSchema,
  providerStatus: z.string().nullable(),
});

export const orderFullEditReadinessSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().nullable(),
});

/** Order summary — returned by listOrders (admin). */
export const orderSummarySchema = z
  .object({
    id: z.string(),
    customerName: z.string(),
    customerPhone: z.string(),
    customerEmail: z.string().nullable(),
    customerId: z.string().nullable(),
    totalAmount: z.number(),
    shippingCharge: z.number(),
    discountAmount: z.number(),
    status: z.string(),
    paymentStatus: z.string().nullable(),
    paymentMethod: z.string().nullable(),
    fulfillmentStatus: z.string().nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    version: z.number().int().min(1),
    city: z.string().nullable(),
    zone: z.string().nullable(),
    area: z.string().nullable(),
    cityName: z.string().nullable(),
    zoneName: z.string().nullable(),
    areaName: z.string().nullable(),
    itemCount: z.number(),
    totalQuantity: z.number(),
    latestShipment: orderShipmentSummarySchema.nullable(),
    shipmentRecovery: orderShipmentRecoverySchema,
    paymentRecovery: orderPaymentRecoverySchema,
    activeRefundOperation: orderListActiveRefundOperationSchema.nullable(),
    fullEditReadiness: orderFullEditReadinessSchema,
  })

/** Order item — returned inside order detail. */
export const orderItemSchema = z
  .object({
    id: z.string(),
    productId: z.string(),
    variantId: z.string().nullable(),
    quantity: z.number(),
    price: z.number(),
    productName: z.string().nullable(),
    productImage: z.string().nullable(),
    variantLabel: z.string().nullable(),
    fulfillmentStatus: z.string(),
    unitPriceMinor: z.number().int().nullable(),
    lineSubtotalMinor: z.number().int().nullable(),
    discountAmountMinor: z.number().int().nullable(),
    taxableAmountMinor: z.number().int().nullable(),
    taxAmountMinor: z.number().int(),
  })

export const orderRefundAttemptSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  amount: z.number(),
  currency: z.string(),
  gateway: z.string(),
  status: z.string(),
  providerStatus: z.string().nullable(),
  active: z.boolean(),
  severity: z.enum(["info", "success", "warning", "danger"]),
  label: z.string(),
  message: z.string(),
  createdAt: nullableTimestampSchema,
  updatedAt: nullableTimestampSchema,
  nextProbeAt: nullableTimestampSchema,
  lastProbeAt: nullableTimestampSchema,
  refundedAt: nullableTimestampSchema,
  failedAt: nullableTimestampSchema,
  reason: z.string().optional(),
  refundPaymentId: z.string().optional(),
  sourcePaymentId: z.string().optional(),
  sourceTransactionId: z.string().nullable().optional(),
  refundReference: z.string().optional(),
  providerRefundId: z.string().nullable().optional(),
  providerCorrelationId: z.string().nullable().optional(),
  allocationIndex: z.number().optional(),
  allocationCount: z.number().optional(),
  attempts: z.number().optional(),
  lastError: z.string().nullable().optional(),
});

export const activeRefundOperationSchema = z.object({
  active: z.literal(true),
  status: z.string(),
  severity: z.enum(["info", "success", "warning", "danger"]),
  label: z.string(),
  message: z.string(),
  amount: z.number(),
  currency: z.string(),
  gateway: z.string(),
  attemptCount: z.number(),
  nextProbeAt: nullableTimestampSchema,
  lastProbeAt: nullableTimestampSchema,
  providerStatus: z.string().nullable(),
  reason: z.string().nullable().optional(),
  sourceTransactionId: z.string().nullable().optional(),
  providerRefundId: z.string().nullable().optional(),
  providerCorrelationId: z.string().nullable().optional(),
  refundReference: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
});

export const orderSupportRequestSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  customerId: z.string().nullable(),
  type: z.enum(["cancel_pre_shipment", "return", "refund"]),
  status: z.string(),
  active: z.boolean(),
  severity: z.enum(["info", "success", "warning", "danger"]),
  label: z.string(),
  actionLabel: z.string(),
  reason: z.string(),
  message: z.string().nullable(),
  returnId: z.string().nullable(),
  submittedAt: nullableTimestampSchema,
  resolvedAt: nullableTimestampSchema,
  createdAt: nullableTimestampSchema,
  updatedAt: nullableTimestampSchema,
});

/** Order detail — returned by getOrderDetails (admin). */
export const orderDetailSchema = z
  .object({
    id: z.string(),
    customerName: z.string(),
    customerPhone: z.string(),
    customerEmail: z.string().nullable(),
    customerId: z.string().nullable(),
    totalAmount: z.number(),
    shippingCharge: z.number(),
    discountAmount: z.number(),
    currencyCode: z.string().nullable(),
    currencyDecimalPlaces: z.number().int().nullable(),
    subtotalAmountMinor: z.number().int().nullable(),
    shippingAmountMinor: z.number().int().nullable(),
    discountAmountMinor: z.number().int().nullable(),
    taxAmountMinor: z.number().int(),
    totalAmountMinor: z.number().int().nullable(),
    taxLabel: z.string().nullable(),
    pricesIncludeTax: z.boolean(),
    promotion: z.object({
      id: z.string(),
      revision: z.number().int().positive(),
      evaluatorVersion: z.number().int().positive(),
      method: z.enum(["automatic", "code"]),
      name: z.string(),
      code: z.string().nullable(),
    }).nullable(),
    status: z.string(),
    paymentStatus: z.string().nullable(),
    paymentMethod: z.string().nullable(),
    fulfillmentStatus: z.string().nullable(),
    notes: z.string().nullable(),
    shippingAddress: z.string().nullable(),
    city: z.string().nullable(),
    zone: z.string().nullable(),
    area: z.string().nullable(),
    cityName: z.string().nullable(),
    zoneName: z.string().nullable(),
    areaName: z.string().nullable(),
    paidAmount: z.number().nullable(),
    balanceDue: z.number().nullable(),
    version: z.number().int().min(1),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: nullableTimestampSchema,
    itemCount: z.number(),
    items: z.array(orderItemSchema),
    latestShipment: orderShipmentSummarySchema.nullable(),
    shipmentRecovery: orderShipmentRecoverySchema,
    paymentRecovery: orderPaymentRecoverySchema,
    refundAttempts: z.array(orderRefundAttemptSchema),
    activeRefundOperation: activeRefundOperationSchema.nullable(),
    fullEditReadiness: orderFullEditReadinessSchema,
    supportRequests: z.array(orderSupportRequestSchema),
  })

// ─────────────────────────────────────────
// Categories
// ─────────────────────────────────────────

/** Category summary — returned by listCategories (admin). */
export const categorySummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    imageUrl: z.string().nullable(),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    canonicalPath: z.string().nullable(),
    noIndex: z.boolean(),
    excludeFromSitemap: z.boolean(),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
    deletedAt: z.string().nullable(),
    productCount: z.number(),
    status: categoryStatusSchema,
    revision: z.number().int().min(1),
    publishReady: z.boolean(),
  })

/** Category detail — returned by getCategoryById (admin). */
export const categoryDetailSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    imageUrl: z.string().nullable(),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    canonicalPath: z.string().nullable(),
    noIndex: z.boolean(),
    excludeFromSitemap: z.boolean(),
    deletedAt: z.number().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    status: categoryStatusSchema,
    revision: z.number().int().min(1),
    publishReadiness: z.object({
      ready: z.boolean(),
      eligibleProductCount: z.number().int().min(0),
      blockers: z.array(z.object({ code: z.string(), message: z.string() })),
      warnings: z.array(z.object({ code: z.string(), message: z.string() })),
    }),
  })

/** Category stats — returned by getCategoryStats (admin). */
export const categoryStatsSchema = z
  .object({
    totalCategories: z.number(),
    categoriesWithImages: z.number(),
    totalProducts: z.number(),
  })

// ─────────────────────────────────────────
// Customers
// ─────────────────────────────────────────

/** Customer summary — returned by listCustomers (admin). */
export const customerSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    phone: z.string(),
    address: z.string().nullable(),
    city: z.string().nullable(),
    zone: z.string().nullable(),
    area: z.string().nullable(),
    cityName: z.string().nullable(),
    zoneName: z.string().nullable(),
    areaName: z.string().nullable(),
    accountClaimedAt: z.string().nullable(),
    totalOrders: z.number(),
    totalSpent: z.number(),
    lastOrderAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })

/** Customer detail — returned by getCustomerById (admin). Full DB row. */
export const customerDetailSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    phone: z.string(),
    address: z.string().nullable(),
    city: z.string().nullable(),
    zone: z.string().nullable(),
    area: z.string().nullable(),
    cityName: z.string().nullable(),
    zoneName: z.string().nullable(),
    areaName: z.string().nullable(),
    accountClaimedAt: nullableTimestampSchema,
    totalOrders: z.number(),
    totalSpent: z.number(),
    lastOrderAt: nullableTimestampSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: nullableTimestampSchema,
  })

// ─────────────────────────────────────────
// Collections
// ─────────────────────────────────────────

/** Collection — returned by listCollections / getCollectionById (admin). Full DB row. */
export const collectionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    presentation: z.enum(["grid", "carousel"]),
    config: z.string(),
    sortOrder: z.number(),
    isActive: z.boolean(),
    version: z.number().int().min(1),
    canonicalPath: z.string().nullable(),
    noIndex: z.boolean(),
    excludeFromSitemap: z.boolean(),
    createdAt: nullableTimestampSchema,
    updatedAt: nullableTimestampSchema,
    deletedAt: nullableTimestampSchema,
  })

// ─────────────────────────────────────────
// Discounts
// ─────────────────────────────────────────

/** Discount — returned by discount service endpoints. */
export const discountSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    revision: z.number().int().min(1),
    type: z.string(),
    valueType: z.string(),
    discountValue: z.number(),
    minPurchaseAmount: z.number().nullable(),
    minQuantity: z.number().nullable(),
    maxUsesPerOrder: z.number().nullable(),
    maxUses: z.number().nullable(),
    limitOnePerCustomer: z.boolean(),
    customerSegment: z.string().nullable(),
    startDate: timestampSchema,
    endDate: nullableTimestampSchema,
    isActive: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: nullableTimestampSchema,
  })

// ─────────────────────────────────────────
// Pages
// ─────────────────────────────────────────

/** Page — returned by page service endpoints. */
export const pageFeaturedImageSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    filename: z.string(),
    size: z.number(),
    mimeType: z.string().optional(),
    altText: z.string().nullable().optional(),
    width: z.number().nullable().optional(),
    height: z.number().nullable().optional(),
    folderId: z.string().nullable().optional(),
    createdAt: optionalTimestampSchema,
    updatedAt: optionalTimestampSchema,
  })
  .passthrough();

export const pageSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    slug: z.string(),
    content: z.string(),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    canonicalPath: z.string().nullable(),
    noIndex: z.boolean(),
    excludeFromSitemap: z.boolean(),
    isPublished: z.boolean(),
    hideHeader: z.boolean(),
    hideFooter: z.boolean(),
    hideTitle: z.boolean(),
    featuredImage: pageFeaturedImageSchema.nullable().optional(),
    publishedAt: optionalNullableTimestampSchema,
    sortOrder: z.number(),
    revision: z.number().int().min(1),
    createdAt: nullableTimestampSchema,
    updatedAt: nullableTimestampSchema,
    deletedAt: nullableTimestampSchema,
  })

// ─────────────────────────────────────────
// Attributes
// ─────────────────────────────────────────

/** Product attribute — returned by attributes service endpoints. */
export const attributeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    filterable: z.boolean(),
    options: z.array(z.string()).nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: nullableTimestampSchema,
  });

// ─────────────────────────────────────────
// Media
// ─────────────────────────────────────────

/** Media item — returned by media service endpoints. */
export const mediaSchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    url: z.string(),
    kind: z.enum(["image", "video"]),
    objectKey: z.string(),
    size: z.number(),
    mimeType: z.string(),
    altText: z.string().nullable().optional(),
    caption: z.string().nullable().optional(),
    width: z.number().nullable().optional(),
    height: z.number().nullable().optional(),
    durationMs: z.number().nullable().optional(),
    posterMediaId: z.string().nullable().optional(),
    posterUrl: z.string().nullable(),
    folderId: z.string().nullable(),
    status: z.enum(["ready", "trashed", "deleting", "deleted"]),
    version: z.number().int().min(1),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    trashedAt: nullableTimestampSchema,
    deletedAt: nullableTimestampSchema,
  })

/** Media folder. */
export const mediaFolderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    version: z.number().int().min(1),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: nullableTimestampSchema,
  })

// ─────────────────────────────────────────
// Delivery
// ─────────────────────────────────────────

/** Delivery provider. */
export const deliveryProviderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    isActive: z.boolean(),
  })

/** Delivery shipment. */
export const deliveryShipmentSchema = z
  .object({
    id: z.string(),
    orderId: z.string(),
    providerId: z.string().nullable(),
    providerType: z.string().nullable(),
    status: z.string(),
    rawStatus: z.string().nullable(),
    externalId: z.string().nullable(),
    trackingId: z.string().nullable(),
    trackingUrl: z.string().nullable(),
    courierName: z.string().nullable(),
    note: z.string().nullable(),
    metadata: z.string().nullable(),
    lastChecked: nullableTimestampSchema,
    shipmentItems: z.string().nullable(),
    shipmentAmount: z.number().nullable(),
    isFinalShipment: z.boolean().nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })

/** Delivery location (city/zone/area). */
export const deliveryLocationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    parentId: z.string().nullable(),
    isActive: z.boolean(),
  })

// ─────────────────────────────────────────
// Settings
// ─────────────────────────────────────────

/** Generic settings key-value pair. */
export const settingSchema = z
  .object({
    id: z.string(),
    category: z.string(),
    key: z.string(),
    value: z.string().nullable(),
  })

/** Site settings singleton row. */
export const siteSettingsSchema = z
  .object({
    id: z.string(),
  })

// ─────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────

/** Navigation menu item. */
export const navigationItemSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    url: z.string().nullable(),
    type: z.string(),
    sortOrder: z.number(),
  })
