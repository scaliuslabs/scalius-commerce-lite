// apps/api/src/schemas/entities.ts
// Zod schemas for domain entities used in API responses.
// Derived from the actual shapes returned by core service functions.
//
// Entity schemas define strict shapes for OpenAPI documentation and SDK type generation.

import { z } from "@hono/zod-openapi";
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
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    category: z.object({ name: z.string() }),
    variantCount: z.number(),
    imageCount: z.number(),
    primaryImage: z.string().nullable(),
    sku: z.string().optional(),
  })

/** Product image. */
export const productImageSchema = z
  .object({
    id: z.string(),
    productId: z.string(),
    url: z.string(),
    alt: z.string().nullable(),
    isPrimary: z.boolean(),
    sortOrder: z.number(),
    createdAt: timestampSchema,
  })

/** Product variant — returned by variant CRUD endpoints. */
export const productVariantSchema = z
  .object({
    id: z.string(),
    productId: z.string(),
    size: z.string().nullable(),
    color: z.string().nullable(),
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
    colorSortOrder: z.number().nullable().optional(),
    sizeSortOrder: z.number().nullable().optional(),
    createdAt: optionalTimestampSchema,
    updatedAt: optionalTimestampSchema,
    deletedAt: optionalNullableTimestampSchema,
    stockVersion: z.number().optional(),
    version: z.number().optional(),
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
    isActive: z.boolean(),
    discountPercentage: z.number().nullable(),
    discountType: z.enum(["percentage", "flat"]).nullable(),
    discountAmount: z.number().nullable(),
    freeDelivery: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: nullableTimestampSchema,
    category: z.object({ name: z.string().nullable() }).nullable(),
    variants: z.array(productVariantSchema),
    images: z.array(productImageSchema),
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
    city: z.string().nullable(),
    zone: z.string().nullable(),
    area: z.string().nullable(),
    cityName: z.string().nullable(),
    zoneName: z.string().nullable(),
    areaName: z.string().nullable(),
    itemCount: z.number(),
    totalQuantity: z.number(),
    latestShipment: orderShipmentSummarySchema.nullable(),
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
    variantSize: z.string().nullable(),
    variantColor: z.string().nullable(),
    fulfillmentStatus: z.string(),
  })

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
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: nullableTimestampSchema,
    itemCount: z.number(),
    items: z.array(orderItemSchema),
    latestShipment: orderShipmentSummarySchema.nullable(),
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
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
    deletedAt: z.string().nullable(),
    productCount: z.number(),
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
    createdAt: z.number(),
    updatedAt: z.number(),
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
    type: z.enum(["manual", "dynamic"]),
    config: z.string(),
    sortOrder: z.number(),
    isActive: z.boolean(),
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
    isPublished: z.boolean(),
    hideHeader: z.boolean(),
    hideFooter: z.boolean(),
    hideTitle: z.boolean(),
    featuredImage: pageFeaturedImageSchema.nullable().optional(),
    publishedAt: optionalNullableTimestampSchema,
    sortOrder: z.number(),
    createdAt: nullableTimestampSchema,
    updatedAt: nullableTimestampSchema,
    deletedAt: nullableTimestampSchema,
  })

// ─────────────────────────────────────────
// Widgets
// ─────────────────────────────────────────

/** Widget — returned by widget service endpoints. */
export const widgetPlacementSchema = z
  .object({
    id: z.string(),
    widgetId: z.string(),
    scope: z.string(),
    scopeId: z.string().nullable(),
    slot: z.string(),
    anchorType: z.string().nullable(),
    anchorId: z.string().nullable(),
    sortOrder: z.number(),
    isActive: z.boolean(),
    createdAt: nullableTimestampSchema,
    updatedAt: nullableTimestampSchema,
    deletedAt: nullableTimestampSchema,
  });

export const publicWidgetPlacementSchema = z.object({
  id: z.string(),
  widgetId: z.string(),
  scope: z.string(),
  scopeId: z.string().nullable(),
  slot: z.string(),
  anchorType: z.string().nullable(),
  anchorId: z.string().nullable(),
  sortOrder: z.number(),
  isActive: z.boolean(),
  createdAt: nullableTimestampSchema,
  updatedAt: nullableTimestampSchema,
  deletedAt: nullableTimestampSchema,
});

export const widgetSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    htmlContent: z.string(),
    cssContent: z.string().nullable(),
    jsContent: z.string().nullable(),
    aiContext: z.string().nullable(),
    isActive: z.boolean(),
    displayTarget: z.string(),
    placementRule: z.string(),
    referenceCollectionId: z.string().nullable(),
    sortOrder: z.number(),
    placements: z.array(widgetPlacementSchema).optional(),
    createdAt: nullableTimestampSchema,
    updatedAt: nullableTimestampSchema,
    deletedAt: nullableTimestampSchema,
  })

export const publicWidgetSchema = widgetSchema.omit({ aiContext: true }).extend({
  placements: z.array(publicWidgetPlacementSchema).optional(),
});

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
    size: z.number(),
    mimeType: z.string(),
    altText: z.string().nullable().optional(),
    width: z.number().nullable().optional(),
    height: z.number().nullable().optional(),
    folderId: z.string().nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: nullableTimestampSchema,
  })

/** Media folder. */
export const mediaFolderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    parentId: z.string().nullable(),
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
