// src/server/routes/customer-auth.ts
// Customer-facing authentication via email OTP.
//
// Endpoints (mounted at /api/v1/customer-auth):
//   POST /send-otp   — generate & email a 6-digit OTP (5-min TTL in KV)
//   POST /verify-otp — verify OTP, create 30-day session in KV, set cookie
//   GET  /me         — return session customer info (reads cookie)
//   POST /logout     — delete session from KV, clear cookie
//
// Session storage: Cloudflare KV (binding: CACHE), prefix "cust_session:"
// OTP storage:     Cloudflare KV (binding: CACHE), prefix "cust_otp:"
// Cookie name:     "cs_tok" (httpOnly, SameSite=Strict, Secure)

import { Hono } from "hono";
import { nanoid } from "nanoid";
import { sendEmail } from "@/lib/email";
import { customers, siteSettings } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

const COOKIE_NAME = "cs_tok";
const SESSION_PREFIX = "cust_session:";
const OTP_PREFIX = "cust_otp:";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const OTP_TTL_SECONDS = 60 * 5; // 5 minutes
const OTP_LENGTH = 6;

interface CustomerSession {
  token: string;
  email: string;
  name: string;
  phone?: string;
  customerId?: string;
  createdAt: number;
  expiresAt: number;
}

interface StoredOtp {
  code: string;
  email: string;
  expiresAt: number;
  attempts: number;
}

function generateOtp(): string {
  // Cryptographically random 6-digit OTP
  const array = new Uint8Array(4);
  crypto.getRandomValues(array);
  const num = (new DataView(array.buffer).getUint32(0) % 900000) + 100000;
  return String(num);
}

function getSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

function getRootDomainAttr(url?: string): string {
  if (!url) return "";
  try {
    const hostname = new URL(url).hostname;
    const parts = hostname.split(".");
    if (parts.length >= 2 && parts[parts.length - 1] !== "localhost") {
      return `; Domain=.${parts.slice(-2).join(".")}`;
    }
  } catch { }
  return "";
}

/** Detect production from STOREFRONT_URL (not process.env.NODE_ENV which is unreliable in CF Workers). */
function isProduction(env: Env): boolean {
  const url = env.STOREFRONT_URL as string | undefined;
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return hostname !== "localhost" && !hostname.startsWith("127.") && !hostname.startsWith("192.168.");
  } catch { return false; }
}

function buildSetCookieHeader(token: string, maxAge: number, domainAttr: string, sameSitePolicy: string): string {
  return `${COOKIE_NAME}=${token}; Max-Age=${maxAge}; Path=/${domainAttr}; HttpOnly; SameSite=${sameSitePolicy}; Secure`;
}

/** Compute cookie config once — reused by verify-otp, logout, etc. */
function getCookieConfig(env: Env): { sameSite: string; domainAttr: string } {
  const isProd = isProduction(env);
  return {
    sameSite: isProd ? "None" : "Lax",
    domainAttr: isProd ? getRootDomainAttr(env.STOREFRONT_URL as string) : "",
  };
}

const app = new Hono<{ Bindings: Env }>();

// ─── POST /send-otp ──────────────────────────────────────────────────────────
// Body: { method: "email" | "phone", identifier: string, name?: string }
// Rate limiting: checked via OTP TTL (can't spam — existing OTP blocks new one for 2 min)

app.post("/send-otp", async (c) => {
  try {
    const body = await c.req.json() as { method?: "email" | "phone"; identifier?: string; name?: string };
    const method = body.method || "email";
    const identifier = body.identifier?.trim().toLowerCase();
    const name = body.name?.trim() || "Customer";

    if (!identifier) {
      return c.json({ error: "Contact identifier required (email or phone)" }, 400);
    }

    if (method === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) {
      return c.json({ error: "Valid email address required" }, 400);
    }

    if (method === "phone" && !/^\+?[1-9]\d{1,14}$/.test(identifier)) {
      return c.json({ error: "Valid phone number required" }, 400);
    }

    const db = c.get("db");
    const [settings] = await db.select().from(siteSettings).limit(1);

    // Check if the requested method is allowed by admin
    const allowedMethod = settings?.authVerificationMethod || "email";
    if (allowedMethod !== "both" && allowedMethod !== method) {
      return c.json({ error: `Verification via ${method} is currently disabled by the store.` }, 403);
    }

    const kv = c.env.CACHE;
    const otpKey = `${OTP_PREFIX}${identifier}`;

    // Check if a recent OTP exists (prevent spam — must wait 2 min between sends)
    const existingOtpRaw = await kv.get(otpKey, "text");
    if (existingOtpRaw) {
      const existing = JSON.parse(existingOtpRaw) as StoredOtp;
      const now = Date.now();
      const minWait = 2 * 60 * 1000; // 2 minutes
      const timeLeft = Math.ceil((existing.expiresAt - now + OTP_TTL_SECONDS * 1000 - minWait * 1000 / 1000) / 1000);
      if (existing.expiresAt - now > (OTP_TTL_SECONDS - 120) * 1000) {
        // OTP was created less than 2 min ago
        return c.json({
          error: "A verification code was recently sent. Please wait a moment before requesting a new one.",
          retryAfter: 120
        }, 429);
      }
    }

    // Generate and store OTP
    const code = generateOtp();
    const now = Date.now();
    const storedOtp: StoredOtp = {
      code,
      email: identifier, // Using "email" as the generic identifier property for backwards compatibility in StoredOtp interface
      expiresAt: now + OTP_TTL_SECONDS * 1000,
      attempts: 0,
    };

    await kv.put(otpKey, JSON.stringify(storedOtp), { expirationTtl: OTP_TTL_SECONDS });

    if (method === "email") {
      // Send OTP email
      await sendEmail({
        to: identifier,
        subject: "Your login code",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
            <h2 style="font-size: 20px; margin-bottom: 8px;">Your login code</h2>
            <p style="color: #555; margin-bottom: 24px;">Hi ${name}, enter this code to sign in:</p>
            <div style="background: #f5f5f5; border-radius: 12px; padding: 28px; text-align: center; margin-bottom: 24px;">
              <span style="font-size: 40px; font-weight: 700; letter-spacing: 10px; font-family: monospace; color: #111;">${code}</span>
            </div>
            <p style="color: #888; font-size: 13px;">This code expires in 5 minutes. If you didn't request this, you can ignore this email.</p>
          </div>
        `,
        text: `Your login code is: ${code}\n\nExpires in 5 minutes.`,
      });

      return c.json({ success: true, message: "Verification code sent to your email" });
    } else {
      // Send OTP WhatsApp
      const waToken = settings?.whatsappAccessToken;
      const waPhoneId = settings?.whatsappPhoneNumberId;
      const waTemplate = settings?.whatsappTemplateName || "auth_otp";

      if (!waToken || !waPhoneId) {
        console.error("[CustomerAuth] WhatsApp API keys missing in DB settings.");
        return c.json({ error: "WhatsApp verification is currently unavailable. Contact store support." }, 500);
      }

      const waRes = await fetch(`https://graph.facebook.com/v19.0/${waPhoneId}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${waToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: identifier.replace("+", ""), // FB API expects number without '+'
          type: "template",
          template: {
            name: waTemplate,
            language: { code: "en_US" },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: code }
                ]
              },
              {
                type: "button",
                sub_type: "url",
                index: "0",
                parameters: [
                  { type: "text", text: code }
                ]
              }
            ]
          }
        })
      });

      if (!waRes.ok) {
        const err = await waRes.text();
        console.error("[CustomerAuth] WhatsApp API failed:", err);
        return c.json({ error: "Failed to deliver WhatsApp verification code." }, 500);
      }

      return c.json({ success: true, message: "Verification code sent via WhatsApp" });
    }

  } catch (error) {
    console.error("[CustomerAuth] send-otp error:", error);
    return c.json({ error: "Failed to send verification code" }, 500);
  }
});

// ─── POST /verify-otp ────────────────────────────────────────────────────────
// Body: { method: "email" | "phone", identifier: string, code: string, name?: string }
// Returns: { success: true, customer: { identifier, name, customerId? } }
// Sets cookie: cs_tok=<session_token>, cs_auth=1

app.post("/verify-otp", async (c) => {
  try {
    const body = await c.req.json() as {
      method?: "email" | "phone";
      identifier?: string;
      code?: string;
      name?: string;
      phone?: string;
    };
    const method = body.method || "email";
    const identifier = body.identifier?.trim().toLowerCase();
    const code = body.code?.trim();
    const name = body.name?.trim() || "Customer";
    const phone = body.phone?.trim();

    if (!identifier || !code) {
      return c.json({ error: "Contact identifier and code are required" }, 400);
    }

    const kv = c.env.CACHE;
    const otpKey = `${OTP_PREFIX}${identifier}`;

    // Fetch stored OTP
    const storedRaw = await kv.get(otpKey, "text");
    if (!storedRaw) {
      return c.json({ error: "No verification code found. Please request a new one." }, 400);
    }

    const stored = JSON.parse(storedRaw) as StoredOtp;

    // Check expiry
    if (Date.now() > stored.expiresAt) {
      await kv.delete(otpKey);
      return c.json({ error: "Verification code has expired. Please request a new one." }, 400);
    }

    // Increment attempts
    stored.attempts++;

    // Max 5 attempts
    if (stored.attempts > 5) {
      await kv.delete(otpKey);
      return c.json({ error: "Too many failed attempts. Please request a new code." }, 429);
    }

    // Verify code
    if (stored.code !== code) {
      // Save updated attempts count
      const remaining = OTP_TTL_SECONDS - Math.floor((Date.now() - (stored.expiresAt - OTP_TTL_SECONDS * 1000)) / 1000);
      await kv.put(otpKey, JSON.stringify(stored), { expirationTtl: Math.max(remaining, 1) });
      return c.json({
        error: "Incorrect code. Please try again.",
        attemptsLeft: 5 - stored.attempts
      }, 400);
    }

    // OTP is valid — delete it
    await kv.delete(otpKey);

    // Look up customer in DB (if exists)
    const db = c.get("db");
    let customerId: string | undefined;
    let customerName = name;

    let resolvedEmail = method === "email" ? identifier : undefined;
    let resolvedPhone = method === "phone" ? identifier : undefined;
    let isNewUser = false;

    try {
      // Search via email if it's an email auth, otherwise search via phone
      const existing = method === "email"
        ? await db.select().from(customers).where(eq(customers.email, identifier)).get()
        : await db.select().from(customers).where(eq(customers.phone, identifier)).get();

      if (existing) {
        customerId = existing.id;
        customerName = existing.name || name;
        resolvedEmail = existing.email || resolvedEmail;
        resolvedPhone = existing.phone || resolvedPhone;
      } else {
        if (method === "email") {
          if (!phone) {
            return c.json({ error: "Phone number is required for registration." }, 400);
          }
          // Prevent duplicates/account takeover
          const phoneExists = await db.select().from(customers).where(eq(customers.phone, phone)).get();
          if (phoneExists) {
            return c.json({ error: "This phone number is already registered. Please sign in with WhatsApp." }, 400);
          }
        }

        // Create new customer record
        customerId = nanoid();

        const insertPayload: any = {
          id: customerId,
          name: customerName,
          status: "active",
        };

        if (resolvedEmail) insertPayload.email = resolvedEmail;
        if (method === "email" && phone) {
          insertPayload.phone = phone;
          resolvedPhone = phone; // Ensure session gets the phone
        }
        if (method === "phone") insertPayload.phone = resolvedPhone;

        insertPayload.createdAt = sql`unixepoch()`;
        insertPayload.updatedAt = sql`unixepoch()`;

        await db.insert(customers).values(insertPayload);
        isNewUser = true;
      }
    } catch (dbError) {
      console.warn("[CustomerAuth] DB lookup/insert failed (non-critical):", dbError);
    }

    // Create session
    const sessionToken = nanoid(48);
    const session: CustomerSession = {
      token: sessionToken,
      email: resolvedEmail || "", // Fallback due to legacy strict typings on the session table
      name: customerName,
      phone: resolvedPhone,
      customerId,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
    };

    const sessionKey = `${SESSION_PREFIX}${sessionToken}`;
    await kv.put(sessionKey, JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });

    const { sameSite, domainAttr } = getCookieConfig(c.env);

    // Use c.header() to ensure Hono middleware (CORS) applies to the response
    c.header("Set-Cookie", buildSetCookieHeader(sessionToken, SESSION_TTL_SECONDS, domainAttr, sameSite));
    c.header("Set-Cookie", `cs_auth=1; Max-Age=${SESSION_TTL_SECONDS}; Path=/${domainAttr}; SameSite=${sameSite}; Secure`, { append: true });

    return c.json({
      success: true,
      customer: {
        identifier: identifier,
        name: session.name,
        email: session.email,
        phone: session.phone,
        customerId: session.customerId,
      },
      isNewUser
    });
  } catch (error) {
    console.error("[CustomerAuth] verify-otp error:", error);
    return c.json({ error: "Verification failed" }, 500);
  }
});

// ─── GET /me ─────────────────────────────────────────────────────────────────
// Reads cs_tok cookie, returns session customer info or 401

app.get("/me", async (c) => {
  try {
    const cookieHeader = c.req.header("Cookie") || null;
    const token = getSessionCookie(cookieHeader);

    if (!token) {
      return c.json({ authenticated: false }, 200);
    }

    const kv = c.env.CACHE;
    const sessionKey = `${SESSION_PREFIX}${token}`;
    const sessionRaw = await kv.get(sessionKey, "text");

    if (!sessionRaw) {
      return c.json({ authenticated: false }, 200);
    }

    const session = JSON.parse(sessionRaw) as CustomerSession;

    if (Date.now() > session.expiresAt) {
      await kv.delete(sessionKey);
      return c.json({ authenticated: false }, 200);
    }

    return c.json({
      authenticated: true,
      customer: {
        email: session.email,
        name: session.name,
        phone: session.phone,
        customerId: session.customerId,
      },
    });
  } catch (error) {
    console.error("[CustomerAuth] /me error:", error);
    return c.json({ authenticated: false }, 200);
  }
});

// ─── POST /logout ─────────────────────────────────────────────────────────────

app.post("/logout", async (c) => {
  const { sameSite, domainAttr } = getCookieConfig(c.env);

  // Always clear cookies first — even if KV delete fails, the user must be logged out.
  // Host-only clears (catch cookies set without domain attr):
  c.header("Set-Cookie", `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=${sameSite}; Secure`);
  c.header("Set-Cookie", `cs_auth=; Max-Age=0; Path=/; SameSite=${sameSite}; Secure`, { append: true });

  // Domain-scoped clears (catch cookies set with domain=.wrygo.com):
  if (domainAttr) {
    c.header("Set-Cookie", `${COOKIE_NAME}=; Max-Age=0; Path=/${domainAttr}; HttpOnly; SameSite=${sameSite}; Secure`, { append: true });
    c.header("Set-Cookie", `cs_auth=; Max-Age=0; Path=/${domainAttr}; SameSite=${sameSite}; Secure`, { append: true });
  }

  // Delete KV session (best-effort — cookie clear above is the primary logout mechanism)
  try {
    const cookieHeader = c.req.header("Cookie") || null;
    const token = getSessionCookie(cookieHeader);
    if (token) {
      await c.env.CACHE.delete(`${SESSION_PREFIX}${token}`);
    }
  } catch (error) {
    console.error("[CustomerAuth] KV session delete failed:", error);
  }

  return c.json({ success: true });
});

// ─── PUT /profile ─────────────────────────────────────────────────────────────
// Update customer profile (name, phone, delivery address).
// Requires valid cs_tok session cookie.
// Body: { name?, phone?, address?, cityName?, zoneName?, areaName? }

app.put("/profile", async (c) => {
  try {
    const cookieHeader = c.req.header("Cookie") || null;
    const token = getSessionCookie(cookieHeader);

    if (!token) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const kv = c.env.CACHE;
    const sessionKey = `${SESSION_PREFIX}${token}`;
    const sessionRaw = await kv.get(sessionKey, "text");

    if (!sessionRaw) {
      return c.json({ error: "Session expired. Please log in again." }, 401);
    }

    const session = JSON.parse(sessionRaw) as CustomerSession;

    if (Date.now() > session.expiresAt) {
      await kv.delete(sessionKey);
      return c.json({ error: "Session expired. Please log in again." }, 401);
    }

    const body = await c.req.json() as {
      name?: string;
      address?: string;
      city?: string;
      zone?: string;
      cityName?: string;
      zoneName?: string;
    };

    // Sanitize inputs
    const updates: Record<string, string | undefined> = {};
    if (body.name?.trim()) updates.name = body.name.trim();
    if (body.address?.trim()) updates.address = body.address.trim();
    if (body.city?.trim()) updates.city = body.city.trim();
    if (body.zone?.trim()) updates.zone = body.zone.trim();
    if (body.cityName?.trim()) updates.cityName = body.cityName.trim();
    if (body.zoneName?.trim()) updates.zoneName = body.zoneName.trim();

    // Update customer record in DB if customerId exists
    if (session.customerId) {
      const db = c.get("db");
      const dbUpdates: Record<string, string | Date> = {
        updatedAt: new Date(),
      };
      if (updates.name) dbUpdates.name = updates.name;
      if (updates.address) dbUpdates.address = updates.address;
      if (updates.city) dbUpdates.city = updates.city;
      if (updates.zone) dbUpdates.zone = updates.zone;
      if (updates.cityName) dbUpdates.cityName = updates.cityName;
      if (updates.zoneName) dbUpdates.zoneName = updates.zoneName;

      await db
        .update(customers)
        .set(dbUpdates)
        .where(eq(customers.id, session.customerId));
    }

    // Update session in KV
    const updatedSession: CustomerSession = {
      ...session,
      name: updates.name || session.name,
    };

    // Store updated session with remaining TTL
    const remainingTtl = Math.max(
      60,
      Math.floor((session.expiresAt - Date.now()) / 1000),
    );
    await kv.put(sessionKey, JSON.stringify(updatedSession), {
      expirationTtl: remainingTtl,
    });

    return c.json({
      success: true,
      customer: {
        email: updatedSession.email,
        name: updatedSession.name,
        phone: updatedSession.phone,
        address: updates.address,
        cityName: updates.cityName,
        zoneName: updates.zoneName,
      },
    });
  } catch (error) {
    console.error("[CustomerAuth] /profile error:", error);
    return c.json({ error: "Failed to update profile" }, 500);
  }
});

// ─── GET /orders ──────────────────────────────────────────────────────────────
// Returns orders belonging to the logged-in customer (matched by phone number).
// Requires valid cs_tok session cookie.

app.get("/orders", async (c) => {
  try {
    const cookieHeader = c.req.header("Cookie") || null;
    const token = getSessionCookie(cookieHeader);

    if (!token) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const kv = c.env.CACHE;
    const sessionKey = `${SESSION_PREFIX}${token}`;
    const sessionRaw = await kv.get(sessionKey, "text");

    if (!sessionRaw) {
      return c.json({ error: "Session expired. Please log in again." }, 401);
    }

    const session = JSON.parse(sessionRaw) as CustomerSession;

    if (Date.now() > session.expiresAt) {
      await kv.delete(sessionKey);
      return c.json({ error: "Session expired. Please log in again." }, 401);
    }

    const db = c.get("db");
    const { orders, orderItems, products, productVariants, productImages } = await import("@/db/schema");
    const { eq, or, sql, desc } = await import("drizzle-orm");

    // ── Fetch full customer profile from DB ──────────────────────────────
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
      phone: session.phone,
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
          zone: dbCustomer.zone,
        };
      }
    }

    // ── Match orders EXCLUSIVELY by customerId to perfectly mirror Admin Dashboard ──
    if (!session.customerId) {
      return c.json({ success: true, orders: [], customer: customerProfile });
    }

    const whereClause = eq(orders.customerId, session.customerId);

    const customerOrders = await db
      .select({
        id: orders.id,
        status: orders.status,
        totalAmount: orders.totalAmount,
        shippingCharge: orders.shippingCharge,
        discountAmount: orders.discountAmount,
        paymentStatus: orders.paymentStatus,
        paymentMethod: orders.paymentMethod,
        fulfillmentStatus: orders.fulfillmentStatus,
        shippingAddress: orders.shippingAddress,
        cityName: orders.cityName,
        zoneName: orders.zoneName,
        notes: orders.notes,
        createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
      })
      .from(orders)
      .where(whereClause!)
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
          variantColor: productVariants.color,
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
      items: itemsByOrder.get(order.id) || [],
    }));

    return c.json({
      success: true,
      orders: formattedOrders,
      customer: customerProfile,
    });
  } catch (error) {
    console.error("[CustomerAuth] /orders error:", error);
    return c.json({ error: "Failed to fetch orders" }, 500);
  }
});

export { app as customerAuthRoutes };
