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
import { customers } from "@/db/schema";
import { eq } from "drizzle-orm";

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

function buildSetCookieHeader(token: string, maxAge: number): string {
  return `${COOKIE_NAME}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict; Secure`;
}

const app = new Hono<{ Bindings: Env }>();

// ─── POST /send-otp ──────────────────────────────────────────────────────────
// Body: { email: string, name?: string }
// Rate limiting: checked via OTP TTL (can't spam — existing OTP blocks new one for 2 min)

app.post("/send-otp", async (c) => {
  try {
    const body = await c.req.json() as { email?: string; name?: string };
    const email = body.email?.trim().toLowerCase();
    const name = body.name?.trim() || "Customer";

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ error: "Valid email address required" }, 400);
    }

    const kv = c.env.CACHE;
    const otpKey = `${OTP_PREFIX}${email}`;

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
      email,
      expiresAt: now + OTP_TTL_SECONDS * 1000,
      attempts: 0,
    };

    await kv.put(otpKey, JSON.stringify(storedOtp), { expirationTtl: OTP_TTL_SECONDS });

    // Send OTP email
    await sendEmail({
      to: email,
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
  } catch (error) {
    console.error("[CustomerAuth] send-otp error:", error);
    return c.json({ error: "Failed to send verification code" }, 500);
  }
});

// ─── POST /verify-otp ────────────────────────────────────────────────────────
// Body: { email: string, code: string, name?: string, phone?: string }
// Returns: { success: true, customer: { email, name, phone?, customerId? } }
// Sets cookie: cs_tok=<session_token>

app.post("/verify-otp", async (c) => {
  try {
    const body = await c.req.json() as { 
      email?: string; 
      code?: string;
      name?: string;
      phone?: string;
    };
    const email = body.email?.trim().toLowerCase();
    const code = body.code?.trim();
    const name = body.name?.trim() || "Customer";
    const phone = body.phone?.trim() || undefined;

    if (!email || !code) {
      return c.json({ error: "Email and code are required" }, 400);
    }

    const kv = c.env.CACHE;
    const otpKey = `${OTP_PREFIX}${email}`;

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

    // Look up customer by email in DB (if exists)
    const db = c.get("db");
    let customerId: string | undefined;
    let customerName = name;
    let customerPhone = phone;

    try {
      const existing = await db.select().from(customers).where(eq(customers.email, email)).get();
      if (existing) {
        customerId = existing.id;
        customerName = existing.name || name;
        customerPhone = existing.phone || phone;
      }
    } catch (dbError) {
      console.warn("[CustomerAuth] DB lookup failed (non-critical):", dbError);
    }

    // Create session
    const sessionToken = nanoid(48);
    const session: CustomerSession = {
      token: sessionToken,
      email,
      name: customerName,
      phone: customerPhone,
      customerId,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
    };

    const sessionKey = `${SESSION_PREFIX}${sessionToken}`;
    await kv.put(sessionKey, JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });

    const cookieHeader = buildSetCookieHeader(sessionToken, SESSION_TTL_SECONDS);

    return new Response(
      JSON.stringify({
        success: true,
        customer: {
          email: session.email,
          name: session.name,
          phone: session.phone,
          customerId: session.customerId,
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": cookieHeader,
        },
      },
    );
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
  try {
    const cookieHeader = c.req.header("Cookie") || null;
    const token = getSessionCookie(cookieHeader);

    if (token) {
      const kv = c.env.CACHE;
      await kv.delete(`${SESSION_PREFIX}${token}`);
    }

    const clearCookie = `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict; Secure`;

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": clearCookie,
      },
    });
  } catch (error) {
    console.error("[CustomerAuth] logout error:", error);
    return c.json({ success: true }, 200);
  }
});

export { app as customerAuthRoutes };
