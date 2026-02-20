import { Hono } from "hono";

import {
  orders,
  orderItems,
  customers,
  customerHistory,
  productVariants,
  deliveryLocations,
  products,
  productImages,
  discountUsage,
  discounts,
  PaymentMethod,
  PaymentStatus,
  FulfillmentStatus,
  InventoryPool,
} from "@/db/schema";
import { eq, sql, and, isNull, desc, asc } from "drizzle-orm";
import { z } from "zod";
import { nanoid } from "nanoid";
import { generateOrderId } from "@/lib/order-utils";
import {
  phoneNumberSchema,
  calculateCustomerStats,
} from "@/lib/customer-utils";
import { DeliveryService } from "@/lib/delivery/service";
import { cacheMiddleware } from "../middleware/cache";
import { reserveMultiple, releaseMultiple } from "@/lib/inventory";
import { initCODTracking } from "@/lib/payment/cod";

// Create a Hono app for order routes, typed with Env bindings
const app = new Hono<{ Bindings: Env }>();
const deliveryService = new DeliveryService();

// Helper function to convert Unix timestamp to Date
const unixToDate = (timestamp: number | null): Date | null => {
  if (!timestamp) return null;
  return new Date(timestamp * 1000);
};

// GET all orders with pagination, search, and filtering
app.get("/", async (c) => {
  try {
    const db = c.get("db");
    const url = new URL(c.req.url);
    const searchParams = url.searchParams;

    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
    const search = searchParams.get("search") || "";
    const status = searchParams.get("status") || undefined;
    const showTrashed = searchParams.get("trashed") === "true";
    const paymentStatus = searchParams.get("paymentStatus") || undefined;
    const paymentMethod = searchParams.get("paymentMethod") || undefined;
    const fulfillmentStatus = searchParams.get("fulfillmentStatus") || undefined;
    const dateFrom = searchParams.get("dateFrom") || undefined;
    const dateTo = searchParams.get("dateTo") || undefined;
    const sortField = (searchParams.get("sort") || "updatedAt") as
      | "customerName"
      | "totalAmount"
      | "status"
      | "createdAt"
      | "updatedAt";
    const sortOrder = (searchParams.get("order") || "desc") as "asc" | "desc";

    const offset = (page - 1) * limit;

    // Build where conditions
    const whereConditions = [];

    if (showTrashed) {
      whereConditions.push(sql`${orders.deletedAt} IS NOT NULL`);
    } else {
      whereConditions.push(sql`${orders.deletedAt} IS NULL`);
    }

    if (search) {
      whereConditions.push(
        sql`(${orders.customerName} LIKE ${`%${search}%`} OR ${orders.customerPhone} LIKE ${`%${search}%`} OR ${orders.id} LIKE ${`%${search}%`})`,
      );
    }

    if (status) {
      whereConditions.push(sql`${orders.status} = ${status}`);
    }

    if (paymentStatus) {
      whereConditions.push(sql`${orders.paymentStatus} = ${paymentStatus}`);
    }

    if (paymentMethod) {
      whereConditions.push(sql`${orders.paymentMethod} = ${paymentMethod}`);
    }

    if (fulfillmentStatus) {
      whereConditions.push(sql`${orders.fulfillmentStatus} = ${fulfillmentStatus}`);
    }

    if (dateFrom) {
      const fromTimestamp = Math.floor(new Date(dateFrom).getTime() / 1000);
      whereConditions.push(sql`${orders.createdAt} >= ${fromTimestamp}`);
    }

    if (dateTo) {
      const toTimestamp = Math.floor(new Date(dateTo).getTime() / 1000) + 86399; // end of day
      whereConditions.push(sql`${orders.createdAt} <= ${toTimestamp}`);
    }

    // Combine all conditions
    const whereClause = whereConditions.length
      ? sql.join(whereConditions, sql` AND `)
      : undefined;

    // Determine sort direction
    const sortDirection = sortOrder === "asc" ? asc : desc;

    // Map sort field to actual column
    let orderByClause;
    switch (sortField) {
      case "customerName":
        orderByClause = sortDirection(orders.customerName);
        break;
      case "totalAmount":
        orderByClause = sortDirection(orders.totalAmount);
        break;
      case "status":
        orderByClause = sortDirection(orders.status);
        break;
      case "createdAt":
        orderByClause = sortDirection(orders.createdAt);
        break;
      case "updatedAt":
      default:
        orderByClause = sortDirection(orders.updatedAt);
        break;
    }

    // --- OPTIMIZED: Single query with window count ---
    // Uses COUNT(*) OVER() to get total without a separate count query
    const ordersQuery = db
      .select({
        id: orders.id,
        customerName: orders.customerName,
        customerPhone: orders.customerPhone,
        customerEmail: orders.customerEmail,
        totalAmount: orders.totalAmount,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        paymentMethod: orders.paymentMethod,
        fulfillmentStatus: orders.fulfillmentStatus,
        paidAmount: orders.paidAmount,
        balanceDue: orders.balanceDue,
        createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
        updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`,
        customerId: orders.customerId,
        city: orders.city,
        zone: orders.zone,
        area: orders.area,
        cityName: orders.cityName,
        zoneName: orders.zoneName,
        areaName: orders.areaName,
        shippingCharge: orders.shippingCharge,
        discountAmount: orders.discountAmount,
        // PERF: window count avoids a separate COUNT(*) query
        totalCount: sql<number>`COUNT(*) OVER()`.as("totalCount"),
      })
      .from(orders);

    if (whereClause) {
      ordersQuery.where(whereClause);
    }

    const results = await ordersQuery
      .orderBy(orderByClause)
      .limit(limit)
      .offset(offset);

    // Get total from first result (window count) or 0 if empty
    const total = results.length > 0 ? (results[0] as any).totalCount : 0;

    // Get item counts for each order (only if there are orders)
    let itemCountMap = new Map<string, { count: number; quantity: number }>();

    if (results.length > 0) {
      const orderIds = results.map((order) => order.id);
      const itemCounts = await db
        .select({
          orderId: orderItems.orderId,
          count: sql<number>`count(*)`,
          totalQuantity: sql<number>`sum(${orderItems.quantity})`,
        })
        .from(orderItems)
        .where(sql`${orderItems.orderId} IN ${orderIds}`)
        .groupBy(orderItems.orderId);

      itemCountMap = new Map(
        itemCounts.map((ic) => [
          ic.orderId,
          { count: ic.count, quantity: ic.totalQuantity },
        ]),
      );
    }

    // Format dates and add item counts (exclude totalCount from output)
    const formattedResults = results.map(({ totalCount, ...order }) => ({
      ...order,
      createdAt: unixToDate(order.createdAt)?.toISOString() || null,
      updatedAt: unixToDate(order.updatedAt)?.toISOString() || null,
      itemCount: itemCountMap.get(order.id)?.count || 0,
      totalQuantity: itemCountMap.get(order.id)?.quantity || 0,
    }));

    // Calculate pagination info
    const totalPages = Math.ceil(total / limit);
    const pagination = {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return c.json({ orders: formattedResults, pagination });
  } catch (error) {
    console.error("Error fetching orders:", error);
    return c.json({ error: "Failed to fetch orders" }, 500);
  }
});

// GET a specific order by ID
// Apply cache middleware with 30-day TTL, for GET only, varying by auth
app.get(
  "/:id",
  cacheMiddleware({
    ttl: 2592000, // 30 days in seconds
    methods: ["GET"],
    varyByQuery: false, // No query params for this route
    varyByAuth: true, // Route is authenticated
  }),
  async (c) => {
    try {
      const db = c.get("db");
      const id = c.req.param("id");

      // Get order details from database
      const orderResult = await db
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
          createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
          updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`,
        })
        .from(orders)
        .where(eq(orders.id, id));

      if (!orderResult || orderResult.length === 0) {
        return c.json({ error: "Order not found" }, 404);
      }
      const order = orderResult[0];

      // Get order items with product and variant details
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

      // Get associated shipments using deliveryService
      const shipments = await deliveryService.getShipments(id);

      // Get active delivery providers using deliveryService
      const activeProviders = await deliveryService.getActiveProviders();

      // Format dates and add shipments/providers
      const formattedOrder = {
        ...order,
        createdAt: unixToDate(order.createdAt)?.toISOString() || null,
        updatedAt: unixToDate(order.updatedAt)?.toISOString() || null,
        items,
        shipments,
        deliveryProviders: activeProviders,
      };

      return c.json({ order: formattedOrder });
    } catch (error) {
      console.error("Error fetching order:", error);
      return c.json({ error: "Failed to fetch order" }, 500);
    }
  },
);

// GET items for a specific order (for popover)
app.get("/:id/items", async (c) => {
  try {
    const db = c.get("db");
    const id = c.req.param("id");

    // Get order items with product and variant details
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

    if (!items || items.length === 0) {
      // Return empty array if no items found, not an error
      return c.json([]);
    }

    return c.json(items);
  } catch (error) {
    console.error("Error fetching order items:", error);
    return c.json({ error: "Failed to fetch order items" }, 500);
  }
});

// GET - Fetch products and variants specifically for the OrderForm component
app.get("/products-for-form", async (c) => {
  try {
    const db = c.get("db");

    // --- OPTIMIZED: Batch both queries into single HTTP request ---
    // This reduces cold-start latency by eliminating a separate network round trip
    const batchQueries: Parameters<typeof db.batch>[0] = [
      // 0. Get all active products (not deleted)
      db
        .select({
          id: products.id,
          name: products.name,
          price: products.price,
          discountPercentage: products.discountPercentage,
        })
        .from(products)
        .where(isNull(products.deletedAt)),

      // 1. Get all active variants
      db
        .select({
          id: productVariants.id,
          productId: productVariants.productId,
          size: productVariants.size,
          color: productVariants.color,
          weight: productVariants.weight,
          sku: productVariants.sku,
          price: productVariants.price,
          stock: productVariants.stock,
          createdAt: productVariants.createdAt,
          updatedAt: productVariants.updatedAt,
          deletedAt: productVariants.deletedAt,
        })
        .from(productVariants)
        .where(isNull(productVariants.deletedAt)),
    ];

    const batchResults = await db.batch(batchQueries);

    // Type the results
    const activeProducts = batchResults[0] as {
      id: string;
      name: string;
      price: number;
      discountPercentage: number | null;
    }[];

    const variants = batchResults[1] as {
      id: string;
      productId: string;
      size: string | null;
      color: string | null;
      weight: number | null;
      sku: string;
      price: number;
      stock: number;
      createdAt: any;
      updatedAt: any;
      deletedAt: any;
    }[];

    if (activeProducts.length === 0) {
      return c.json({ products: [] });
    }

    // Group variants by productId
    const productVariantsMap = new Map<string, typeof variants>();
    variants.forEach((variant) => {
      if (!productVariantsMap.has(variant.productId)) {
        productVariantsMap.set(variant.productId, []);
      }
      productVariantsMap.get(variant.productId)?.push(variant);
    });

    // Prepare products with variants in the structure expected by OrderForm
    const productsWithVariants = activeProducts.map((product) => ({
      ...product,
      variants: productVariantsMap.get(product.id) || [],
    }));

    return c.json({ products: productsWithVariants });
  } catch (error) {
    console.error("Error fetching products for form:", error);
    return c.json(
      {
        error: "Failed to fetch products for form",
      },
      500,
    );
  }
});

// Define the schema for creating an order
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
      productName: z.string().optional().nullable(),
      variantLabel: z.string().optional().nullable(),
    }),
  ),
  discountAmount: z
    .number()
    .min(0, "Discount must be greater than or equal to 0")
    .nullable(),
  discountCode: z.string().optional().nullable(),
  shippingCharge: z
    .number()
    .min(0, "Shipping charge must be greater than or equal to 0"),
  paymentMethod: z
    .enum([PaymentMethod.STRIPE, PaymentMethod.SSLCOMMERZ, PaymentMethod.COD])
    .default(PaymentMethod.COD),
  inventoryPool: z
    .enum([InventoryPool.REGULAR, InventoryPool.PREORDER, InventoryPool.BACKORDER])
    .default(InventoryPool.REGULAR),
});

// POST - Create a new order
app.post("/", async (c) => {
  try {
    const db = c.get("db");
    const json = await c.req.json();
    const data = createOrderSchema.parse(json);
    const requestUrl = c.req.url;

    // NOTE: totalAmount is computed AFTER fetching DB prices (see below).
    // We never trust the client-submitted item.price values.

    // ------------------------------------------------------------------
    // 1. Batched Reads
    // Fetch all necessary data in a single network roundtrip using db.batch()
    // ------------------------------------------------------------------
    const variantIds = data.items
      .map((item) => item.variantId)
      .filter((id): id is string => id !== null);

    const locationIds = [data.city, data.zone, data.area].filter(Boolean);

    // Prepare read queries (without .get() or .all(), just the builder)
    // Note: empty arrays for variants/locations need handling to avoid invalid SQL if empty

    const readBatch: any[] = [];

    // 1. Variants
    if (variantIds.length > 0) {
      readBatch.push(
        db
          .select({
            id: productVariants.id,
            productId: productVariants.productId,
            stock: productVariants.stock,
            price: productVariants.price,
            discountPercentage: productVariants.discountPercentage,
            discountType: productVariants.discountType,
            discountAmount: productVariants.discountAmount,
          })
          .from(productVariants)
          .where(
            and(
              sql`${productVariants.id} IN ${variantIds}`,
              isNull(productVariants.deletedAt),
            ),
          ),
      );
    } else {
      // Placeholder if no variants (unlikely but safe)
      readBatch.push(db.select().from(productVariants).limit(0));
    }

    // 2. Locations
    if (locationIds.length > 0) {
      readBatch.push(
        db
          .select()
          .from(deliveryLocations)
          .where(
            and(
              sql`${deliveryLocations.id} IN (${locationIds.join(",")})`,
              isNull(deliveryLocations.deletedAt),
            ),
          ),
      );
    } else {
      readBatch.push(db.select().from(deliveryLocations).limit(0));
    }

    // 3. Customer
    readBatch.push(
      db
        .select({
          id: customers.id,
          totalOrders: customers.totalOrders,
          totalSpent: customers.totalSpent,
        })
        .from(customers)
        .where(eq(customers.phone, data.customerPhone)),
    );

    // 4. Discount
    if (data.discountCode) {
      readBatch.push(
        db
          .select({ id: discounts.id })
          .from(discounts)
          .where(eq(discounts.code, data.discountCode)),
      );
    } else {
      readBatch.push(db.select().from(discounts).limit(0));
    }

    // 5. Products (for server-side price verification)
    const productIds = [...new Set(data.items.map((item) => item.productId))];
    if (productIds.length > 0) {
      readBatch.push(
        db
          .select({
            id: products.id,
            price: products.price,
            discountPercentage: products.discountPercentage,
            discountType: products.discountType,
            discountAmount: products.discountAmount,
          })
          .from(products)
          .where(
            and(
              sql`${products.id} IN ${productIds}`,
              isNull(products.deletedAt),
            ),
          ),
      );
    } else {
      readBatch.push(db.select().from(products).limit(0));
    }

    // Execute Read Batch
    const readResults = await db.batch(readBatch as [any, any, any, any, any]);

    // Unpack Results
    const variants =
      variantIds.length > 0
        ? (readResults[0] as (typeof productVariants)[])
        : [];
    const locationResults =
      locationIds.length > 0
        ? (readResults[1] as (typeof deliveryLocations)[])
        : [];

    // Handle customer (array of 0 or 1)
    const customerList = readResults[2] as {
      id: string;
      totalOrders: number;
      totalSpent: number;
    }[];
    const existingCustomer =
      customerList.length > 0 ? customerList[0] : undefined;

    // Handle discount
    const discountList = data.discountCode
      ? (readResults[3] as { id: string }[])
      : [];
    const appliedDiscount = discountList.length > 0 ? discountList[0] : null;

    // Handle products (for price verification)
    const productList = productIds.length > 0
      ? (readResults[4] as {
        id: string;
        price: number;
        discountPercentage: number | null;
        discountType: string | null;
        discountAmount: number | null;
      }[])
      : [];
    const productMap = new Map(productList.map((p) => [p.id, p]));

    // Validation (Pre-Check)
    const variantMap = new Map(variants.map((v: any) => [v.id, v]));
    for (const item of data.items) {
      if (item.variantId) {
        const variant = variantMap.get(item.variantId);
        if (!variant) {
          throw new Error(
            `VALIDATION_ERROR:Variant ${item.variantId} not found.`,
          );
        }
      }
      // Verify the product exists in DB
      const product = productMap.get(item.productId);
      if (!product) {
        throw new Error(
          `VALIDATION_ERROR:Product ${item.productId} not found or is inactive.`,
        );
      }
    }

    // ------------------------------------------------------------------
    // SERVER-SIDE PRICE VERIFICATION
    // Compute the real item total from DB prices to prevent client manipulation.
    // ------------------------------------------------------------------
    let serverItemTotal = 0;
    for (const item of data.items) {
      let unitPrice: number;

      if (item.variantId) {
        // Use variant's own price (variant price takes precedence)
        const variant = variantMap.get(item.variantId) as any;
        unitPrice = variant.price;

        // Apply variant-level discount if present
        if (variant.discountType === "percentage" && variant.discountPercentage > 0) {
          unitPrice = unitPrice * (1 - variant.discountPercentage / 100);
        } else if (variant.discountType === "flat" && variant.discountAmount > 0) {
          unitPrice = Math.max(0, unitPrice - variant.discountAmount);
        }
      } else {
        // No variant — use product base price
        const product = productMap.get(item.productId)!;
        unitPrice = product.price;

        // Apply product-level discount
        if (product.discountType === "percentage" && (product.discountPercentage ?? 0) > 0) {
          unitPrice = unitPrice * (1 - (product.discountPercentage ?? 0) / 100);
        } else if (product.discountType === "flat" && (product.discountAmount ?? 0) > 0) {
          unitPrice = Math.max(0, unitPrice - (product.discountAmount ?? 0));
        }
      }

      serverItemTotal += unitPrice * item.quantity;
    }

    // Round to 2 decimal places to avoid floating-point drift
    serverItemTotal = Math.round(serverItemTotal * 100) / 100;

    const totalAmount =
      serverItemTotal + data.shippingCharge - (data.discountAmount || 0);

    // Process Location Data
    const locationMap = new Map(
      locationResults.map((l: any) => [l.id, l.name]),
    );
    const cityName = locationMap.get(data.city) || data.cityName || null;
    const zoneName = locationMap.get(data.zone) || data.zoneName || null;
    const areaName = locationMap.get(data.area || "") || data.areaName || null;

    // ------------------------------------------------------------------
    // 2. Batched Write Transaction
    // Use db.batch() for all writes effectively executing in 1 roundtrip.
    // ------------------------------------------------------------------

    // Prepare IDs upfront
    const orderId = generateOrderId();
    let customerId = existingCustomer
      ? existingCustomer.id
      : "cust_" + nanoid();

    // A. Reserve inventory using optimistic locking (replaces direct stock decrement)
    // This handles concurrent order creation safely via version-checked atomic updates.
    const reservationEntries = data.items
      .filter((item) => item.variantId !== null)
      .map((item) => ({
        variantId: item.variantId as string,
        quantity: item.quantity,
        pool: data.inventoryPool as "regular" | "preorder" | "backorder",
      }));

    if (reservationEntries.length > 0) {
      const reserveResult = await reserveMultiple(db, reservationEntries, orderId);
      if (!reserveResult.success) {
        const failedResult = reserveResult.results.find((r) => !r.success);
        throw new Error(`INSUFFICIENT_STOCK:${failedResult?.error ?? "Insufficient stock"}`);
      }
    }

    const writeBatch: any[] = [];

    // B. Customer Upsert
    if (!existingCustomer) {
      // Create new customer
      writeBatch.push(
        db.insert(customers).values({
          id: customerId,
          name: data.customerName,
          phone: data.customerPhone,
          email: data.customerEmail,
          address: data.shippingAddress,
          city: data.city,
          zone: data.zone,
          area: data.area,
          cityName,
          zoneName,
          areaName,
          totalOrders: 1,
          totalSpent: totalAmount,
          lastOrderAt: sql`unixepoch()`,
          createdAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
        }),
      );
      writeBatch.push(
        db.insert(customerHistory).values({
          id: "hist_" + nanoid(),
          customerId: customerId,
          name: data.customerName,
          email: data.customerEmail,
          phone: data.customerPhone,
          address: data.shippingAddress,
          city: data.city,
          zone: data.zone,
          area: data.area,
          cityName,
          zoneName,
          areaName,
          changeType: "created",
          createdAt: sql`unixepoch()`,
        }),
      );
    } else {
      // Update existing customer stats
      writeBatch.push(
        db
          .update(customers)
          .set({
            totalOrders: sql`${customers.totalOrders} + 1`,
            totalSpent: sql`${customers.totalSpent} + ${totalAmount}`,
            lastOrderAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
          })
          .where(eq(customers.id, existingCustomer.id)),
      );
    }

    // C. Create Order
    const newOrderData = {
      id: orderId,
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
      discountAmount: data.discountAmount || 0,
      status: "pending" as const,
      // Payment fields
      paymentMethod: data.paymentMethod,
      paymentStatus: PaymentStatus.UNPAID,
      paidAmount: 0,
      balanceDue: totalAmount,
      // Fulfillment fields
      fulfillmentStatus: FulfillmentStatus.PENDING,
      inventoryPool: data.inventoryPool,
      customerId,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    };

    writeBatch.push(db.insert(orders).values(newOrderData));

    // D. Create Order Items (with product/variant name snapshots)
    if (data.items.length > 0) {
      writeBatch.push(
        db.insert(orderItems).values(
          data.items.map((item) => ({
            id: "item_" + nanoid(),
            orderId: orderId,
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
            price: item.price,
            // Snapshot product/variant labels at order time so they survive future edits
            productName: item.productName ?? null,
            variantLabel: item.variantLabel ?? null,
            fulfillmentStatus: "pending" as const,
            createdAt: sql`unixepoch()`,
          })),
        ),
      );
    }

    // E. Log Discount Usage
    if (appliedDiscount && data.discountAmount && data.discountAmount > 0) {
      writeBatch.push(
        db.insert(discountUsage).values({
          id: "du_" + nanoid(),
          discountId: appliedDiscount.id,
          orderId: orderId,
          customerId: customerId,
          amountDiscounted: data.discountAmount,
          createdAt: sql`unixepoch()`,
        }),
      );
    }

    // Execute Write Batch (1 Roundtrip)
    try {
      await db.batch(writeBatch as any);
    } catch (batchError) {
      // Write batch failed — release the reservations we just placed
      if (reservationEntries.length > 0) {
        await releaseMultiple(db, reservationEntries, orderId).catch((releaseErr) =>
          console.error("[orders] Reservation release failed after batch error:", releaseErr)
        );
      }
      throw batchError;
    }

    // ------------------------------------------------------------------
    // 3. Post-write: initialize COD tracking for COD orders
    // ------------------------------------------------------------------
    if (data.paymentMethod === PaymentMethod.COD) {
      await initCODTracking(db, { orderId }).catch((err) =>
        console.error("[orders] COD tracking init failed:", err)
      );
    }

    // Background Notification... logic remains same (executionCtx)
    if (c.executionCtx) {
      const { sendOrderNotification } = await import(
        "@/lib/notification-utils"
      );
      c.executionCtx.waitUntil(
        sendOrderNotification(
          { id: orderId, customerName: newOrderData.customerName },
          c.env,
          requestUrl,
        ),
      );
    } else {
      const { sendOrderNotification } = await import(
        "@/lib/notification-utils"
      );
      sendOrderNotification(
        { id: orderId, customerName: newOrderData.customerName },
        c.env,
        requestUrl,
      ).catch((err) => console.error("Notification error:", err));
    }

    return c.json(
      {
        success: true,
        data: {
          id: orderId,
          paymentMethod: data.paymentMethod,
          totalAmount,
        },
      },
      201,
    );
  } catch (error) {
    console.error("Error creating order:", error);

    // Handle our custom stock errors
    if (
      error instanceof Error &&
      error.message.startsWith("VALIDATION_ERROR:")
    ) {
      return c.json(
        {
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: error.message.replace("VALIDATION_ERROR:", ""),
          },
        },
        400,
      );
    }

    if (
      error instanceof Error &&
      error.message.startsWith("INSUFFICIENT_STOCK:")
    ) {
      return c.json(
        {
          success: false,
          error: {
            code: "INSUFFICIENT_STOCK",
            message: error.message.replace("INSUFFICIENT_STOCK:", ""),
          },
        },
        400,
      );
    }

    // Zod Validation Errors
    if (error instanceof z.ZodError) {
      return c.json(
        {
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid input data",
            details: error.errors,
          },
        },
        400,
      );
    }

    // Return detailed error for debugging
    return c.json(
      {
        error: "Failed to create order",
        details: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// Define the schema for updating an order
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
      id: z.string().optional(),
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
  status: z.string().optional(),
});

// PUT - Update an existing order
app.put("/:id", async (c) => {
  try {
    const db = c.get("db");
    const id = c.req.param("id");
    if (!id) {
      return c.json(
        {
          error: "Order ID is required",
        },
        400,
      );
    }

    const json = await c.req.json();
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

    // Set location names
    const cityName = locationMap.get(data.city) || data.cityName || null;
    const zoneName = locationMap.get(data.zone) || data.zoneName || null;
    const areaName = locationMap.get(data.area || "") || data.areaName || null;

    // Calculate total amount
    const totalAmount =
      data.items.reduce((sum, item) => sum + item.price * item.quantity, 0) +
      data.shippingCharge -
      (data.discountAmount || 0);

    // Get existing order to check if it exists
    const existingOrder = await db
      .select({ id: orders.id, customerId: orders.customerId })
      .from(orders)
      .where(and(eq(orders.id, id), isNull(orders.deletedAt)))
      .get();

    if (!existingOrder) {
      return c.json(
        {
          error: "Order not found",
        },
        404,
      );
    }

    // Get existing items to calculate stock changes
    const existingItems = await db
      .select({
        id: orderItems.id,
        variantId: orderItems.variantId,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, id));

    // Create a map of variant ID to quantity for existing items
    const existingItemMap = new Map();
    existingItems.forEach((item) => {
      if (item.variantId) {
        existingItemMap.set(item.variantId, item.quantity);
      }
    });

    // Create a map of variant ID to quantity for new items
    const newItemMap = new Map();
    data.items.forEach((item) => {
      if (item.variantId) {
        newItemMap.set(
          item.variantId,
          (newItemMap.get(item.variantId) || 0) + item.quantity,
        );
      }
    });

    // Calculate stock changes
    const stockChanges = new Map();

    // First, restore stock for removed or reduced items
    existingItemMap.forEach((quantity, variantId) => {
      const newQuantity = newItemMap.get(variantId) || 0;
      if (newQuantity < quantity) {
        // Item was removed or quantity reduced, restore stock
        stockChanges.set(
          variantId,
          (stockChanges.get(variantId) || 0) + (quantity - newQuantity),
        );
      }
    });

    // Then, reduce stock for new or increased items
    newItemMap.forEach((quantity, variantId) => {
      const existingQuantity = existingItemMap.get(variantId) || 0;
      if (quantity > existingQuantity) {
        // Item was added or quantity increased, reduce stock
        stockChanges.set(
          variantId,
          (stockChanges.get(variantId) || 0) - (quantity - existingQuantity),
        );
      }
    });

    // Update product variant stock
    for (const [variantId, change] of stockChanges.entries()) {
      if (change !== 0) {
        await db
          .update(productVariants)
          .set({
            stock: sql`${productVariants.stock} + ${change}`,
            updatedAt: sql`unixepoch()`,
          })
          .where(eq(productVariants.id, variantId));
      }
    }

    // Update order
    await db
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
        status: data.status || undefined,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(orders.id, id));

    // Delete existing order items
    await db.delete(orderItems).where(eq(orderItems.orderId, id));

    // Create new order items
    if (data.items.length > 0) {
      await db.insert(orderItems).values(
        data.items.map((item) => ({
          id: item.id || "item_" + nanoid(),
          orderId: id,
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          price: item.price,
          createdAt: sql`unixepoch()`,
        })),
      );
    }

    // Update customer information if there is a customer associated with the order
    if (existingOrder.customerId) {
      // Get all orders for this customer to calculate stats
      const customerOrders = await db
        .select({
          totalAmount: orders.totalAmount,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .where(
          and(
            eq(orders.customerId, existingOrder.customerId),
            isNull(orders.deletedAt),
          ),
        );

      const stats = calculateCustomerStats(customerOrders);

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
        .where(eq(customers.id, existingOrder.customerId));

      // Record update in history
      await db.insert(customerHistory).values({
        id: "hist_" + nanoid(),
        customerId: existingOrder.customerId,
        name: data.customerName,
        email: data.customerEmail,
        phone: data.customerPhone,
        address: data.shippingAddress,
        city: data.city,
        zone: data.zone,
        area: data.area,
        cityName,
        zoneName,
        areaName,
        changeType: "updated",
        createdAt: sql`unixepoch()`,
      });
    }

    return c.json({ id });
  } catch (error) {
    console.error("Error updating order:", error);

    if (error instanceof z.ZodError) {
      return c.json(
        {
          error: "Invalid order data",
          details: error.errors,
        },
        400,
      );
    }

    return c.json(
      {
        error: "Internal server error",
      },
      500,
    );
  }
});

// DELETE - Soft delete an order
app.delete("/:id", async (c) => {
  try {
    const db = c.get("db");
    const id = c.req.param("id");
    if (!id) {
      return c.json(
        {
          error: "Order ID is required",
        },
        400,
      );
    }

    // Check if order exists and get its items
    const existingOrder = await db
      .select({ id: orders.id })
      .from(orders)
      .where(sql`${orders.id} = ${id} AND ${orders.deletedAt} IS NULL`)
      .get();

    if (!existingOrder) {
      return c.json(
        {
          error: "Order not found",
        },
        404,
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
    return c.json(
      {
        error: "Internal server error",
      },
      500,
    );
  }
});

// Define the schema for bulk deleting orders
const bulkDeleteSchema = z.object({
  orderIds: z.array(z.string()),
  permanent: z.boolean().default(false),
});

// POST - Bulk delete orders
app.post("/bulk-delete", async (c) => {
  try {
    const db = c.get("db");
    const json = await c.req.json();
    const data = bulkDeleteSchema.parse(json);

    if (data.orderIds.length === 0) {
      return c.json(
        {
          error: "No order IDs provided",
        },
        400,
      );
    }

    // Get all order items for the orders being deleted
    const items = await db
      .select({
        variantId: orderItems.variantId,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .where(sql`${orderItems.orderId} IN ${data.orderIds}`);

    // Restore stock for all variants in the orders
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

    if (data.permanent) {
      // Permanently delete orders
      await db.delete(orders).where(sql`${orders.id} IN ${data.orderIds}`);
      // Also delete order items
      await db
        .delete(orderItems)
        .where(sql`${orderItems.orderId} IN ${data.orderIds}`);
    } else {
      // Soft delete orders
      await db
        .update(orders)
        .set({
          deletedAt: sql`unixepoch()`,
        })
        .where(sql`${orders.id} IN ${data.orderIds}`);
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error bulk deleting orders:", error);

    if (error instanceof z.ZodError) {
      return c.json(
        {
          error: "Invalid request data",
          details: error.errors,
        },
        400,
      );
    }

    return c.json(
      {
        error: "Internal server error",
      },
      500,
    );
  }
});

// POST - Restore a deleted order
app.post("/:id/restore", async (c) => {
  try {
    const db = c.get("db");
    const id = c.req.param("id");
    if (!id) {
      return c.json(
        {
          error: "Order ID is required",
        },
        400,
      );
    }

    // Check if order exists and is actually deleted
    const existingOrder = await db
      .select({ id: orders.id, deletedAt: orders.deletedAt })
      .from(orders)
      .where(eq(orders.id, id))
      .get();

    if (!existingOrder) {
      return c.json({ error: "Order not found" }, 404);
    }

    if (!existingOrder.deletedAt) {
      return c.json({ error: "Order is not deleted" }, 400);
    }

    // Get order items to decrement stock
    const itemsToRestore = await db
      .select({
        variantId: orderItems.variantId,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, id));

    // Decrement stock for all variants in the order
    // Important: Add checks here to ensure stock doesn't go negative if that's a business rule.
    for (const item of itemsToRestore) {
      if (item.variantId) {
        await db
          .update(productVariants)
          .set({
            stock: sql`${productVariants.stock} - ${item.quantity}`,
            updatedAt: sql`unixepoch()`,
          })
          .where(eq(productVariants.id, item.variantId));
      }
    }

    // Restore order
    await db
      .update(orders)
      .set({
        deletedAt: null,
        updatedAt: sql`unixepoch()`, // Also update the updatedAt timestamp
      })
      .where(eq(orders.id, id));

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error restoring order:", error);
    return c.json(
      {
        error: "Internal server error",
      },
      500,
    );
  }
});

// Valid order statuses
const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
] as const;

const updateStatusSchema = z.object({
  status: z.enum(ORDER_STATUSES, {
    errorMap: () => ({
      message: `Status must be one of: ${ORDER_STATUSES.join(", ")}`,
    }),
  }),
});

// PUT - Update order status
app.put("/:id/status", async (c) => {
  try {
    const db = c.get("db");
    const id = c.req.param("id");
    if (!id) {
      return c.json(
        {
          error: "Order ID is required",
        },
        400,
      );
    }

    const json = await c.req.json();
    const { status } = updateStatusSchema.parse(json);

    // Update order status
    await db
      .update(orders)
      .set({
        status,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(orders.id, id));

    return c.json({
      success: true,
      data: { message: "Order status updated successfully" },
    });
  } catch (error) {
    console.error("Error updating order status:", error);

    if (error instanceof z.ZodError) {
      return c.json(
        {
          error: "Invalid status",
          details: error.errors,
        },
        400,
      );
    }

    return c.json(
      {
        error: "Internal server error",
      },
      500,
    );
  }
});

// DELETE - Permanently delete an order
app.delete("/:id/permanent", async (c) => {
  try {
    const db = c.get("db");
    const id = c.req.param("id");
    if (!id) {
      return c.json(
        {
          error: "Order ID is required",
        },
        400,
      );
    }

    // Check if order exists
    const existingOrder = await db
      .select({ id: orders.id, deletedAt: orders.deletedAt })
      .from(orders)
      .where(eq(orders.id, id))
      .get();

    if (!existingOrder) {
      return c.json({ error: "Order not found" }, 404);
    }

    // If the order was not already soft-deleted, restore stock first
    if (existingOrder.deletedAt === null) {
      const itemsToRestore = await db
        .select({
          variantId: orderItems.variantId,
          quantity: orderItems.quantity,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, id));

      for (const item of itemsToRestore) {
        if (item.variantId) {
          await db
            .update(productVariants)
            .set({
              stock: sql`${productVariants.stock} + ${item.quantity}`,
              updatedAt: sql`unixepoch()`,
            })
            .where(eq(productVariants.id, item.variantId));
        }
      }
      console.log(`Stock restored for order ${id} before permanent deletion.`);
    }

    // Delete order items first (foreign key constraint)
    await db.delete(orderItems).where(eq(orderItems.orderId, id));

    // Delete order
    await db.delete(orders).where(eq(orders.id, id));

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error permanently deleting order:", error);
    return c.json(
      {
        error: "Internal server error",
      },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// POST /:id/refund — Issue a refund for an order (gateway-agnostic)
// ---------------------------------------------------------------------------
app.post("/:id/refund", async (c) => {
  try {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json() as {
      amount?: number;
      reason?: string;
      gateway?: "stripe" | "sslcommerz";
    };

    const { processRefund } = await import("@/lib/payment/refund-service");
    const result = await processRefund(db, c.env.CACHE, {
      orderId: id,
      amount: body.amount,
      reason: body.reason ?? "Refund requested",
      gateway: body.gateway,
    });

    return c.json(result, result.success ? 200 : 400);
  } catch (error) {
    console.error("Error processing refund:", error);
    return c.json({ success: false, error: "Failed to process refund" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /:id/return — Process an order return with optional auto-refund
// ---------------------------------------------------------------------------
app.post("/:id/return", async (c) => {
  try {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json() as {
      reason?: string;
      autoRefund?: boolean;
    };

    const { processReturn } = await import("@/lib/payment/refund-service");
    const result = await processReturn(db, c.env.CACHE, {
      orderId: id,
      reason: body.reason ?? "Customer return",
      autoRefund: body.autoRefund ?? false,
    });

    return c.json(result, result.success ? 200 : 400);
  } catch (error) {
    console.error("Error processing return:", error);
    return c.json({ success: false, error: "Failed to process return" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /counts — Return order counts grouped by status (for toolbar pills)
// ---------------------------------------------------------------------------
app.get("/counts", async (c) => {
  try {
    const db = c.get("db");

    const counts = await db
      .select({
        status: orders.status,
        count: sql<number>`count(*)`.as("count"),
      })
      .from(orders)
      .where(sql`${orders.deletedAt} IS NULL`)
      .groupBy(orders.status);

    const countMap: Record<string, number> = {};
    let total = 0;
    for (const row of counts) {
      countMap[row.status] = row.count;
      total += row.count;
    }
    countMap.all = total;

    return c.json({ counts: countMap });
  } catch (error) {
    console.error("Error fetching order counts:", error);
    return c.json({ error: "Failed to fetch counts" }, 500);
  }
});

// Export the order routes
export { app as orderRoutes };
