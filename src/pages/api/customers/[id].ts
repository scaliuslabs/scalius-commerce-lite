import type { APIRoute } from "astro";
import { db } from "../../../db";
import {
  customers,
  customerHistory,
  deliveryLocations,
} from "../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { nanoid } from "nanoid";
import { orders } from "../../../db/schema";

const updateCustomerSchema = z.object({
  name: z
    .string()
    .min(3, "Name must be at least 3 characters")
    .max(100, "Name must be less than 100 characters"),
  email: z.string().email().nullable(),
  phone: z
    .string()
    .min(11, "Phone number must be at least 11 characters")
    .max(14, "Phone number must be less than 14 characters"),
  address: z
    .string()
    .max(500, "Address must be less than 500 characters")
    .nullable(),
  city: z.string().nullable(),
  zone: z.string().nullable(),
  area: z.string().nullable(),
});

export const PUT: APIRoute = async ({ request, params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({
          error: "Customer ID is required",
        }),
        { status: 400 },
      );
    }

    const json = await request.json();
    const data = updateCustomerSchema.parse(json);

    // Check if customer exists
    const existingCustomer = await db
      .select()
      .from(customers)
      .where(sql`${customers.id} = ${id} AND ${customers.deletedAt} IS NULL`)
      .get();

    if (!existingCustomer) {
      return new Response(
        JSON.stringify({
          error: "Customer not found",
        }),
        { status: 404 },
      );
    }

    // Check if phone number is being changed and if it's already taken
    if (data.phone !== existingCustomer.phone) {
      const phoneExists = await db
        .select({ id: customers.id })
        .from(customers)
        .where(
          sql`${customers.phone} = ${data.phone} AND ${customers.id} != ${id}`,
        )
        .get();

      if (phoneExists) {
        return new Response(
          JSON.stringify({
            error: "Phone number is already taken by another customer",
          }),
          { status: 400 },
        );
      }
    }

    // Get location names from the delivery_locations table
    let cityName = null;
    let zoneName = null;
    let areaName = null;

    if (data.city) {
      const cityResult = await db
        .select({ name: deliveryLocations.name })
        .from(deliveryLocations)
        .where(sql`${deliveryLocations.id} = ${data.city}`)
        .get();
      if (cityResult) cityName = cityResult.name;
    }

    if (data.zone) {
      const zoneResult = await db
        .select({ name: deliveryLocations.name })
        .from(deliveryLocations)
        .where(sql`${deliveryLocations.id} = ${data.zone}`)
        .get();
      if (zoneResult) zoneName = zoneResult.name;
    }

    if (data.area) {
      const areaResult = await db
        .select({ name: deliveryLocations.name })
        .from(deliveryLocations)
        .where(sql`${deliveryLocations.id} = ${data.area}`)
        .get();
      if (areaResult) areaName = areaResult.name;
    }

    // Update customer
    const [customer] = await db
      .update(customers)
      .set({
        name: data.name,
        email: data.email,
        phone: data.phone,
        address: data.address,
        city: data.city,
        zone: data.zone,
        area: data.area,
        cityName,
        zoneName,
        areaName,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(customers.id, id))
      .returning();

    // Record history
    await db.insert(customerHistory).values({
      id: "hist_" + nanoid(),
      customerId: id,
      name: data.name,
      email: data.email,
      phone: data.phone,
      address: data.address,
      city: data.city,
      zone: data.zone,
      area: data.area,
      cityName,
      zoneName,
      areaName,
      changeType: "updated",
      createdAt: sql`unixepoch()`,
    });

    return new Response(JSON.stringify(customer), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error updating customer:", error);

    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid customer data",
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

export const DELETE: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({
          error: "Customer ID is required",
        }),
        { status: 400 },
      );
    }

    // Check if customer exists and get their order count
    const customer = await db
      .select({
        id: customers.id,
        name: customers.name,
        email: customers.email,
        phone: customers.phone,
        address: customers.address,
        city: customers.city,
        zone: customers.zone,
        area: customers.area,
        cityName: customers.cityName,
        zoneName: customers.zoneName,
        areaName: customers.areaName,
        totalOrders: customers.totalOrders,
      })
      .from(customers)
      .where(sql`${customers.id} = ${id} AND ${customers.deletedAt} IS NULL`)
      .get();

    if (!customer) {
      return new Response(
        JSON.stringify({
          error: "Customer not found",
        }),
        { status: 404 },
      );
    }

    // Get associated orders
    const customerOrders = await db
      .select({
        id: orders.id,
        status: orders.status,
      })
      .from(orders)
      .where(eq(orders.customerId, id));

    // Check if there are any non-completed orders
    const hasActiveOrders = customerOrders.some(
      (order) => !["delivered", "cancelled", "returned"].includes(order.status),
    );

    if (hasActiveOrders) {
      return new Response(
        JSON.stringify({
          error:
            "Cannot delete customer with active orders. Please complete or cancel all orders first.",
          details: {
            totalOrders: customerOrders.length,
            activeOrders: customerOrders.filter(
              (order) =>
                !["delivered", "cancelled", "returned"].includes(order.status),
            ).length,
          },
        }),
        { status: 400 },
      );
    }

    // Record deletion in history
    await db.insert(customerHistory).values({
      id: "hist_" + nanoid(),
      customerId: id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      address: customer.address,
      city: customer.city,
      zone: customer.zone,
      area: customer.area,
      cityName: customer.cityName,
      zoneName: customer.zoneName,
      areaName: customer.areaName,
      changeType: "deleted",
      createdAt: sql`unixepoch()`,
    });

    // Soft delete the customer
    await db
      .update(customers)
      .set({
        deletedAt: sql`unixepoch()`,
      })
      .where(eq(customers.id, id));

    return new Response(
      JSON.stringify({
        message: "Customer moved to trash",
        details: {
          totalOrders: customerOrders.length,
          name: customer.name,
          phone: customer.phone,
        },
      }),
      { status: 200 },
    );
  } catch (error) {
    console.error("Error deleting customer:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};
