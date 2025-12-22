import type { APIRoute } from "astro";
import { db } from "../../../db";
import {
  customers,
  customerHistory,
  orders,
  deliveryLocations,
} from "../../../db/schema";
import { sql, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

export const POST: APIRoute = async () => {
  try {
    // First, find all orders without customer IDs
    const orphanedOrders = await db
      .select({
        phone: orders.customerPhone,
        name: orders.customerName,
        email: orders.customerEmail,
        address: orders.shippingAddress,
        city: orders.city,
        zone: orders.zone,
        area: orders.area,
        cityName: orders.cityName,
        zoneName: orders.zoneName,
        areaName: orders.areaName,
        totalAmount: sql<number>`CAST(SUM(${orders.totalAmount}) AS INTEGER)`,
        orderCount: sql<number>`CAST(COUNT(*) AS INTEGER)`,
        lastOrderAt: sql<number>`CAST(MAX(${orders.createdAt}) AS INTEGER)`,
      })
      .from(orders)
      .where(sql`${orders.customerId} IS NULL`)
      .groupBy(
        orders.customerPhone,
        orders.customerName,
        orders.customerEmail,
        orders.shippingAddress,
        orders.city,
        orders.zone,
        orders.area,
      );

    // Create customers for orphaned orders
    for (const orderGroup of orphanedOrders) {
      // Check if customer exists by phone
      const existingCustomer = await db
        .select()
        .from(customers)
        .where(eq(customers.phone, orderGroup.phone))
        .get();

      // Get location names if they're not already in the order
      let cityName = orderGroup.cityName;
      let zoneName = orderGroup.zoneName;
      let areaName = orderGroup.areaName;

      if (orderGroup.city && !cityName) {
        const cityResult = await db
          .select({ name: deliveryLocations.name })
          .from(deliveryLocations)
          .where(sql`${deliveryLocations.id} = ${orderGroup.city}`)
          .get();
        if (cityResult) cityName = cityResult.name;
      }

      if (orderGroup.zone && !zoneName) {
        const zoneResult = await db
          .select({ name: deliveryLocations.name })
          .from(deliveryLocations)
          .where(sql`${deliveryLocations.id} = ${orderGroup.zone}`)
          .get();
        if (zoneResult) zoneName = zoneResult.name;
      }

      if (orderGroup.area && !areaName) {
        const areaResult = await db
          .select({ name: deliveryLocations.name })
          .from(deliveryLocations)
          .where(sql`${deliveryLocations.id} = ${orderGroup.area}`)
          .get();
        if (areaResult) areaName = areaResult.name;
      }

      if (!existingCustomer) {
        // Create new customer
        const customerId = "cust_" + nanoid();
        await db.insert(customers).values({
          id: customerId,
          name: orderGroup.name,
          phone: orderGroup.phone,
          email: orderGroup.email,
          address: orderGroup.address,
          city: orderGroup.city,
          zone: orderGroup.zone,
          area: orderGroup.area,
          cityName,
          zoneName,
          areaName,
          totalOrders: Number(orderGroup.orderCount),
          totalSpent: Number(orderGroup.totalAmount),
          lastOrderAt: sql`${orderGroup.lastOrderAt}`,
          createdAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
          deletedAt: null,
        });

        // Record creation in history
        await db.insert(customerHistory).values({
          id: "hist_" + nanoid(),
          customerId: customerId,
          name: orderGroup.name,
          email: orderGroup.email,
          phone: orderGroup.phone,
          address: orderGroup.address,
          city: orderGroup.city,
          zone: orderGroup.zone,
          area: orderGroup.area,
          cityName,
          zoneName,
          areaName,
          changeType: "created",
          createdAt: sql`unixepoch()`,
        });

        // Update orders with new customer ID
        await db
          .update(orders)
          .set({ customerId })
          .where(eq(orders.customerPhone, orderGroup.phone));
      } else {
        // Update orders with existing customer ID
        await db
          .update(orders)
          .set({ customerId: existingCustomer.id })
          .where(eq(orders.customerPhone, orderGroup.phone));
      }
    }

    // Update stats for all customers
    const allCustomers = await db.select().from(customers);
    for (const customer of allCustomers) {
      const customerOrders = await db
        .select({
          totalAmount: orders.totalAmount,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .where(eq(orders.customerId, customer.id));

      const stats = {
        totalOrders: customerOrders.length,
        totalSpent: customerOrders.reduce(
          (sum, order) => sum + order.totalAmount,
          0,
        ),
        lastOrderAt:
          customerOrders.length > 0
            ? Math.max(...customerOrders.map((o) => Number(o.createdAt)))
            : null,
      };

      await db
        .update(customers)
        .set({
          totalOrders: stats.totalOrders,
          totalSpent: stats.totalSpent,
          lastOrderAt: stats.lastOrderAt ? sql`${stats.lastOrderAt}` : null,
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(customers.id, customer.id));
    }

    return new Response(
      JSON.stringify({
        message: "Sync completed successfully",
        details: {
          newCustomers: orphanedOrders.length,
          updatedCustomers: allCustomers.length,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error syncing customer data:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to sync customer data",
        details: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500 },
    );
  }
};
