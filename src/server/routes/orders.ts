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
  OrderStatus,
  FulfillmentStatus,
  InventoryPool,
} from "@/db/schema";
import { eq, sql, and, isNull } from "drizzle-orm";
import { z } from "zod";
import { nanoid } from "nanoid";
import { generateOrderId } from "@/lib/order-utils";
import { phoneNumberSchema } from "@/lib/customer-utils";
import { DeliveryService } from "@/lib/delivery/service";
import { cacheMiddleware } from "../middleware/cache";
import { reserveMultiple, releaseMultiple } from "@/lib/inventory";
import { initCODTracking } from "@/lib/payment/cod";
import { applyInventoryForStatusChange } from "@/lib/inventory/inventory-transitions";

// Create a Hono app for order routes, typed with Env bindings
const app = new Hono<{ Bindings: Env }>();
const deliveryService = new DeliveryService();

// Helper function to convert Unix timestamp to Date
const unixToDate = (timestamp: number | null): Date | null => {
  if (!timestamp) return null;
  return new Date(timestamp * 1000);
};

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
  cityName: z.string().nullable().optional(),
  zoneName: z.string().nullable().optional(),
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
              sql`${deliveryLocations.id} IN ${locationIds}`,
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
      status: data.paymentMethod === PaymentMethod.COD ? OrderStatus.PENDING : OrderStatus.INCOMPLETE,
      // Payment fields
      paymentMethod: data.paymentMethod,
      paymentStatus: PaymentStatus.UNPAID,
      paidAmount: 0,
      balanceDue: totalAmount,
      // Fulfillment fields
      fulfillmentStatus: FulfillmentStatus.PENDING,
      inventoryPool: data.inventoryPool,
      inventoryAction: reservationEntries.length > 0 ? "reserved" : "none",
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

      // COD orders start as PENDING, so we must immediately apply inventory logic
      // to convert their reservations into permanent deductions.
      await applyInventoryForStatusChange(db, orderId, OrderStatus.PENDING).catch((err) =>
        console.error("[orders] Inventory deduction failed for COD order:", err)
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

// Export the order routes (storefront uses POST / and GET /:id only; admin uses Astro routes)
export { app as orderRoutes };
