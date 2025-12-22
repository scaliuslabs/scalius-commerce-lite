import type { APIRoute } from "astro";
import { db } from "../../../db";
import {
  orders,
  orderItems,
  customers,
  productVariants,
  deliveryLocations,
} from "../../../db/schema";
import { eq, sql, and, isNull } from "drizzle-orm";
import { z } from "zod";
import { nanoid } from "nanoid";
import {
  phoneNumberSchema,
  calculateCustomerStats,
} from "../../../lib/customer-utils";

const updateOrderSchema = z.object({
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
  status: z.string().min(1, "Status is required"),
});

export const PUT: APIRoute = async ({ request, params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({
          error: "Order ID is required",
        }),
        { status: 400 },
      );
    }

    const json = await request.json();
    const data = updateOrderSchema.parse(json);

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

    console.log("Using location names in update:", {
      cityName,
      zoneName,
      areaName,
    });

    // Get existing order with its items
    const existingOrder = await db
      .select({
        id: orders.id,
        customerId: orders.customerId,
        customerPhone: orders.customerPhone,
      })
      .from(orders)
      .where(sql`${orders.id} = ${id} AND ${orders.deletedAt} IS NULL`)
      .get();

    if (!existingOrder) {
      return new Response(
        JSON.stringify({
          error: "Order not found",
        }),
        { status: 404 },
      );
    }

    // Get existing order items to compare with new items
    const existingItems = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, id));

    // First, restore stock for removed/modified items
    for (const existingItem of existingItems) {
      if (existingItem.variantId) {
        const matchingNewItem = data.items.find(
          (item) =>
            item.variantId === existingItem.variantId &&
            item.quantity === existingItem.quantity,
        );

        if (!matchingNewItem) {
          // Item was removed or quantity changed, restore stock
          await db
            .update(productVariants)
            .set({
              stock: sql`${productVariants.stock} + ${existingItem.quantity}`,
              updatedAt: sql`unixepoch()`,
            })
            .where(eq(productVariants.id, existingItem.variantId));
        }
      }
    }

    // Then, check and update stock for new/modified items
    for (const item of data.items) {
      if (item.variantId) {
        const existingItem = existingItems.find(
          (ei) => ei.variantId === item.variantId,
        );
        const quantityDiff = existingItem
          ? item.quantity - existingItem.quantity
          : item.quantity;

        if (quantityDiff !== 0) {
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

          if (variant.stock < quantityDiff) {
            throw new Error(
              `Insufficient stock for variant ${item.variantId}. Available: ${variant.stock}, Additional Requested: ${quantityDiff}`,
            );
          }

          // Update variant stock
          await db
            .update(productVariants)
            .set({
              stock: variant.stock - quantityDiff,
              updatedAt: sql`unixepoch()`,
            })
            .where(eq(productVariants.id, item.variantId));
        }
      }
    }

    // Calculate total amount
    const totalAmount =
      data.items.reduce((sum, item) => sum + item.price * item.quantity, 0) +
      data.shippingCharge -
      (data.discountAmount || 0);

    // Handle customer association
    let customerId = existingOrder.customerId;

    // If phone number changed, we need to handle customer association
    if (data.customerPhone !== existingOrder.customerPhone) {
      // Look for customer with new phone number
      const customer = await db
        .select()
        .from(customers)
        .where(eq(customers.phone, data.customerPhone))
        .get();

      if (customer) {
        customerId = customer.id;
      } else {
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
      }
    }

    // Update order
    const [order] = await db
      .update(orders)
      .set({
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
        status: data.status,
        customerId,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(orders.id, id))
      .returning();

    // Delete existing order items
    await db.delete(orderItems).where(eq(orderItems.orderId, id));

    // Create new order items
    if (data.items.length > 0) {
      await db.insert(orderItems).values(
        data.items.map((item) => ({
          id: "item_" + nanoid(),
          orderId: order.id,
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          price: item.price,
          createdAt: sql`unixepoch()`,
        })),
      );
    }

    // Update customer stats for both old and new customer if changed
    if (existingOrder.customerId) {
      await updateCustomerStats(existingOrder.customerId);
    }
    if (customerId && customerId !== existingOrder.customerId) {
      await updateCustomerStats(customerId);
    }

    return new Response(JSON.stringify({ id: order.id }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error updating order:", error);

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

async function updateCustomerStats(customerId: string) {
  const customerOrders = await db
    .select({
      totalAmount: orders.totalAmount,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(eq(orders.customerId, customerId));

  const stats = calculateCustomerStats(customerOrders);

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
    .where(eq(customers.id, customerId));
}

export const DELETE: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({
          error: "Order ID is required",
        }),
        { status: 400 },
      );
    }

    // Check if order exists and get its items
    const existingOrder = await db
      .select({ id: orders.id })
      .from(orders)
      .where(sql`${orders.id} = ${id} AND ${orders.deletedAt} IS NULL`)
      .get();

    if (!existingOrder) {
      return new Response(
        JSON.stringify({
          error: "Order not found",
        }),
        { status: 404 },
      );
    }

    // Get order items to restore stock
    const items = await db
      .select({
        variantId: orderItems.variantId,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, id));

    // Restore stock for all variants in the order
    for (const item of items) {
      if (item.variantId) {
        // Update variant stock
        await db
          .update(productVariants)
          .set({
            stock: sql`${productVariants.stock} + ${item.quantity}`,
            updatedAt: sql`unixepoch()`,
          })
          .where(eq(productVariants.id, item.variantId));
      }
    }

    // Soft delete the order
    await db
      .update(orders)
      .set({
        deletedAt: sql`unixepoch()`,
      })
      .where(eq(orders.id, id));

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error deleting order:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};
