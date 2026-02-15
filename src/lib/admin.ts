import { db } from "../db";
import {
  products,
  orders,
  categories,
  productVariants,
  productImages,
  orderItems,
  customers,
  discounts,
  discountUsage,
  deliveryShipments,
  deliveryProviders,
} from "../db/schema";
import { and, sql, desc, like, eq, asc, gte, inArray } from "drizzle-orm";
import type {
  Product,
  ProductVariant,
  ProductImage,
  Discount,
} from "../db/schema";

export async function getDashboardStats() {
  const now = new Date();
  const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const firstDayOfLastMonth = new Date(
    now.getFullYear(),
    now.getMonth() - 1,
    1,
  );

  // Convert dates to Unix timestamps (seconds)
  const firstDayOfMonthTs = Math.floor(firstDayOfMonth.getTime() / 1000);
  const firstDayOfLastMonthTs = Math.floor(
    firstDayOfLastMonth.getTime() / 1000,
  );

  // Run independent dashboard queries in parallel for faster load
  const [
    [{ count: totalProducts }],
    [{ count: totalCustomers }],
    [currentMonthStats],
    [lastMonthStats],
    [{ total: totalRevenue }],
  ] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(products)
      .where(sql`${products.deletedAt} is null AND ${products.isActive} = 1`),
    db
      .select({ count: sql<number>`count(*)` })
      .from(customers)
      .where(sql`${customers.deletedAt} is null`),
    db
      .select({
        count: sql<number>`count(*)`,
        revenue: sql<number>`sum(total_amount)`,
        delivered: sql<number>`count(case when status = 'delivered' then 1 end)`,
        processing: sql<number>`count(case when status in ('pending', 'processing', 'confirmed') then 1 end)`,
        shipping: sql<number>`count(case when status = 'shipped' then 1 end)`,
        cancelled: sql<number>`count(case when status in ('cancelled', 'returned') then 1 end)`,
      })
      .from(orders)
      .where(
        sql`${orders.deletedAt} is null AND ${orders.createdAt} >= ${firstDayOfMonthTs} AND ${orders.status} NOT IN ('cancelled', 'returned')`,
      ),
    db
      .select({
        count: sql<number>`count(*)`,
        revenue: sql<number>`sum(total_amount)`,
      })
      .from(orders)
      .where(
        sql`${orders.deletedAt} is null AND ${orders.createdAt} >= ${firstDayOfLastMonthTs} AND ${orders.createdAt} < ${firstDayOfMonthTs} AND ${orders.status} NOT IN ('cancelled', 'returned')`,
      ),
    db
      .select({
        total: sql<number>`sum(total_amount)`,
      })
      .from(orders)
      .where(
        sql`${orders.deletedAt} is null AND ${orders.status} NOT IN ('cancelled', 'returned')`,
      ),
  ]);

  // Calculate growth percentages
  const orderGrowth = lastMonthStats.count
    ? Math.round(
        ((currentMonthStats.count - lastMonthStats.count) /
          lastMonthStats.count) *
          100,
      )
    : 0;

  const revenueGrowth = lastMonthStats.revenue
    ? Math.round(
        ((currentMonthStats.revenue - lastMonthStats.revenue) /
          lastMonthStats.revenue) *
          100,
      )
    : 0;

  return {
    totalProducts,
    totalCustomers,
    totalRevenue: totalRevenue || 0,
    currentMonth: {
      orders: currentMonthStats.count,
      revenue: currentMonthStats.revenue || 0,
      orderGrowth,
      revenueGrowth,
      orderStatus: {
        delivered: currentMonthStats.delivered || 0,
        processing: currentMonthStats.processing || 0,
        shipping: currentMonthStats.shipping || 0,
        cancelled: currentMonthStats.cancelled || 0,
      },
    },
    lastMonth: {
      orders: lastMonthStats.count,
      revenue: lastMonthStats.revenue || 0,
    },
  };
}

export async function getRecentOrders(limit = 5) {
  const recentOrders = await db
    .select({
      id: orders.id,
      customerName: orders.customerName,
      totalAmount: orders.totalAmount,
      status: orders.status,
      createdAt: sql<string>`datetime(${orders.createdAt}, 'unixepoch')`,
    })
    .from(orders)
    .orderBy(desc(orders.createdAt))
    .limit(limit);

  return recentOrders.map((order) => ({
    ...order,
    createdAt: new Date(order.createdAt),
  }));
}

export interface ProductWithDetails extends Product {
  category: { name: string };
  variants: ProductVariant[];
  images: ProductImage[];
}

export interface ProductListItem {
  id: string;
  name: string;
  slug: string;
  price: number;
  description: string | null;
  isActive: boolean;
  discountPercentage: number | null;
  freeDelivery: boolean;
  createdAt: Date;
  updatedAt: Date;
  category: {
    name: string;
  };
  variantCount: number;
  imageCount: number;
  primaryImage: string | null;
  sku?: string;
}

export async function getProducts(options: {
  search?: string;
  categoryId?: string;
  page?: number;
  limit?: number;
  showTrashed?: boolean;
  sort?: "name" | "price" | "category" | "createdAt" | "updatedAt";
  order?: "asc" | "desc";
}) {
  const {
    search,
    categoryId,
    page = 1,
    limit = 10,
    showTrashed = false,
    sort = "updatedAt",
    order = "desc",
  } = options;
  const offset = (page - 1) * limit;

  // Build where conditions
  const whereConditions = [];

  if (showTrashed) {
    // Show only trashed items
    whereConditions.push(sql`${products.deletedAt} IS NOT NULL`);
  } else {
    // Show only non-trashed items
    whereConditions.push(sql`${products.deletedAt} IS NULL`);
  }

  if (search) {
    // Add SKU to search condition if search term is provided
    whereConditions.push(
      sql`(${products.name} LIKE ${`%${search}%`} OR EXISTS (SELECT 1 FROM ${productVariants} WHERE ${productVariants.productId} = ${products.id} AND ${productVariants.sku} LIKE ${`%${search}%`}))`,
    );
  }

  if (categoryId) {
    whereConditions.push(eq(products.categoryId, categoryId));
  }

  // Get total count for pagination
  const [{ count }] = await db
    .select({ count: sql<number>`count(distinct ${products.id})` })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(whereConditions.length > 0 ? and(...whereConditions) : undefined);

  // Step 1: Fetch main product data
  const productResults = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      price: products.price,
      description: products.description,
      isActive: products.isActive,
      discountPercentage: products.discountPercentage,
      freeDelivery: products.freeDelivery,
      createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`,
      updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`,
      deletedAt: sql<number>`CAST(${products.deletedAt} AS INTEGER)`,
      categoryName: categories.name, // Fetch category name directly
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(whereConditions.length > 0 ? and(...whereConditions) : undefined)
    .limit(limit)
    .offset(offset)
    .orderBy(
      (() => {
        const sortField = (() => {
          switch (sort) {
            case "name":
              return products.name;
            case "price":
              return products.price;
            case "category":
              return categories.name; // Sorting by category name
            case "createdAt":
              return products.createdAt;
            case "updatedAt":
            default:
              return products.updatedAt;
          }
        })();
        return order === "asc" ? asc(sortField) : desc(sortField);
      })(),
    );

  if (productResults.length === 0) {
    return {
      products: [],
      pagination: {
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit),
      },
    };
  }

  const productIds = productResults.map((p) => p.id);

  // Fetch variant counts, image counts, primary images, and SKUs in parallel
  const [variantCounts, imageCounts, primaryImages, productSkus] = await Promise.all([
    // Variant counts
    db
      .select({
        productId: productVariants.productId,
        count: sql<number>`count(${productVariants.id})`,
      })
      .from(productVariants)
      .where(
        sql`${productVariants.productId} IN ${productIds} AND ${productVariants.deletedAt} IS NULL`,
      )
      .groupBy(productVariants.productId),
    // Image counts
    db
      .select({
        productId: productImages.productId,
        count: sql<number>`count(${productImages.id})`,
      })
      .from(productImages)
      .where(sql`${productImages.productId} IN ${productIds}`)
      .groupBy(productImages.productId),
    // Primary images
    db
      .select({
        productId: productImages.productId,
        url: productImages.url,
      })
      .from(productImages)
      .where(
        and(
          sql`${productImages.productId} IN ${productIds}`,
          eq(productImages.isPrimary, true),
        ),
      ),
    // SKUs (first variant per product)
    db
      .select({
        productId: productVariants.productId,
        sku: productVariants.sku,
      })
      .from(productVariants)
      .where(
        sql`${productVariants.productId} IN ${productIds} AND ${productVariants.deletedAt} IS NULL`,
      )
      .orderBy(productVariants.productId, asc(productVariants.createdAt)),
  ]);

  const variantCountMap = new Map(
    variantCounts.map((vc) => [vc.productId, vc.count]),
  );

  const imageCountMap = new Map(
    imageCounts.map((ic) => [ic.productId, ic.count]),
  );

  const primaryImageMap = new Map(
    primaryImages.map((pi) => [pi.productId, pi.url]),
  );

  // Create a map for the first SKU of each product
  const skuMap = new Map<string, string>();
  productSkus.forEach((item) => {
    if (!skuMap.has(item.productId)) {
      skuMap.set(item.productId, item.sku);
    }
  });

  // Step 6: Combine data
  const combinedProducts = productResults.map((product) => ({
    id: product.id,
    name: product.name,
    slug: product.slug,
    price: product.price,
    description: product.description,
    isActive: product.isActive,
    discountPercentage: product.discountPercentage || 0,
    freeDelivery: product.freeDelivery,
    createdAt: new Date(product.createdAt * 1000),
    updatedAt: new Date(product.updatedAt * 1000),
    // deletedAt is not selected in productResults, handle if needed or remove if not used in ProductListItem
    category: {
      name: product.categoryName || "Uncategorized",
    },
    variantCount: variantCountMap.get(product.id) || 0,
    imageCount: imageCountMap.get(product.id) || 0,
    primaryImage: primaryImageMap.get(product.id) || null,
    sku: skuMap.get(product.id) || undefined, // Add SKU here
  }));

  return {
    products: combinedProducts,
    pagination: {
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit),
    },
  };
}

export async function getProductDetails(
  id: string,
): Promise<ProductWithDetails | null> {
  const [result] = await db
    .select({
      id: products.id,
      name: products.name,
      description: products.description,
      price: products.price,
      categoryId: products.categoryId,
      slug: products.slug,
      metaTitle: products.metaTitle,
      metaDescription: products.metaDescription,
      createdAt: products.createdAt,
      updatedAt: products.updatedAt,
      deletedAt: products.deletedAt,
      isActive: products.isActive,
      discountPercentage: products.discountPercentage,
      freeDelivery: products.freeDelivery,
      category: {
        name: categories.name,
      },
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(eq(products.id, id));

  if (!result) return null;

  // Get variants
  const variants = await db
    .select()
    .from(productVariants)
    .where(eq(productVariants.productId, id));

  // Get images
  const images = await db
    .select()
    .from(productImages)
    .where(eq(productImages.productId, id))
    .orderBy(productImages.sortOrder);

  return {
    ...result,
    createdAt: new Date(Number(result.createdAt) * 1000),
    updatedAt: new Date(Number(result.updatedAt) * 1000),
    deletedAt: result.deletedAt
      ? new Date(Number(result.deletedAt) * 1000)
      : null,
    variants,
    images: images.map((img) => ({
      ...img,
      createdAt: new Date(Number(img.createdAt) * 1000),
    })),
  } as ProductWithDetails;
}

export interface OrderShipmentSummary {
  id: string;
  providerId: string;
  providerType: string;
  providerName: string | null;
  status: string;
  rawStatus: string | null;
  externalId: string | null;
  trackingId: string | null;
  lastChecked: Date | null;
  updatedAt: Date;
  createdAt: Date;
}

export interface OrderListItem {
  id: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  customerId: string | null;
  totalAmount: number;
  shippingCharge: number;
  discountAmount: number | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  itemCount: number;
  city: string;
  zone: string;
  area: string | null;
  // Location names
  cityName: string | null;
  zoneName: string | null;
  areaName: string | null;
  latestShipment: OrderShipmentSummary | null;
}

export async function getOrders(options: {
  search?: string;
  status?: string;
  page?: number;
  limit?: number;
  showTrashed?: boolean;
  sort?: "customerName" | "totalAmount" | "status" | "createdAt" | "updatedAt";
  order?: "asc" | "desc";
  startDate?: Date;
  endDate?: Date;
}) {
  const {
    search,
    status,
    page = 1,
    limit = 10,
    showTrashed = false,
    sort = "updatedAt",
    order = "desc",
    startDate,
    endDate,
  } = options;
  const offset = (page - 1) * limit;

  // Build where conditions
  const whereConditions = [];

  if (showTrashed) {
    // Show only trashed items
    whereConditions.push(sql`${orders.deletedAt} IS NOT NULL`);
  } else {
    // Show only non-trashed items
    whereConditions.push(sql`${orders.deletedAt} IS NULL`);
  }

  if (search) {
    whereConditions.push(
      sql`(${orders.customerName} LIKE ${`%${search}%`} OR ${
        orders.customerPhone
      } LIKE ${`%${search}%`} OR ${orders.id} LIKE ${`%${search}%`})`,
    );
  }

  if (status) {
    whereConditions.push(sql`${orders.status} = ${status}`);
  }

  if (startDate) {
    const startTs = Math.floor(startDate.getTime() / 1000);
    whereConditions.push(sql`${orders.createdAt} >= ${startTs}`);
  }

  if (endDate) {
    // Set to end of day (23:59:59.999) to include all orders on that date
    const endOfDay = new Date(endDate);
    endOfDay.setHours(23, 59, 59, 999);
    const endTs = Math.floor(endOfDay.getTime() / 1000);
    whereConditions.push(sql`${orders.createdAt} <= ${endTs}`);
  }

  // Get total count for pagination
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(orders)
    .where(
      whereConditions.length > 0
        ? sql`${sql.join(whereConditions, sql` AND `)}`
        : undefined,
    );

  // Get paginated results with proper timestamp handling
  const results = await db
    .select({
      id: orders.id,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      customerEmail: orders.customerEmail,
      customerId: orders.customerId,
      totalAmount: orders.totalAmount,
      shippingCharge: orders.shippingCharge,
      discountAmount: orders.discountAmount,
      status: orders.status,
      createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
      updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`,
      city: orders.city,
      zone: orders.zone,
      area: orders.area,
      cityName: orders.cityName,
      zoneName: orders.zoneName,
      areaName: orders.areaName,
    })
    .from(orders)
    .where(
      whereConditions.length > 0
        ? sql`${sql.join(whereConditions, sql` AND `)}`
        : undefined,
    )
    .limit(limit)
    .offset(offset)
    .orderBy(
      (() => {
        const sortField = (() => {
          switch (sort) {
            case "customerName":
              return orders.customerName;
            case "totalAmount":
              return orders.totalAmount;
            case "status":
              return orders.status;
            case "createdAt":
              return orders.createdAt;
            case "updatedAt":
            default:
              return orders.updatedAt;
          }
        })();

        return order === "asc" ? sql`${sortField} asc` : sql`${sortField} desc`;
      })(),
    );

  // Fetch item counts and shipments in parallel
  const orderIds = results.map((r) => r.id);

  const [itemCounts, shipments] = await Promise.all([
    // Item counts
    db
      .select({
        orderId: orderItems.orderId,
        count: sql<number>`COUNT(*)`,
        totalQuantity: sql<number>`SUM(${orderItems.quantity})`,
      })
      .from(orderItems)
      .where(sql`${orderItems.orderId} IN ${orderIds}`)
      .groupBy(orderItems.orderId),
    // Latest shipments
    results.length > 0
      ? db
          .select({
            orderId: deliveryShipments.orderId,
            id: deliveryShipments.id,
            providerId: deliveryShipments.providerId,
            providerType: deliveryShipments.providerType,
            status: deliveryShipments.status,
            rawStatus: deliveryShipments.rawStatus,
            externalId: deliveryShipments.externalId,
            trackingId: deliveryShipments.trackingId,
            lastChecked: deliveryShipments.lastChecked,
            updatedAt: deliveryShipments.updatedAt,
            createdAt: deliveryShipments.createdAt,
            providerName: deliveryProviders.name,
          })
          .from(deliveryShipments)
          .leftJoin(
            deliveryProviders,
            eq(deliveryShipments.providerId, deliveryProviders.id),
          )
          .where(inArray(deliveryShipments.orderId, orderIds))
          .orderBy(desc(deliveryShipments.createdAt))
      : Promise.resolve([]),
  ]);

  // Create item count map
  const itemCountMap = new Map(
    itemCounts.map((ic) => [
      ic.orderId,
      { count: ic.count, quantity: ic.totalQuantity },
    ]),
  );

  const normalizeDate = (value: unknown): Date | null => {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value === "number") {
      return value > 1e12 ? new Date(value) : new Date(value * 1000);
    }
    const numericValue = Number(value);
    if (!Number.isNaN(numericValue) && numericValue !== 0) {
      return numericValue > 1e12
        ? new Date(numericValue)
        : new Date(numericValue * 1000);
    }
    try {
      return new Date(String(value));
    } catch {
      return null;
    }
  };

  const shipmentMap = new Map<string, OrderShipmentSummary>();

  for (const shipment of shipments) {
    if (!shipmentMap.has(shipment.orderId)) {
      shipmentMap.set(shipment.orderId, {
        id: shipment.id,
        providerId: shipment.providerId,
        providerType: shipment.providerType,
        providerName: shipment.providerName,
        status: shipment.status,
        rawStatus: shipment.rawStatus,
        externalId: shipment.externalId,
        trackingId: shipment.trackingId,
        lastChecked: normalizeDate(shipment.lastChecked),
        updatedAt: normalizeDate(shipment.updatedAt) ?? new Date(),
        createdAt: normalizeDate(shipment.createdAt) ?? new Date(),
      });
    }
  }

  const formattedResults = results.map((order) => ({
    ...order,
    createdAt: new Date(order.createdAt * 1000),
    updatedAt: new Date(order.updatedAt * 1000),
    itemCount: itemCountMap.get(order.id)?.count || 0,
    totalQuantity: itemCountMap.get(order.id)?.quantity || 0,
    latestShipment: shipmentMap.get(order.id) || null,
  }));

  return {
    orders: formattedResults,
    pagination: {
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit),
    },
  };
}

export interface OrderDetails extends OrderListItem {
  notes: string | null;
  shippingAddress: string;
  customerId: string | null;
  deletedAt: Date | null;
  items: {
    id: string;
    productId: string;
    variantId: string | null;
    quantity: number;
    price: number;
    product: {
      name: string;
      variant?: {
        size: string | null;
        color: string | null;
        weight: number | null;
        sku: string;
      };
    };
  }[];
}

export async function getOrderDetails(
  id: string,
): Promise<OrderDetails | null> {
  const order = await db
    .select({
      id: orders.id,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      customerEmail: orders.customerEmail,
      customerId: orders.customerId,
      totalAmount: orders.totalAmount,
      shippingCharge: orders.shippingCharge,
      discountAmount: orders.discountAmount,
      status: orders.status,
      notes: orders.notes,
      shippingAddress: orders.shippingAddress,
      city: orders.city,
      zone: orders.zone,
      area: orders.area,
      cityName: orders.cityName,
      zoneName: orders.zoneName,
      areaName: orders.areaName,
      createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
      updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`,
      deletedAt: sql<number>`CAST(${orders.deletedAt} AS INTEGER)`,
      itemCount: sql<number>`(
        SELECT COUNT(*) 
        FROM ${orderItems} 
        WHERE ${orderItems.orderId} = ${orders.id}
      )`,
    })
    .from(orders)
    .where(eq(orders.id, id))
    .get();

  if (!order) return null;

  // Get order items with product details
  const items = await db
    .select({
      id: orderItems.id,
      productId: orderItems.productId,
      variantId: orderItems.variantId,
      quantity: orderItems.quantity,
      price: orderItems.price,
      productName: products.name,
    })
    .from(orderItems)
    .leftJoin(products, eq(products.id, orderItems.productId))
    .where(eq(orderItems.orderId, id));

  // Batch fetch all variants in one query (fix N+1)
  const variantIds = [...new Set(items.map((i) => i.variantId).filter(Boolean))] as string[];
  const variantMap = new Map<
    string,
    { size: string | null; color: string | null; weight: number | null; sku: string }
  >();
  if (variantIds.length > 0) {
    const variants = await db
      .select({
        id: productVariants.id,
        size: productVariants.size,
        color: productVariants.color,
        weight: productVariants.weight,
        sku: productVariants.sku,
      })
      .from(productVariants)
      .where(inArray(productVariants.id, variantIds));
    for (const v of variants) {
      variantMap.set(v.id, {
        size: v.size,
        color: v.color,
        weight: v.weight,
        sku: v.sku,
      });
    }
  }

  // Format items with proper structure (no per-item DB calls)
  const formattedItems = items.map((item) => {
    const variant = item.variantId ? variantMap.get(item.variantId) : undefined;
    return {
      id: item.id,
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      price: item.price,
      product: {
        name: item.productName || "Unknown Product",
        ...(variant && { variant }),
      },
    };
  });

  return {
    ...order,
    createdAt: new Date(order.createdAt * 1000),
    updatedAt: new Date(order.updatedAt * 1000),
    deletedAt: order.deletedAt ? new Date(order.deletedAt * 1000) : null,
    items: formattedItems,
    latestShipment: null, // Not needed for order details view
  };
}

export async function getProductStats() {
  // Get total product count
  const [{ count: totalProducts }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(products)
    .where(sql`${products.deletedAt} IS NULL`);

  // Get count of active products
  const [{ count: activeProducts }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(products)
    .where(sql`${products.deletedAt} IS NULL AND ${products.isActive} = 1`);

  // Get count of products with primary images
  const [{ count: productsWithImages }] = await db
    .select({
      count: sql<number>`count(DISTINCT ${products.id})`,
    })
    .from(products)
    .innerJoin(
      productImages,
      and(
        eq(productImages.productId, products.id),
        eq(productImages.isPrimary, true),
      ),
    )
    .where(sql`${products.deletedAt} IS NULL`);

  // Get categories count
  const [{ count: categoriesCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(categories)
    .where(sql`${categories.deletedAt} IS NULL`);

  return {
    totalProducts,
    activeProducts,
    productsWithImages,
    categoriesCount,
  };
}

export async function getCategoryStats() {
  // Get total categories count
  const [{ count: totalCategories }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(categories)
    .where(sql`${categories.deletedAt} IS NULL`);

  // Get count of categories with images
  const [{ count: categoriesWithImages }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(categories)
    .where(
      sql`${categories.deletedAt} IS NULL AND ${categories.imageUrl} IS NOT NULL`,
    );

  // Get total products across all categories
  const [{ count: totalProducts }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(products)
    .where(sql`${products.deletedAt} IS NULL`);

  return {
    totalCategories,
    categoriesWithImages,
    totalProducts,
  };
}

// New function to get daily aggregated order data
export async function getDailyActivityData(days: number) {
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(now.getDate() - days);

  // Use strftime to format the timestamp as YYYY-MM-DD for grouping
  const dailyOrderData = await db
    .select({
      date: sql<string>`strftime('%Y-%m-%d', datetime(${orders.createdAt}, 'unixepoch'))`,
      orderCount: sql<number>`count(*)`.mapWith(Number),
      totalRevenue: sql<number>`sum(${orders.totalAmount})`.mapWith(Number),
    })
    .from(orders)
    .where(
      and(
        sql`${orders.deletedAt} is null`,
        gte(orders.createdAt, startDate),
        sql`${orders.status} NOT IN ('cancelled', 'returned')`,
      ),
    )
    .groupBy(
      sql`strftime('%Y-%m-%d', datetime(${orders.createdAt}, 'unixepoch'))`,
    )
    .orderBy(
      sql`strftime('%Y-%m-%d', datetime(${orders.createdAt}, 'unixepoch')) asc`,
    );

  // Fetch daily new customer counts
  const dailyCustomerData = await db
    .select({
      date: sql<string>`strftime('%Y-%m-%d', datetime(${customers.createdAt}, 'unixepoch'))`,
      customerCount: sql<number>`count(*)`.mapWith(Number),
    })
    .from(customers)
    .where(
      and(
        sql`${customers.deletedAt} is null`,
        // Assuming customer createdAt is also a unix epoch timestamp stored as number
        gte(customers.createdAt, startDate),
      ),
    )
    .groupBy(
      sql`strftime('%Y-%m-%d', datetime(${customers.createdAt}, 'unixepoch'))`,
    )
    .orderBy(
      sql`strftime('%Y-%m-%d', datetime(${customers.createdAt}, 'unixepoch')) asc`,
    );

  // Ensure all days in the range are present, filling missing days with 0
  const result = [];
  const currentDate = new Date(startDate);
  currentDate.setHours(0, 0, 0, 0); // Normalize start date

  const endDate = new Date(now);
  endDate.setHours(0, 0, 0, 0); // Normalize end date

  const orderMap = new Map(dailyOrderData.map((item) => [item.date, item]));
  const customerMap = new Map(
    dailyCustomerData.map((item) => [item.date, item]),
  );

  while (currentDate <= endDate) {
    const dateStr = currentDate.toISOString().split("T")[0];
    const orderEntry = orderMap.get(dateStr);
    const customerEntry = customerMap.get(dateStr);
    result.push({
      date: dateStr,
      orders: orderEntry ? orderEntry.orderCount : 0,
      revenue: orderEntry ? orderEntry.totalRevenue : 0,
      newCustomers: customerEntry ? customerEntry.customerCount : 0,
    });
    currentDate.setDate(currentDate.getDate() + 1);
  }

  return result;
}

// Function to get discounts with pagination, sorting, filtering, etc.
export async function getDiscounts(options: {
  search?: string;
  type?: string; // Filter by discount type
  page?: number;
  limit?: number;
  showTrashed?: boolean;
  sort?:
    | "code"
    | "type"
    | "value"
    | "startDate"
    | "endDate"
    | "createdAt"
    | "updatedAt";
  order?: "asc" | "desc";
}) {
  const {
    search,
    type,
    page = 1,
    limit = 10,
    showTrashed = false,
    sort = "updatedAt",
    order = "desc",
  } = options;
  const offset = (page - 1) * limit;

  // Build where conditions
  const whereConditions = [];

  if (showTrashed) {
    whereConditions.push(sql`${discounts.deletedAt} IS NOT NULL`);
  } else {
    whereConditions.push(sql`${discounts.deletedAt} IS NULL`);
  }

  if (search) {
    whereConditions.push(like(discounts.code, `%${search}%`));
  }

  if (type) {
    // Assert the type string matches the expected enum values
    whereConditions.push(eq(discounts.type, type as Discount["type"]));
  }

  // Get total count for pagination
  const [{ count }] = await db
    .select({ count: sql<number>`count(distinct ${discounts.id})` })
    .from(discounts)
    .where(whereConditions.length > 0 ? and(...whereConditions) : undefined);

  // Get paginated results
  const results = await db
    .select({
      id: discounts.id,
      code: discounts.code,
      type: discounts.type,
      valueType: discounts.valueType,
      discountValue: discounts.discountValue,
      minPurchaseAmount: discounts.minPurchaseAmount,
      minQuantity: discounts.minQuantity,
      maxUsesPerOrder: discounts.maxUsesPerOrder,
      maxUses: discounts.maxUses,
      limitOnePerCustomer: discounts.limitOnePerCustomer,
      combineWithProductDiscounts: discounts.combineWithProductDiscounts,
      combineWithOrderDiscounts: discounts.combineWithOrderDiscounts,
      combineWithShippingDiscounts: discounts.combineWithShippingDiscounts,
      customerSegment: discounts.customerSegment,
      startDate: sql<number>`CAST(${discounts.startDate} AS INTEGER)`,
      endDate: sql<number>`CAST(${discounts.endDate} AS INTEGER)`,
      isActive: discounts.isActive,
      createdAt: sql<number>`CAST(${discounts.createdAt} AS INTEGER)`,
      updatedAt: sql<number>`CAST(${discounts.updatedAt} AS INTEGER)`,
      deletedAt: sql<number>`CAST(${discounts.deletedAt} AS INTEGER)`,
      // Note: Fetching related products/collections here can be complex and slow.
      // It's generally better to fetch these on demand or in the edit page.
      // For simplicity, returning empty arrays for now.
      relatedProducts: sql<string>`json_object('buy', '[]', 'get', '[]')`,
      relatedCollections: sql<string>`json_object('buy', '[]', 'get', '[]')`,
    })
    .from(discounts)
    .where(whereConditions.length > 0 ? and(...whereConditions) : undefined)
    .limit(limit)
    .offset(offset)
    .orderBy(
      (() => {
        const sortField = (() => {
          switch (sort) {
            case "code":
              return discounts.code;
            case "type":
              return discounts.type;
            case "value":
              return discounts.discountValue;
            case "startDate":
              return discounts.startDate;
            case "endDate":
              return discounts.endDate;
            case "createdAt":
              return discounts.createdAt;
            case "updatedAt":
            default:
              return discounts.updatedAt;
          }
        })();
        return order === "asc" ? asc(sortField) : desc(sortField);
      })(),
    );

  // Get the discount IDs for fetching usage statistics
  const discountIds = results.map((discount) => discount.id);

  // Fetch usage statistics for each discount
  const usageStats: Record<string, { count: number; total: number }> = {};

  if (discountIds.length > 0) {
    const usageResults = await db
      .select({
        discountId: discountUsage.discountId,
        count: sql<number>`CAST(COUNT(${discountUsage.id}) AS INTEGER)`,
        total: sql<number>`CAST(SUM(${discountUsage.amountDiscounted}) AS INTEGER)`,
      })
      .from(discountUsage)
      .where(sql`${discountUsage.discountId} IN ${discountIds}`)
      .groupBy(discountUsage.discountId);

    // Convert to lookup object
    usageResults.forEach((result) => {
      usageStats[result.discountId] = {
        count: result.count ? parseInt(String(result.count), 10) : 0,
        total: result.total ? parseFloat(String(result.total)) : 0,
      };
    });
  }

  // Format dates from timestamps (seconds) to ISO strings for the client
  const formattedDiscounts = results.map((discount) => {
    // Get usage stats for this discount, defaulting to 0 if not found
    const stats = usageStats[discount.id] || { count: 0, total: 0 };

    return {
      ...discount,
      startDate: discount.startDate
        ? new Date(discount.startDate * 1000).toISOString()
        : null,
      endDate: discount.endDate
        ? new Date(discount.endDate * 1000).toISOString()
        : null,
      createdAt: discount.createdAt
        ? new Date(discount.createdAt * 1000).toISOString()
        : null,
      updatedAt: discount.updatedAt
        ? new Date(discount.updatedAt * 1000).toISOString()
        : null,
      deletedAt: discount.deletedAt
        ? new Date(discount.deletedAt * 1000).toISOString()
        : null,
      // Parse the JSON strings for related items (currently empty)
      relatedProducts: JSON.parse(
        discount.relatedProducts || '{"buy": [], "get": []}',
      ),
      relatedCollections: JSON.parse(
        discount.relatedCollections || '{"buy": [], "get": []}',
      ),
      // Include actual usage statistics
      usageCount: stats.count,
      totalDiscountAmount: stats.total,
    };
  });

  const totalPages = Math.ceil(count / limit);

  return {
    discounts: formattedDiscounts,
    pagination: {
      total: count,
      page,
      limit,
      totalPages,
    },
  };
}
