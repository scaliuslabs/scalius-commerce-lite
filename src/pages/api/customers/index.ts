import type { APIRoute } from "astro";
import { db } from "../../../db";
import {
  customers,
  customerHistory,
  deliveryLocations,
  orders,
} from "../../../db/schema";
import { nanoid } from "nanoid";
import { sql, and, isNull, inArray, asc, desc } from "drizzle-orm";
import { z } from "zod";
import { phoneNumberSchema } from "../../../lib/customer-utils";
import { ftsMatch } from "@/lib/search/fts5";

export const GET: APIRoute = async ({ url }) => {
  try {
    const searchParams = url.searchParams;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
    const search = searchParams.get("search") || "";
    const showTrashed = searchParams.get("trashed") === "true";
    const sort = (searchParams.get("sort") || "updatedAt") as
      | "name"
      | "totalOrders"
      | "totalSpent"
      | "lastOrderAt"
      | "createdAt"
      | "updatedAt";
    const order = (searchParams.get("order") || "desc") as "asc" | "desc";

    const whereConditions = [];
    if (showTrashed) {
      whereConditions.push(sql`${customers.deletedAt} IS NOT NULL`);
    } else {
      whereConditions.push(sql`${customers.deletedAt} IS NULL`);
    }
    if (search) {
      const cond = ftsMatch("customers_fts", "customers", search);
      if (cond) whereConditions.push(cond);
    }

    const whereClause =
      whereConditions.length > 0
        ? sql`${sql.join(whereConditions, sql` AND `)}`
        : undefined;

    const offset = (page - 1) * limit;

    const orderCustomers = await db
      .select({
        phone: orders.customerPhone,
        name: orders.customerName,
        email: orders.customerEmail,
        totalAmount: sql<number>`CAST(SUM(${orders.totalAmount}) AS INTEGER)`,
        orderCount: sql<number>`CAST(COUNT(*) AS INTEGER)`,
        lastOrderAt: sql<number>`CAST(MAX(${orders.createdAt}) AS INTEGER)`,
      })
      .from(orders)
      .where(sql`${orders.customerId} IS NULL`)
      .groupBy(orders.customerPhone, orders.customerName, orders.customerEmail);

    if (orderCustomers.length > 0) {
      const phones = [
        ...new Set(orderCustomers.map((c) => c.phone).filter(Boolean)),
      ] as string[];
      const existingCustomers = await db
        .select({ phone: customers.phone })
        .from(customers)
        .where(inArray(customers.phone, phones));
      const existingPhoneSet = new Set(existingCustomers.map((c) => c.phone));
      const newCustomersToInsert = orderCustomers
        .filter((c) => c.phone && !existingPhoneSet.has(c.phone))
        .map((customer) => ({
          id: "cust_" + nanoid(),
          name: customer.name ?? "Unknown",
          phone: customer.phone,
          email: customer.email,
          address: null,
          city: null,
          zone: null,
          area: null,
          totalOrders: Number(customer.orderCount),
          totalSpent: Number(customer.totalAmount),
          lastOrderAt: customer.lastOrderAt
            ? sql`CAST(${customer.lastOrderAt} AS INTEGER)`
            : null,
          createdAt: sql`CAST(strftime('%s','now') AS INTEGER)`,
          updatedAt: sql`CAST(strftime('%s','now') AS INTEGER)`,
          deletedAt: null,
        }));
      if (newCustomersToInsert.length > 0) {
        await db.insert(customers).values(newCustomersToInsert);
      }
    }

    const sortField = (() => {
      switch (sort) {
        case "name":
          return customers.name;
        case "totalOrders":
          return customers.totalOrders;
        case "totalSpent":
          return customers.totalSpent;
        case "lastOrderAt":
          return customers.lastOrderAt;
        case "createdAt":
          return customers.createdAt;
        case "updatedAt":
        default:
          return customers.updatedAt;
      }
    })();
    const orderClause = order === "asc" ? asc(sortField) : desc(sortField);

    const countQuery = db
      .select({ count: sql<number>`count(*)` })
      .from(customers)
      .where(whereClause);

    const resultsQuery = db
      .select({
        id: customers.id,
        name: customers.name,
        email: customers.email,
        phone: customers.phone,
        address: customers.address,
        city: customers.city,
        zone: customers.zone,
        area: customers.area,
        totalOrders: customers.totalOrders,
        totalSpent: customers.totalSpent,
        lastOrderAt: sql<number>`CAST(${customers.lastOrderAt} AS INTEGER)`,
        createdAt: sql<number>`CAST(${customers.createdAt} AS INTEGER)`,
        updatedAt: sql<number>`CAST(${customers.updatedAt} AS INTEGER)`,
      })
      .from(customers)
      .where(whereClause)
      .limit(limit)
      .offset(offset)
      .orderBy(orderClause);

    const [[{ count }], results] = await db.batch([countQuery, resultsQuery]);

    const formattedCustomers = results.map((customer) => ({
      ...customer,
      lastOrderAt: customer.lastOrderAt
        ? new Date(customer.lastOrderAt * 1000).toISOString()
        : null,
      createdAt: new Date(customer.createdAt * 1000).toISOString(),
      updatedAt: new Date(customer.updatedAt * 1000).toISOString(),
    }));

    const allLocationIds = [
      ...new Set(formattedCustomers.flatMap((c) => [c.city, c.zone, c.area]).filter(Boolean)),
    ] as string[];
    let locationMap = new Map<string, string>();
    if (allLocationIds.length > 0) {
      const locationResults = await db
        .select({ id: deliveryLocations.id, name: deliveryLocations.name })
        .from(deliveryLocations)
        .where(
          and(
            inArray(deliveryLocations.id, allLocationIds),
            isNull(deliveryLocations.deletedAt),
          ),
        );
      locationResults.forEach((loc) => locationMap.set(loc.id, loc.name));
    }

    const enhancedCustomers = formattedCustomers.map((customer) => ({
      ...customer,
      cityName: customer.city ? locationMap.get(customer.city) ?? customer.city : null,
      zoneName: customer.zone ? locationMap.get(customer.zone) ?? customer.zone : null,
      areaName: customer.area ? locationMap.get(customer.area) ?? customer.area : null,
    }));

    return new Response(
      JSON.stringify({
        customers: enhancedCustomers,
        pagination: {
          total: count,
          page,
          limit,
          totalPages: Math.ceil(count / limit),
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error fetching customers:", error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch customers" }),
      { status: 500 },
    );
  }
};

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
