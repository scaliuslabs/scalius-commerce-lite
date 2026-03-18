import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import {
  orders,
  orderItems,
  productVariants,
  products,
  productImages,
  PaymentMethod,
  InventoryPool
} from "@scalius/database/schema";
import { isDiscountValid, calculateDiscountAmount } from "./discounts";
import { eq, sql } from "drizzle-orm";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";
import { getShipments, getActiveDeliveryProviders } from "@scalius/core/modules/delivery/service";
import { createStorefrontOrder } from "@scalius/core/modules/orders";
import { cacheMiddleware } from "../middleware/cache";
import { CACHE_TTLS } from "../utils/cache-ttls";
import { NotFoundError, ValidationError } from "../utils/api-error";

import { ok } from "../utils/api-response";
const app = new OpenAPIHono<{ Bindings: Env }>();

const unixToDate = (timestamp: number | null): Date | null => {
  if (!timestamp) return null;
  return new Date(timestamp * 1000);
};

// ─── GET /:id ────────────────────────────────────────────────────────────────

app.use(
  "/:id",
  cacheMiddleware({
    ttl: CACHE_TTLS.SHORT,
    methods: ["GET"],
    varyByQuery: false,
    varyByAuth: true
  }),
);

const getOrderRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Orders"],
  summary: "Get order by ID",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: { description: "Order details"  },
    404: { description: "Order not found"  }
  }
});

app.openapi(getOrderRoute, async (c) => {
  const db = c.get("db");
  const id = c.req.valid("param").id;

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
      updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`
    })
    .from(orders)
    .where(eq(orders.id, id));

  if (!orderResult || orderResult.length === 0) {
    throw new NotFoundError("Order not found");
  }
  const order = orderResult[0];
  if (!order) throw new NotFoundError("Order not found");

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
      variantColor: productVariants.color
    })
    .from(orderItems)
    .leftJoin(products, eq(products.id, orderItems.productId))
    .leftJoin(productVariants, eq(productVariants.id, orderItems.variantId))
    .where(eq(orderItems.orderId, id));

  const shipments = await getShipments(db, id);
  const activeProviders = await getActiveDeliveryProviders(db);

  const formattedOrder = {
    ...order,
    createdAt: unixToDate(order.createdAt)?.toISOString() || null,
    updatedAt: unixToDate(order.updatedAt)?.toISOString() || null,
    items,
    shipments,
    deliveryProviders: activeProviders
  };

  return ok(c, { order: formattedOrder });
});

// ─── GET /status/:token ──────────────────────────────────────────────────────

const getOrderStatusRoute = createRoute({
  method: "get",
  path: "/status/{token}",
  tags: ["Orders"],
  summary: "Check order processing status by checkout token",
  request: {
    params: z.object({
      token: z.string(),
    }),
  },
  responses: {
    200: { description: "Order status"  },
    202: { description: "Order is processing"  },
    400: { description: "Invalid token"  }
  }
});

app.openapi(getOrderStatusRoute, async (c) => {
  const token = c.req.valid("param").token;
  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");

  if (!token || !token.startsWith("chk_")) {
    throw new ValidationError("Invalid checkout token");
  }

  if (!c.env.CACHE) {
    console.warn("[Orders] Polling endpoint hit but CACHE KV is not bound!");
    return ok(c, { status: "processing" });
  }

  const kvKey = `checkout_status:${token}`;
  const statusStr = await c.env.CACHE.get(kvKey);

  if (!statusStr) {
    return c.json({ success: true, data: { status: "processing", message: "Order is waiting in queue." } }, 202);
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
      return ok(c, { status: "completed", orderId: statusData.orderId });
    }
  }

  return ok(c, statusData);
});

// ─── POST / ──────────────────────────────────────────────────────────────────

const createOrderSchema = z.object({
  customerName: z
    .string()
    .min(3, "Customer name must be at least 3 characters")
    .max(100, "Customer name must be less than 100 characters"),
  customerPhone: phoneNumberSchema,
  customerEmail: z.email().nullable(),
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
      variantLabel: z.string().optional().nullable()
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
    .default(InventoryPool.REGULAR)
});

const createOrderRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Orders"],
  summary: "Create a new storefront order",
  request: {
    body: {
      content: {
        "application/json": {
          schema: createOrderSchema
        }
      }
    }
  },
  responses: {
    202: { description: "Order placed in processing queue"  },
    400: { description: "Validation error"  }
  }
});

app.openapi(createOrderRoute, async (c) => {
  const db = c.get("db");
  const data = c.req.valid("json");
  const requestUrl = c.req.url;

  try {
    type CartItem = { id: string; price: number; quantity: number; variantId?: string };
    const result = await createStorefrontOrder(
      db,
      data,
      requestUrl,
      (db, code, total, items, customerPhone) => isDiscountValid(db, code, total, items as CartItem[], customerPhone),
      (db, discount, total, items, shippingCost) => calculateDiscountAmount(
        db,
        discount as { id: string; type: string; valueType: string; discountValue: number },
        total,
        items as CartItem[],
        shippingCost,
      ),
    );

    // Dispatch to Cloudflare Queue
    await c.env.ORDER_INGEST_QUEUE.send(result.queuePayload);

    // Write initial pending state to KV so the Storefront can poll it
    const kvKey = `checkout_status:${result.checkoutToken}`;
    await c.env.CACHE.put(
      kvKey,
      JSON.stringify({ status: "processing", orderId: result.orderId }),
      { expirationTtl: 300 },
    );

    return c.json(
      {
        success: true,
        data: {
          checkoutToken: result.checkoutToken,
          orderId: result.orderId,
          paymentMethod: result.paymentMethod,
          totalAmount: result.totalAmount,
          message: "Order placed in processing queue"
        }
      },
      202,
    );
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("VALIDATION_ERROR:")) {
      throw new ValidationError(error.message.replace("VALIDATION_ERROR:", ""));
    }

    if (error instanceof Error && error.message.startsWith("INSUFFICIENT_STOCK:")) {
      throw new ValidationError(error.message.replace("INSUFFICIENT_STOCK:", ""));
    }

    if (error instanceof z.ZodError) {
      throw new ValidationError("Invalid input data", error.issues);
    }

    // Re-throw for global error handler
    throw error;
  }
});

// Export the order routes
export { app as orderRoutes };
