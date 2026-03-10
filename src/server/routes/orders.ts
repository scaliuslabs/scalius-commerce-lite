import { Hono } from "hono";

import {
  orders,
  orderItems,
  customers,
  productVariants,
  deliveryLocations,
  products,
  productImages,
  discounts,
  PaymentMethod,
  PaymentStatus,
  OrderStatus,
  FulfillmentStatus,
  InventoryPool,
  siteSettings,
  shippingMethods,
} from "@/db/schema";
import { isDiscountValid, calculateDiscountAmount } from "./discounts";
import { eq, sql, and, isNull } from "drizzle-orm";
import { z } from "zod";
import { nanoid } from "nanoid";
import { generateOrderId } from "@/shared/order-utils";
import { phoneNumberSchema } from "@/shared/customer-utils";
import { DeliveryService } from "@/modules/delivery/service";
import { cacheMiddleware } from "../middleware/cache";
// import { reserveMultiple, releaseMultiple } from "@/modules/inventory";
// import { initCODTracking } from "@/modules/payments/cod";

const app = new Hono<{ Bindings: Env }>();
const deliveryService = new DeliveryService();

const unixToDate = (timestamp: number | null): Date | null => {
  if (!timestamp) return null;
  return new Date(timestamp * 1000);
};

app.get(
  "/:id",
  cacheMiddleware({
    ttl: 2592000,
    methods: ["GET"],
    varyByQuery: false,
    varyByAuth: true,
  }),
  async (c) => {
    try {
      const db = c.get("db");
      const id = c.req.param("id");

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

      const shipments = await deliveryService.getShipments(id);

      const activeProviders = await deliveryService.getActiveProviders();

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
  shippingMethodId: z.string().optional().nullable(),
  paymentMethod: z
    .enum([PaymentMethod.STRIPE, PaymentMethod.SSLCOMMERZ, PaymentMethod.POLAR, PaymentMethod.COD])
    .default(PaymentMethod.COD),
  inventoryPool: z
    .enum([InventoryPool.REGULAR, InventoryPool.PREORDER, InventoryPool.BACKORDER])
    .default(InventoryPool.REGULAR),
});

app.get("/status/:token", async (c) => {
  try {
    const token = c.req.param("token");
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");

    if (!token || !token.startsWith("chk_")) {
      return c.json({ error: "Invalid checkout token" }, 400);
    }

    if (!c.env.CACHE) {
      console.warn("[Orders] Polling endpoint hit but CACHE KV is not bound!");
      return c.json({ status: "processing" });
    }

    const kvKey = `checkout_status:${token}`;
    const statusStr = await c.env.CACHE.get(kvKey);

    if (!statusStr) {
      return c.json({ status: "processing", message: "Order is waiting in queue." }, 202);
    }

    const statusData = JSON.parse(statusStr);

    if (statusData.status === "processing" && statusData.orderId) {
      const db = c.get("db");
      const orderExists = await db
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.id, statusData.orderId))
        .limit(1);

      if (orderExists.length > 0) {
        return c.json({ status: "completed", orderId: statusData.orderId }, 200);
      }
    }

    return c.json(statusData, 200);

  } catch (err) {
    console.error("Error checking order status:", err);
    return c.json({ error: "Failed to check order status" }, 500);
  }
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
            freeDelivery: products.freeDelivery,
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

    // 6. Settings (for partial payment checks)
    readBatch.push(db.select().from(siteSettings).limit(1));

    // 7. Shipping Method
    if (data.shippingMethodId) {
      readBatch.push(
        db
          .select()
          .from(shippingMethods)
          .where(eq(shippingMethods.id, data.shippingMethodId)),
      );
    } else {
      readBatch.push(db.select().from(shippingMethods).limit(0));
    }

    // Execute Read Batch
    const readResults = await db.batch(readBatch as [any, any, any, any, any, any, any]);

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
        freeDelivery: boolean;
      }[])
      : [];
    const productMap = new Map(productList.map((p) => [p.id, p]));

    const settingsList = readResults[5] as any[];
    const settings = settingsList.length > 0 ? settingsList[0] : null;

    const shippingMethodList = readResults[6] as any[];
    const shippingMethod = shippingMethodList.length > 0 ? shippingMethodList[0] : null;

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

    // Determine exact shipping charge to use securely from DB
    let verifiedShippingCharge = shippingMethod ? shippingMethod.fee : (data.shippingCharge || 0);

    // Zero out shipping if any product in the order has free delivery
    const hasFreeDeliveryProduct = data.items.some((item) => {
      const product = productMap.get(item.productId);
      return product?.freeDelivery === true;
    });
    if (hasFreeDeliveryProduct) {
      verifiedShippingCharge = 0;
    }

    // ------------------------------------------------------------------
    // DISCOUNTS VERIFICATION
    // Determine exact discount securely via the discounts service engine
    // ------------------------------------------------------------------
    let verifiedDiscountAmount = 0;
    if (data.discountCode) {
      const validationResponse = await isDiscountValid(
        db,
        data.discountCode,
        serverItemTotal + verifiedShippingCharge, // Note: some rules check grand total
        data.items,
        data.customerPhone
      );

      if (validationResponse && validationResponse.valid && validationResponse.discount) {
        verifiedDiscountAmount = calculateDiscountAmount(
          db,
          validationResponse.discount,
          serverItemTotal + verifiedShippingCharge,
          data.items,
          verifiedShippingCharge
        );
      } else {
        throw new Error(`VALIDATION_ERROR:Discount code ${data.discountCode} is invalid or expired.`);
      }
    }

    const totalAmount =
      serverItemTotal + verifiedShippingCharge - verifiedDiscountAmount;

    // ------------------------------------------------------------------
    // PARTIAL PAYMENT SECURITY CHECK
    // ------------------------------------------------------------------
    const isPartialEnabled = settings?.partialPaymentEnabled ?? false;
    if (isPartialEnabled && data.paymentMethod === PaymentMethod.COD) {
      throw new Error("VALIDATION_ERROR:Advance deposit is required. COD cannot be selected for the full amount directly.");
    }

    // Process Location Data
    const locationMap = new Map(
      locationResults.map((l: any) => [l.id, l.name]),
    );
    const cityName = locationMap.get(data.city) || data.cityName || null;
    const zoneName = locationMap.get(data.zone) || data.zoneName || null;
    const areaName = locationMap.get(data.area || "") || data.areaName || null;

    // ------------------------------------------------------------------
    // 2. Queue Dispatch (Replaces Batched Write Transaction)
    // Send the fully validated payload to the Queue Consumer to batch write!
    // ------------------------------------------------------------------

    const orderId = generateOrderId();
    const checkoutToken = `chk_${nanoid()}`;

    // Assemble the complete payload exactly as the DB requires
    const queuePayload = {
      type: "order.ingest",
      checkoutToken,
      existingCustomer: existingCustomer ? { id: existingCustomer.id } : null,
      orderData: {
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
        shippingCharge: verifiedShippingCharge,
        discountAmount: verifiedDiscountAmount,
        status: (isPartialEnabled && data.paymentMethod === PaymentMethod.COD)
          ? OrderStatus.INCOMPLETE
          : data.paymentMethod === PaymentMethod.COD ? OrderStatus.PENDING : OrderStatus.INCOMPLETE,
        paymentMethod: data.paymentMethod,
        paymentStatus: PaymentStatus.UNPAID,
        paidAmount: 0,
        balanceDue: totalAmount,
        fulfillmentStatus: FulfillmentStatus.PENDING,
        inventoryPool: data.inventoryPool,
        inventoryAction: data.items.some(item => item.variantId !== null) ? "reserved" : "none",
      },
      items: data.items.map(item => ({
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
        price: item.price,
        productName: item.productName ?? null,
        variantLabel: item.variantLabel ?? null,
      })),
      discountUsage: appliedDiscount && data.discountAmount && data.discountAmount > 0 ? {
        discountId: appliedDiscount.id,
        amountDiscounted: data.discountAmount,
      } : null,
      requestUrl,
    };

    // Dispatch to Cloudflare Queue
    await c.env.ORDER_INGEST_QUEUE.send(queuePayload);

    // Write initial pending state to KV so the Storefront can poll it
    const kvKey = `checkout_status:${checkoutToken}`;
    await c.env.CACHE.put(
      kvKey,
      JSON.stringify({ status: "processing", orderId }),
      { expirationTtl: 300 } // 5 minutes TTL
    );

    return c.json(
      {
        success: true,
        data: {
          checkoutToken,
          orderId,
          paymentMethod: data.paymentMethod,
          totalAmount,
          message: "Order placed in processing queue"
        },
      },
      202,
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
