import type { APIRoute } from "astro";
import { db } from "../../../db";
import {
  orders,
  orderItems,
  customers,
  customerHistory,
  productVariants,
  deliveryLocations,
} from "../../../db/schema";
import { sql, eq, and, isNull } from "drizzle-orm";
import { z } from "zod";
import { generateOrderId } from "../../../lib/order-utils";
import {
  phoneNumberSchema,
  calculateCustomerStats,
} from "../../../lib/customer-utils";
import { nanoid } from "nanoid";
import { getOrders } from "../../../lib/admin";

const createOrderSchema = z.object({
  customerName: z
    .string()
    .min(3, "Customer name must be at least 3 characters")
    .max(100, "Customer name must be less than 100 characters"),
  customerPhone: phoneNumberSchema,
  customerEmail: z.string().email().nullable(),
  shippingAddress: z
    .string()
    .min(10, "Address must be at least 10 characters")
    .max(500, "Address must be less than 500 characters"),
  city: z.string().min(1, "City is required"),
  zone: z.string().min(1, "Zone is required"),
  area: z.string().nullable(),
  cityName: z.string().optional(),
  zoneName: z.string().optional(),
  areaName: z.string().nullable().optional(),
  notes: z
    .string()
    .max(500, "Notes must be less than 500 characters")
    .nullable(),
  items: z.array(
    z.object({
      productId: z.string().min(1, "Product is required"),
      variantId: z.string().nullable(),
      quantity: z.number().min(1, "Quantity must be at least 1"),
      price: z.number().min(0, "Price must be greater than or equal to 0"),
    }),
  ),
  discountAmount: z
    .number()
    .min(0, "Discount must be greater than or equal to 0")
    .nullable(),
  shippingCharge: z
    .number()
    .min(0, "Shipping charge must be greater than or equal to 0"),
});

export const GET: APIRoute = async ({ url }) => {
  try {
    const searchParams = url.searchParams;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
    const search = searchParams.get("search") || "";
    const status = searchParams.get("status") || undefined;
    const showTrashed = searchParams.get("trashed") === "true";
    const sort = (searchParams.get("sort") || "updatedAt") as
      | "customerName"
      | "totalAmount"
      | "status"
      | "createdAt"
      | "updatedAt";
    const order = (searchParams.get("order") || "desc") as "asc" | "desc";
    const startDateParam = searchParams.get("startDate");
    const endDateParam = searchParams.get("endDate");

    const startDate = startDateParam ? new Date(startDateParam) : undefined;
    const endDate = endDateParam ? new Date(endDateParam) : undefined;

    // Get orders with proper sorting and trash handling
    const { orders: fetchedOrders, pagination } = await getOrders({
      page,
      search,
      status,
      sort,
      order,
      showTrashed,
      limit,
      startDate,
      endDate,
    });

    // Get all unique location IDs from the orders to fetch their names in one go
    const locationIds = [
      ...new Set(
        fetchedOrders
          .flatMap((order) => [order.city, order.zone, order.area])
          .filter(Boolean) as string[],
      ),
    ];

    const locationMap = new Map<string, string>();

    if (locationIds.length > 0) {
      // Get all locations that match the IDs
      const locationResults = await db
        .select({
          id: deliveryLocations.id,
          name: deliveryLocations.name,
        })
        .from(deliveryLocations)
        .where(
          and(
            sql`${deliveryLocations.id} IN (${locationIds.join(",")})`,
            isNull(deliveryLocations.deletedAt),
          ),
        );

      // Create a map of ID to location name
      locationResults.forEach((location) => {
        locationMap.set(location.id, location.name);
      });
    }

    // Ensure all dates are properly instantiated and enrich orders with location names
    const formattedOrders = fetchedOrders.map((order) => {
      const cityId = order.city ?? "";
      const zoneId = order.zone ?? "";

      return {
        ...order,
        createdAt:
          order.createdAt instanceof Date
            ? order.createdAt.toISOString()
            : new Date(order.createdAt).toISOString(),
        updatedAt:
          order.updatedAt instanceof Date
            ? order.updatedAt.toISOString()
            : new Date(order.updatedAt).toISOString(),

        // Provide safe fallbacks to ensure type correctness.
        cityName: order.cityName ?? locationMap.get(cityId) ?? cityId,
        zoneName: order.zoneName ?? locationMap.get(zoneId) ?? zoneId,
        areaName:
          order.areaName ??
          (order.area ? (locationMap.get(order.area) ?? order.area) : null),

        // Ensure city and zone are not null for type safety
        city: cityId,
        zone: zoneId,

        // Convert latestShipment dates if present
        latestShipment: order.latestShipment
          ? {
              ...order.latestShipment,
              lastChecked:
                order.latestShipment.lastChecked instanceof Date
                  ? order.latestShipment.lastChecked.toISOString()
                  : order.latestShipment.lastChecked,
            }
          : null,
      };
    });

    return new Response(
      JSON.stringify({ orders: formattedOrders, pagination }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Error fetching orders:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to fetch orders",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();

    console.log("Order submission data:", {
      city: json.city,
      cityName: json.cityName,
      zone: json.zone,
      zoneName: json.zoneName,
      area: json.area,
      areaName: json.areaName,
    });

    const data = createOrderSchema.parse(json);

    // Calculate total amount
    const totalAmount =
      data.items.reduce((sum, item) => sum + item.price * item.quantity, 0) +
      data.shippingCharge -
      (data.discountAmount || 0);

    // First, check and update stock for all variants
    for (const item of data.items) {
      if (item.variantId) {
        const variant = await db
          .select()
          .from(productVariants)
          .where(
            and(
              eq(productVariants.id, item.variantId),
              isNull(productVariants.deletedAt),
            ),
          )
          .get();

        if (!variant) {
          throw new Error(`Variant ${item.variantId} not found`);
        }

        if (variant.stock < item.quantity) {
          throw new Error(
            `Insufficient stock for variant ${item.variantId}. Available: ${variant.stock}, Requested: ${item.quantity}`,
          );
        }

        // Update variant stock
        await db
          .update(productVariants)
          .set({
            stock: sql`${productVariants.stock} - ${item.quantity}`,
            updatedAt: sql`unixepoch()`,
          })
          .where(eq(productVariants.id, item.variantId));
      }
    }

    // Get or create customer
    const existingCustomer = await db
      .select()
      .from(customers)
      .where(eq(customers.phone, data.customerPhone))
      .get();

    let customerId = existingCustomer?.id;

    // Get location names for the selected locations
    const locationIds = [data.city, data.zone, data.area].filter(Boolean);
    const locationResults = await db
      .select()
      .from(deliveryLocations)
      .where(
        and(
          sql`${deliveryLocations.id} IN (${locationIds.join(",")})`,
          isNull(deliveryLocations.deletedAt),
        ),
      );

    // Create a map of location IDs to names
    const locationMap = new Map();
    locationResults.forEach((location) => {
      locationMap.set(location.id, location.name);
    });

    // Get the names for the locations, falling back to provided names or IDs as last resort
    const cityName =
      data.cityName ||
      (data.city ? locationMap.get(data.city) || data.city : "");
    const zoneName =
      data.zoneName ||
      (data.zone ? locationMap.get(data.zone) || data.zone : "");
    const areaName =
      data.areaName || (data.area ? locationMap.get(data.area) || null : null);

    console.log("Using location names:", { cityName, zoneName, areaName });

    if (!existingCustomer) {
      // Create new customer
      const [newCustomer] = await db
        .insert(customers)
        .values({
          id: "cust_" + nanoid(),
          name: data.customerName,
          phone: data.customerPhone,
          email: data.customerEmail,
          address: data.shippingAddress,
          city: data.city,
          zone: data.zone,
          area: data.area,
          totalOrders: 1,
          totalSpent: totalAmount,
          lastOrderAt: sql`unixepoch()`,
          createdAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
        })
        .returning();

      customerId = newCustomer.id;

      // Record initial history
      await db.insert(customerHistory).values({
        id: "hist_" + nanoid(),
        customerId: customerId,
        name: data.customerName,
        email: data.customerEmail,
        phone: data.customerPhone,
        address: data.shippingAddress,
        city: data.city,
        zone: data.zone,
        area: data.area,
        changeType: "created",
        createdAt: sql`unixepoch()`,
      });
    } else {
      // Get all orders for this customer to calculate stats
      const customerOrders = await db
        .select({
          totalAmount: orders.totalAmount,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .where(eq(orders.customerId, existingCustomer.id));

      // Add current order to stats calculation
      const allOrders = [
        ...customerOrders,
        { totalAmount, createdAt: Math.floor(Date.now() / 1000) },
      ];

      const stats = calculateCustomerStats(allOrders);

      // Update customer stats
      await db
        .update(customers)
        .set({
          totalOrders: stats.totalOrders,
          totalSpent: stats.totalSpent,
          lastOrderAt: stats.lastOrderAt
            ? sql`${Math.floor(stats.lastOrderAt.getTime() / 1000)}`
            : null,
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(customers.id, existingCustomer.id));

      // Record update in history
      await db.insert(customerHistory).values({
        id: "hist_" + nanoid(),
        customerId: existingCustomer.id,
        name: data.customerName,
        email: data.customerEmail,
        phone: data.customerPhone,
        address: data.shippingAddress,
        city: data.city,
        zone: data.zone,
        area: data.area,
        changeType: "updated",
        createdAt: sql`unixepoch()`,
      });
    }

    // Create order with readable ID and proper timestamp
    const [order] = await db
      .insert(orders)
      .values({
        id: generateOrderId(),
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        customerEmail: data.customerEmail,
        shippingAddress: data.shippingAddress,
        city: data.city,
        zone: data.zone,
        area: data.area,
        cityName,
        zoneName,
        areaName,
        notes: data.notes,
        totalAmount,
        shippingCharge: data.shippingCharge,
        discountAmount: data.discountAmount,
        status: "pending",
        customerId,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      })
      .returning();

    // Create order items with readable IDs
    if (data.items.length > 0) {
      await db.insert(orderItems).values(
        data.items.map((item) => ({
          id: generateOrderId(),
          orderId: order.id,
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          price: item.price,
          createdAt: sql`unixepoch()`,
        })),
      );
    }

    return new Response(JSON.stringify({ id: order.id }), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error creating order:", error);

    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid order data",
          details: error.errors,
        }),
        { status: 400 },
      );
    }

    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};
