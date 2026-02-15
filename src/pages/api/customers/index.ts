import type { APIRoute } from "astro";
import { db } from "../../../db";
import {
  customers,
  customerHistory,
  deliveryLocations,
} from "../../../db/schema";
import { nanoid } from "nanoid";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { phoneNumberSchema } from "../../../lib/customer-utils";

const createCustomerSchema = z.object({
  name: z
    .string()
    .min(3, "Name must be at least 3 characters")
    .max(100, "Name must be less than 100 characters"),
  email: z.string().email().nullable(),
  phone: phoneNumberSchema,
  address: z
    .string()
    .max(500, "Address must be less than 500 characters")
    .nullable(),
  city: z.string().nullable(),
  zone: z.string().nullable(),
  area: z.string().nullable(),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = createCustomerSchema.parse(json);

    // Check if customer with phone exists
    const existingCustomer = await db
      .select({ id: customers.id })
      .from(customers)
      .where(sql`${customers.phone} = ${data.phone}`)
      .get();

    if (existingCustomer) {
      return new Response(
        JSON.stringify({
          error: "Customer with this phone number already exists",
        }),
        { status: 400 },
      );
    }

    // Get location names from the delivery_locations table in a single query
    let cityName = null;
    let zoneName = null;
    let areaName = null;

    const locationIds = [data.city, data.zone, data.area].filter(Boolean) as string[];
    if (locationIds.length > 0) {
      const locations = await db
        .select({ id: deliveryLocations.id, name: deliveryLocations.name })
        .from(deliveryLocations)
        .where(sql`${deliveryLocations.id} IN ${locationIds}`);

      const locationMap = new Map(locations.map((l) => [l.id, l.name]));
      if (data.city) cityName = locationMap.get(data.city) ?? null;
      if (data.zone) zoneName = locationMap.get(data.zone) ?? null;
      if (data.area) areaName = locationMap.get(data.area) ?? null;
    }

    // Create customer
    const customerId = "cust_" + nanoid();
    const [customer] = await db
      .insert(customers)
      .values({
        id: customerId,
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
        totalOrders: 0,
        totalSpent: 0,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      })
      .returning();

    // Record history
    await db.insert(customerHistory).values({
      id: "hist_" + nanoid(),
      customerId: customerId,
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
      changeType: "created",
      createdAt: sql`unixepoch()`,
    });

    return new Response(JSON.stringify({ id: customer.id }), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error creating customer:", error);

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
