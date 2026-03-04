import { db } from "@/db";
import { customers, orders, deliveryLocations, customerHistory } from "@/db/schema";
import { sql, and, isNull, inArray, eq } from "drizzle-orm";
import { ftsMatch } from "@/lib/search/fts5";
import { nanoid } from "nanoid";

export async function getCustomersIndexData(options: {
  page: number;
  limit: number;
  search: string;
  showTrashed: boolean;
  sort:
    | "name"
    | "totalOrders"
    | "totalSpent"
    | "lastOrderAt"
    | "createdAt"
    | "updatedAt";
  order: "asc" | "desc";
}) {
  const { page, limit, search, showTrashed, sort, order } = options;
  const whereConditions: any[] = [];

  if (showTrashed) {
    whereConditions.push(sql`${customers.deletedAt} IS NOT NULL`);
  } else {
    whereConditions.push(sql`${customers.deletedAt} IS NULL`);
  }

  if (search) {
    const cond = ftsMatch("customers_fts", "customers", search);
    if (cond) whereConditions.push(cond);
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(customers)
    .where(
      whereConditions.length > 0
        ? sql`${sql.join(whereConditions, sql` AND `)}`
        : undefined,
    );

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
      ...new Set(orderCustomers.map((customer) => customer.phone).filter(Boolean)),
    ] as string[];

    const existingCustomers = await db
      .select({ phone: customers.phone })
      .from(customers)
      .where(inArray(customers.phone, phones));

    const existingPhoneSet = new Set(existingCustomers.map((customer) => customer.phone));
    const newCustomersToInsert = orderCustomers
      .filter((customer) => customer.phone && !existingPhoneSet.has(customer.phone))
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

  const results = await db
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

        return order === "asc" ? sql`${sortField} asc` : sql`${sortField} desc`;
      })(),
    );

  const formattedCustomers = results.map((customer) => ({
    ...customer,
    lastOrderAt: customer.lastOrderAt ? new Date(customer.lastOrderAt * 1000) : null,
    createdAt: new Date(customer.createdAt * 1000),
    updatedAt: new Date(customer.updatedAt * 1000),
  }));

  const allLocationIds = [
    ...new Set(
      formattedCustomers.flatMap((customer) => [
        customer.city,
        customer.zone,
        customer.area,
      ]),
    ),
  ].filter(Boolean) as string[];

  let locationMap = new Map<string, string>();
  if (allLocationIds.length > 0) {
    try {
      const locationResults = await db
        .select({
          id: deliveryLocations.id,
          name: deliveryLocations.name,
        })
        .from(deliveryLocations)
        .where(
          and(
            inArray(deliveryLocations.id, allLocationIds),
            isNull(deliveryLocations.deletedAt),
          ),
        );
      locationResults.forEach((location) => {
        locationMap.set(location.id, location.name);
      });
    } catch (error) {
      console.error("Error fetching locations:", error);
    }
  }

  const enhancedCustomers = formattedCustomers.map((customer) => ({
    ...customer,
    cityName: customer.city
      ? locationMap.get(customer.city) || customer.city
      : undefined,
    zoneName: customer.zone
      ? locationMap.get(customer.zone) || customer.zone
      : undefined,
    areaName: customer.area
      ? locationMap.get(customer.area) || customer.area
      : undefined,
  }));

  return {
    customers: enhancedCustomers,
    pagination: {
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit),
    },
  };
}

export async function getCustomerEditData(id: string) {
  const [customer] = await db
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
      createdAt: sql<string>`datetime(${customers.createdAt}, 'unixepoch', 'localtime')`,
      updatedAt: sql<string>`datetime(${customers.updatedAt}, 'unixepoch', 'localtime')`,
    })
    .from(customers)
    .where(eq(customers.id, id));

  if (!customer) return null;

  return {
    ...customer,
    cityName: customer.cityName || "",
    zoneName: customer.zoneName || "",
    areaName: customer.areaName || "",
  };
}

export async function getCustomerHistoryData(id: string) {
  const [customerResults, history, customerOrders] = await db.batch([
    db
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
      .where(eq(customers.id, id)),
    db
      .select({
        id: customerHistory.id,
        name: customerHistory.name,
        email: customerHistory.email,
        phone: customerHistory.phone,
        address: customerHistory.address,
        city: customerHistory.city,
        zone: customerHistory.zone,
        area: customerHistory.area,
        cityName: customerHistory.cityName,
        zoneName: customerHistory.zoneName,
        areaName: customerHistory.areaName,
        changeType: customerHistory.changeType,
        createdAt: sql<number>`CAST(${customerHistory.createdAt} AS INTEGER)`,
      })
      .from(customerHistory)
      .where(eq(customerHistory.customerId, id))
      .orderBy(sql`${customerHistory.createdAt} DESC`),
    db
      .select({
        id: orders.id,
        totalAmount: orders.totalAmount,
        status: orders.status,
        createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
      })
      .from(orders)
      .where(eq(orders.customerId, id))
      .orderBy(sql`${orders.createdAt} DESC`),
  ]);

  const customer = customerResults[0];
  if (!customer) return null;

  const formattedCustomer = {
    ...customer,
    lastOrderAt: customer.lastOrderAt ? new Date(customer.lastOrderAt * 1000) : null,
    createdAt: new Date(customer.createdAt * 1000),
    updatedAt: new Date(customer.updatedAt * 1000),
  };

  const formattedHistory = history.map((record) => ({
    ...record,
    createdAt: new Date(record.createdAt * 1000),
  }));

  const formattedOrders = customerOrders.map((order) => ({
    ...order,
    createdAt: new Date(order.createdAt * 1000),
  }));

  const locationIds = new Set<string>();
  if (customer.city) locationIds.add(customer.city);
  if (customer.zone) locationIds.add(customer.zone);
  if (customer.area) locationIds.add(customer.area);

  for (const record of history) {
    if (record.city) locationIds.add(record.city);
    if (record.zone) locationIds.add(record.zone);
    if (record.area) locationIds.add(record.area);
  }

  const locationArray = Array.from(locationIds).filter(Boolean) as string[];
  const locationMap = new Map<string, string>();

  if (locationArray.length > 0) {
    const locations = await db
      .select()
      .from(deliveryLocations)
      .where(
        sql`${deliveryLocations.id} IN (${sql.join(
          locationArray.map((locationId) => sql`${locationId}`),
          sql`, `,
        )}) AND ${deliveryLocations.deletedAt} IS NULL`,
      );

    locations.forEach((location) => {
      locationMap.set(location.id, location.name);
    });
  }

  const enhancedCustomer = {
    ...formattedCustomer,
    cityName: customer.city ? locationMap.get(customer.city) || customer.city : "",
    zoneName: customer.zone ? locationMap.get(customer.zone) || customer.zone : "",
    areaName: customer.area ? locationMap.get(customer.area) || customer.area : null,
  } as any;

  const historyWithLocationNames = formattedHistory.map((record) => ({
    ...record,
    cityName: record.city ? locationMap.get(record.city) || record.city : "",
    zoneName: record.zone ? locationMap.get(record.zone) || record.zone : "",
    areaName: record.area ? locationMap.get(record.area) || record.area : null,
  })) as any[];

  return {
    customer: enhancedCustomer,
    history: historyWithLocationNames,
    orders: formattedOrders,
  };
}
