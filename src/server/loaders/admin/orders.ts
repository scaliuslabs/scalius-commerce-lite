import { db } from "@/db";
import {
  products,
  productVariants,
  orders,
  orderItems,
  productImages,
  deliveryLocations,
} from "@/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getOrders } from "@/modules/orders";

export async function getOrdersIndexData(options: {
  page: number;
  limit: number;
  search: string;
  status?: string;
  showTrashed: boolean;
  sort: "customerName" | "totalAmount" | "status" | "createdAt" | "updatedAt";
  order: "asc" | "desc";
}) {
  const { orders: rawOrders, pagination } = await getOrders(options);

  const locationIds = [
    ...new Set(
      rawOrders
        .flatMap((order) => [order.city, order.zone, order.area])
        .filter(Boolean) as string[],
    ),
  ];

  const locationMap = new Map<string, string>();
  if (locationIds.length > 0) {
    const locationResults = await db
      .select({
        id: deliveryLocations.id,
        name: deliveryLocations.name,
      })
      .from(deliveryLocations)
      .where(
        and(
          inArray(deliveryLocations.id, locationIds),
          isNull(deliveryLocations.deletedAt),
        ),
      );

    locationResults.forEach((location) => {
      locationMap.set(location.id, location.name);
    });
  }

  const ordersWithLocations = rawOrders.map((order) => {
    const cityId = order.city ?? "";
    const zoneId = order.zone ?? "";

    return {
      ...order,
      createdAt:
        order.createdAt instanceof Date
          ? order.createdAt
          : new Date(order.createdAt),
      updatedAt:
        order.updatedAt instanceof Date
          ? order.updatedAt
          : new Date(order.updatedAt),
      cityName: order.cityName ?? locationMap.get(cityId) ?? cityId,
      zoneName: order.zoneName ?? locationMap.get(zoneId) ?? zoneId,
      areaName:
        order.areaName ??
        (order.area ? locationMap.get(order.area) ?? order.area : null),
      city: cityId,
      zone: zoneId,
    };
  });

  return { orders: ordersWithLocations, pagination };
}

export async function getOrderFormProducts() {
  const allProducts = await db
    .select({
      id: products.id,
      name: products.name,
      price: products.price,
      discountPercentage: products.discountPercentage,
    })
    .from(products)
    .where(isNull(products.deletedAt));

  const productVariantsMap = new Map<string, any[]>();
  for (const product of allProducts) {
    const variants = await db
      .select()
      .from(productVariants)
      .where(
        sql`${productVariants.productId} = ${product.id} AND ${productVariants.deletedAt} IS NULL`,
      );
    productVariantsMap.set(product.id, variants);
  }

  return allProducts.map((product) => ({
    ...product,
    variants: productVariantsMap.get(product.id) || [],
  }));
}

export async function getOrderViewData(id: string) {
  const [order] = await db
    .select({
      id: orders.id,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      customerEmail: orders.customerEmail,
      customerId: orders.customerId,
      shippingAddress: orders.shippingAddress,
      totalAmount: orders.totalAmount,
      shippingCharge: orders.shippingCharge,
      discountAmount: orders.discountAmount,
      notes: orders.notes,
      city: orders.city,
      zone: orders.zone,
      area: orders.area,
      cityName: orders.cityName,
      zoneName: orders.zoneName,
      areaName: orders.areaName,
      status: orders.status,
      paymentMethod: orders.paymentMethod,
      paymentStatus: orders.paymentStatus,
      paidAmount: orders.paidAmount,
      balanceDue: orders.balanceDue,
      fulfillmentStatus: orders.fulfillmentStatus,
      inventoryPool: orders.inventoryPool,
      createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
      updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`,
    })
    .from(orders)
    .where(eq(orders.id, id));

  if (!order) return null;

  const items = await db
    .select({
      id: orderItems.id,
      productId: orderItems.productId,
      variantId: orderItems.variantId,
      quantity: orderItems.quantity,
      price: orderItems.price,
      productName: products.name,
      productImage: sql<string>`(
        SELECT ${productImages.url}
        FROM ${productImages}
        WHERE ${productImages.productId} = ${products.id}
        AND ${productImages.isPrimary} = 1
        LIMIT 1
      )`.as("productImage"),
      variantSize: productVariants.size,
      variantColor: productVariants.color,
    })
    .from(orderItems)
    .leftJoin(products, eq(products.id, orderItems.productId))
    .leftJoin(productVariants, eq(productVariants.id, orderItems.variantId))
    .where(eq(orderItems.orderId, id));

  const totalAmount = items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0,
  );

  const locationIds = [order.city, order.zone, order.area].filter(
    Boolean,
  ) as string[];
  const locationMap = new Map<string, string>();

  if (locationIds.length > 0) {
    const locations = await db
      .select()
      .from(deliveryLocations)
      .where(
        and(
          sql`${deliveryLocations.id} IN (${locationIds.join(",")})`,
          isNull(deliveryLocations.deletedAt),
        ),
      );

    locations.forEach((location) => {
      locationMap.set(location.id, location.name);
    });
  }

  const cityName =
    order.cityName || (order.city ? locationMap.get(order.city) || order.city : "");
  const zoneName =
    order.zoneName || (order.zone ? locationMap.get(order.zone) || order.zone : "");
  const areaName =
    order.areaName || (order.area ? locationMap.get(order.area) || order.area : null);

  return {
    order,
    items,
    totalAmount,
    cityName,
    zoneName,
    areaName,
  };
}

export async function getOrderEditData(id: string) {
  const [order] = await db
    .select({
      id: orders.id,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      customerEmail: orders.customerEmail,
      shippingAddress: orders.shippingAddress,
      city: orders.city,
      zone: orders.zone,
      area: orders.area,
      notes: orders.notes,
      discountAmount: orders.discountAmount,
      shippingCharge: orders.shippingCharge,
      status: orders.status,
      createdAt: sql<string>`datetime(${orders.createdAt}, 'unixepoch', 'localtime')`,
      updatedAt: sql<string>`datetime(${orders.updatedAt}, 'unixepoch', 'localtime')`,
    })
    .from(orders)
    .where(eq(orders.id, id));

  if (!order) return null;

  const [items, productsWithVariants] = await Promise.all([
    db
      .select({
        id: orderItems.id,
        productId: orderItems.productId,
        variantId: orderItems.variantId,
        quantity: orderItems.quantity,
        price: orderItems.price,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, id)),
    getOrderFormProducts(),
  ]);

  return {
    order,
    productsWithVariants,
    defaultValues: {
      ...order,
      discountAmount: order.discountAmount || null,
      items: items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
        price: item.price,
      })),
    },
  };
}
