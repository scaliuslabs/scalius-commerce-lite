// src/server/routes/customer-auth.ts
// Customer-facing authentication via email OTP.
//
// Endpoints (mounted at /api/v1/customer-auth):
//   POST /send-otp   — generate & email a 6-digit OTP (5-min TTL in KV)
//   POST /verify-otp — verify OTP, create 30-day session in KV, set cookie
//   GET  /me         — return session customer info (reads cookie)
//   POST /logout     — delete session from KV, clear cookie
//   PUT  /profile    — update customer profile
//   GET  /orders     — return orders for authenticated customer
//
// Session storage: Cloudflare KV (binding: CACHE), prefix "cust_session:"
// OTP storage:     Cloudflare KV (binding: CACHE), prefix "cust_otp:"
// Cookie name:     "cs_tok" (httpOnly, SameSite=Strict, Secure)

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  sendOtp,
  verifyOtp,
  getCustomerBySession,
  deleteCustomerSession,
  updateCustomerProfile,
  getSessionCookie,
  getCookieConfig,
  buildSetCookieHeader,
  COOKIE_NAME,
  SESSION_TTL_SECONDS
} from "@scalius/core/modules/customers/customer-auth.service";
import { customers, orders, orderItems, products, productVariants, productImages } from "@scalius/database/schema";
import { eq, sql, desc } from "drizzle-orm";
import { UnauthorizedError } from "../utils/api-error";

const app = new OpenAPIHono<{ Bindings: Env }>();

// ─── POST /send-otp ──────────────────────────────────────────────────────────

const sendOtpRoute = createRoute({
  method: "post",
  path: "/send-otp",
  tags: ["Customer Auth"],
  summary: "Send OTP verification code",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            method: z.enum(["email", "phone"]).optional().default("email"),
            identifier: z.string().openapi({ description: "Email or phone number" }),
            name: z.string().optional()
          })
        }
      }
    }
  },
  responses: {
    200: { description: "OTP sent successfully"  },
    400: { description: "Invalid input"  },
    403: { description: "Method disabled"  },
    429: { description: "Rate limited"  }
  }
});

app.openapi(sendOtpRoute, async (c) => {
  const body = c.req.valid("json");
  const method = body.method || "email";
  const identifier = body.identifier?.trim().toLowerCase();
  const name = body.name?.trim() || "Customer";

  const db = c.get("db");
  const kv = c.env.CACHE;
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";

  const result = await sendOtp(db, kv, { method, identifier: identifier!, name, ip });

  if (!result.success) {
    const status = result.httpStatus || 400;
    if (result.retryAfter) {
      return c.json({ error: result.error, retryAfter: result.retryAfter }, status as any);
    }
    return c.json({ error: result.error }, status as any);
  }

  // Dispatch OTP delivery to queue
  if (result.queuePayload) {
    await c.env.AUTH_OTP_QUEUE.send(result.queuePayload);
  }

  return c.json({ success: true, message: result.message }, 200);
});

// ─── POST /verify-otp ────────────────────────────────────────────────────────

const verifyOtpRoute = createRoute({
  method: "post",
  path: "/verify-otp",
  tags: ["Customer Auth"],
  summary: "Verify OTP and create session",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            method: z.enum(["email", "phone"]).optional().default("email"),
            identifier: z.string().openapi({ description: "Email or phone number" }),
            code: z.string().openapi({ description: "6-digit OTP code" }),
            name: z.string().optional(),
            phone: z.string().optional()
          })
        }
      }
    }
  },
  responses: {
    200: { description: "OTP verified, session created"  },
    400: { description: "Invalid code or input"  },
    429: { description: "Too many attempts"  }
  }
});

app.openapi(verifyOtpRoute, async (c) => {
  const body = c.req.valid("json");
  const method = body.method || "email";
  const identifier = body.identifier?.trim().toLowerCase();
  const code = body.code?.trim();
  const name = body.name?.trim() || "Customer";
  const phone = body.phone?.trim();

  const db = c.get("db");
  const kv = c.env.CACHE;

  const result = await verifyOtp(db, kv, {
    method,
    identifier: identifier!,
    code: code!,
    name,
    phone
  });

  if (!result.success) {
    const status = result.httpStatus || 400;
    const payload: any = { error: result.error };
    if (result.attemptsLeft !== undefined) {
      payload.attemptsLeft = result.attemptsLeft;
    }
    return c.json(payload, status as any);
  }

  // Set cookies
  const { sameSite, domainAttr } = getCookieConfig(c.env.STOREFRONT_URL as string | undefined);
  c.header("Set-Cookie", buildSetCookieHeader(result.session!.token, SESSION_TTL_SECONDS, domainAttr, sameSite));
  c.header("Set-Cookie", `cs_auth=1; Max-Age=${SESSION_TTL_SECONDS}; Path=/${domainAttr}; SameSite=${sameSite}; Secure`, { append: true });

  return c.json({
    success: true,
    customer: result.customer,
    isNewUser: result.isNewUser
  }, 200);
});

// ─── GET /me ─────────────────────────────────────────────────────────────────

const getMeRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["Customer Auth"],
  summary: "Get current customer session info",
  responses: {
    200: { description: "Customer session info"  }
  }
});

app.openapi(getMeRoute, async (c) => {
  const cookieHeader = c.req.header("Cookie") || null;
  const token = getSessionCookie(cookieHeader);

  if (!token) {
    return c.json({ authenticated: false }, 200);
  }

  const kv = c.env.CACHE;
  const session = await getCustomerBySession(kv, token);

  if (!session) {
    return c.json({ authenticated: false }, 200);
  }

  return c.json({
    authenticated: true,
    customer: {
      email: session.email,
      name: session.name,
      phone: session.phone,
      customerId: session.customerId
    }
  }, 200);
});

// ─── POST /logout ────────────────────────────────────────────────────────────

const logoutRoute = createRoute({
  method: "post",
  path: "/logout",
  tags: ["Customer Auth"],
  summary: "Logout and clear session",
  responses: {
    200: { description: "Logged out successfully"  }
  }
});

app.openapi(logoutRoute, async (c) => {
  const { sameSite, domainAttr } = getCookieConfig(c.env.STOREFRONT_URL as string | undefined);

  // Always clear cookies first
  c.header("Set-Cookie", `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=${sameSite}; Secure`);
  c.header("Set-Cookie", `cs_auth=; Max-Age=0; Path=/; SameSite=${sameSite}; Secure`, { append: true });

  // Domain-scoped clears
  if (domainAttr) {
    c.header("Set-Cookie", `${COOKIE_NAME}=; Max-Age=0; Path=/${domainAttr}; HttpOnly; SameSite=${sameSite}; Secure`, { append: true });
    c.header("Set-Cookie", `cs_auth=; Max-Age=0; Path=/${domainAttr}; SameSite=${sameSite}; Secure`, { append: true });
  }

  // Delete KV session (best-effort)
  try {
    const cookieHeader = c.req.header("Cookie") || null;
    const token = getSessionCookie(cookieHeader);
    if (token) {
      await deleteCustomerSession(c.env.CACHE, token);
    }
  } catch (error) {
    console.error("[CustomerAuth] KV session delete failed:", error);
  }

  return c.json({ success: true }, 200);
});

// ─── PUT /profile ────────────────────────────────────────────────────────────

const updateProfileRoute = createRoute({
  method: "put",
  path: "/profile",
  tags: ["Customer Auth"],
  summary: "Update customer profile",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
            address: z.string().optional(),
            city: z.string().optional(),
            zone: z.string().optional(),
            cityName: z.string().optional(),
            zoneName: z.string().optional()
          })
        }
      }
    }
  },
  responses: {
    200: { description: "Profile updated"  },
    401: { description: "Authentication required"  }
  }
});

app.openapi(updateProfileRoute, async (c) => {
  const cookieHeader = c.req.header("Cookie") || null;
  const token = getSessionCookie(cookieHeader);

  if (!token) {
    throw new UnauthorizedError("Authentication required");
  }

  const kv = c.env.CACHE;
  const session = await getCustomerBySession(kv, token);

  if (!session) {
    throw new UnauthorizedError("Session expired. Please log in again.");
  }

  const body = c.req.valid("json");

  // Sanitize inputs
  const updates: Record<string, string | undefined> = {};
  if (body.name?.trim()) updates.name = body.name.trim();
  if (body.address?.trim()) updates.address = body.address.trim();
  if (body.city?.trim()) updates.city = body.city.trim();
  if (body.zone?.trim()) updates.zone = body.zone.trim();
  if (body.cityName?.trim()) updates.cityName = body.cityName.trim();
  if (body.zoneName?.trim()) updates.zoneName = body.zoneName.trim();

  const db = c.get("db");
  const result = await updateCustomerProfile(db, kv, session, token, updates);

  return c.json({
    success: true,
    customer: {
      email: result.session.email,
      name: result.session.name,
      phone: result.session.phone,
      address: updates.address,
      cityName: updates.cityName,
      zoneName: updates.zoneName
    }
  }, 200);
});

// ─── GET /orders ──────────────────────────────────────────────────────────────

const getCustomerOrdersRoute = createRoute({
  method: "get",
  path: "/orders",
  tags: ["Customer Auth"],
  summary: "Get orders for authenticated customer",
  responses: {
    200: { description: "Customer orders list"  },
    401: { description: "Authentication required"  }
  }
});

app.openapi(getCustomerOrdersRoute, async (c) => {
  const cookieHeader = c.req.header("Cookie") || null;
  const token = getSessionCookie(cookieHeader);

  if (!token) {
    throw new UnauthorizedError("Authentication required");
  }

  const kv = c.env.CACHE;
  const session = await getCustomerBySession(kv, token);

  if (!session) {
    throw new UnauthorizedError("Session expired. Please log in again.");
  }

  const db = c.get("db");

  // Fetch full customer profile from DB
  let customerProfile: {
    id?: string;
    name: string;
    email: string;
    phone?: string;
    address?: string | null;
    cityName?: string | null;
    zoneName?: string | null;
    city?: string | null;
    zone?: string | null;
  } = {
    name: session.name || "Customer",
    email: session.email,
    phone: session.phone
  };

  if (session.customerId) {
    const dbCustomer = await db
      .select()
      .from(customers)
      .where(eq(customers.id, session.customerId))
      .get();

    if (dbCustomer) {
      customerProfile = {
        id: dbCustomer.id,
        name: dbCustomer.name || session.name || "Customer",
        email: dbCustomer.email || session.email,
        phone: dbCustomer.phone || session.phone,
        address: dbCustomer.address,
        cityName: dbCustomer.cityName,
        zoneName: dbCustomer.zoneName,
        city: dbCustomer.city,
        zone: dbCustomer.zone
      };
    }
  }

  // Match orders EXCLUSIVELY by customerId
  if (!session.customerId) {
    return c.json({ success: true, orders: [], customer: customerProfile }, 200);
  }

  const whereClause = eq(orders.customerId, session.customerId);

  const customerOrders = await db
    .select({
      id: orders.id,
      status: orders.status,
      totalAmount: orders.totalAmount,
      paidAmount: orders.paidAmount,
      shippingCharge: orders.shippingCharge,
      discountAmount: orders.discountAmount,
      paymentStatus: orders.paymentStatus,
      paymentMethod: orders.paymentMethod,
      fulfillmentStatus: orders.fulfillmentStatus,
      shippingAddress: orders.shippingAddress,
      cityName: orders.cityName,
      zoneName: orders.zoneName,
      notes: orders.notes,
      createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`
    })
    .from(orders)
    .where(whereClause)
    .orderBy(desc(orders.createdAt))
    .limit(50);

  // Fetch items for all orders in one batch
  const orderIds = customerOrders.map((o) => o.id);
  let itemsByOrder = new Map<string, any[]>();

  if (orderIds.length > 0) {
    const allItems = await db
      .select({
        orderId: orderItems.orderId,
        productId: orderItems.productId,
        variantId: orderItems.variantId,
        quantity: orderItems.quantity,
        price: orderItems.price,
        productName: products.name,
        productSlug: products.slug,
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
      .where(sql`${orderItems.orderId} IN ${orderIds}`);

    for (const item of allItems) {
      const list = itemsByOrder.get(item.orderId) || [];
      list.push(item);
      itemsByOrder.set(item.orderId, list);
    }
  }

  // Format response
  const formattedOrders = customerOrders.map((order) => ({
    ...order,
    createdAt: order.createdAt
      ? new Date(order.createdAt * 1000).toISOString()
      : null,
    items: itemsByOrder.get(order.id) || []
  }));

  return c.json({
    success: true,
    orders: formattedOrders,
    customer: customerProfile
  }, 200);
});

export { app as customerAuthRoutes };
