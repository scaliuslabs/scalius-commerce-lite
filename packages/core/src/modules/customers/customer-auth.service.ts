// src/modules/customers/customer-auth.service.ts
// Customer authentication business logic: OTP generation/verification, session management.
// Used by the customer-auth route handler (apps/api/src/routes/customer-auth.ts).

import { nanoid } from "nanoid";
import { customers, siteSettings } from "@scalius/database/schema";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";

// ─────────────────────────────────────────
// Constants
// ─────────────────────────────────────────

export const COOKIE_NAME = "cs_tok";
export const SESSION_PREFIX = "cust_session:";
export const OTP_PREFIX = "cust_otp:";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const OTP_TTL_SECONDS = 60 * 5; // 5 minutes

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export interface CustomerSession {
    token: string;
    email: string;
    name: string;
    phone?: string;
    customerId?: string;
    createdAt: number;
    expiresAt: number;
}

export interface StoredOtp {
    code: string;
    email: string;
    expiresAt: number;
    attempts: number;
}

export interface SendOtpInput {
    method: "email" | "phone";
    identifier: string;
    name: string;
    ip: string;
}

export interface SendOtpResult {
    success: boolean;
    message?: string;
    error?: string;
    retryAfter?: number;
    httpStatus?: number;
    /** Queue payload for async OTP delivery */
    queuePayload?: Record<string, unknown>;
}

export interface VerifyOtpInput {
    method: "email" | "phone";
    identifier: string;
    code: string;
    name: string;
    phone?: string;
}

export interface VerifyOtpResult {
    success: boolean;
    error?: string;
    httpStatus?: number;
    attemptsLeft?: number;
    session?: CustomerSession;
    isNewUser?: boolean;
    customer?: {
        identifier: string;
        name: string;
        email: string;
        phone?: string;
        customerId?: string;
    };
}

// ─────────────────────────────────────────
// Utility functions
// ─────────────────────────────────────────

export function generateOtpCode(): string {
    const array = new Uint8Array(4);
    crypto.getRandomValues(array);
    const num = (new DataView(array.buffer).getUint32(0) % 900000) + 100000;
    return String(num);
}

export function getSessionCookie(cookieHeader: string | null): string | null {
    if (!cookieHeader) return null;
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
    return match ? match[1] : null;
}

export function getRootDomainAttr(url?: string): string {
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

export function isProduction(storefrontUrl?: string): boolean {
    if (!storefrontUrl) return false;
    try {
        const hostname = new URL(storefrontUrl).hostname;
        return hostname !== "localhost" && !hostname.startsWith("127.") && !hostname.startsWith("192.168.");
    } catch { return false; }
}

export function buildSetCookieHeader(token: string, maxAge: number, domainAttr: string, sameSitePolicy: string): string {
    return `${COOKIE_NAME}=${token}; Max-Age=${maxAge}; Path=/${domainAttr}; HttpOnly; SameSite=${sameSitePolicy}; Secure`;
}

export function getCookieConfig(storefrontUrl?: string): { sameSite: string; domainAttr: string } {
    const isProd = isProduction(storefrontUrl);
    return {
        sameSite: isProd ? "None" : "Lax",
        domainAttr: isProd ? getRootDomainAttr(storefrontUrl) : "",
    };
}

// ─────────────────────────────────────────
// Service functions
// ─────────────────────────────────────────

/**
 * Handles OTP generation, rate limiting, and queueing for delivery.
 * Returns a queue payload that the route should send to AUTH_OTP_QUEUE.
 */
export async function sendOtp(
    db: Database,
    kv: KVNamespace,
    input: SendOtpInput,
): Promise<SendOtpResult> {
    const { method, identifier, name, ip } = input;

    // Validate identifier format
    if (!identifier) {
        return { success: false, error: "Contact identifier required (email or phone)", httpStatus: 400 };
    }

    if (method === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) {
        return { success: false, error: "Valid email address required", httpStatus: 400 };
    }

    if (method === "phone" && !/^\+?[1-9]\d{1,14}$/.test(identifier)) {
        return { success: false, error: "Valid phone number required", httpStatus: 400 };
    }

    // Fetch site settings
    const [settings] = await db.select().from(siteSettings).limit(1);

    // Check if the requested method is allowed by admin
    const allowedMethod = settings?.authVerificationMethod || "email";

    let allowedInternalMethods = ["email"];
    if (allowedMethod === "both") {
        allowedInternalMethods = ["email", "phone"];
    } else if (allowedMethod === "phone" || allowedMethod === "whatsapp_otp" || allowedMethod === "sms_otp") {
        allowedInternalMethods = ["phone"];
    }

    if (!allowedInternalMethods.includes(method)) {
        return { success: false, error: `Verification via ${method} is currently disabled by the store.`, httpStatus: 403 };
    }

    const otpKey = `${OTP_PREFIX}${identifier}`;

    // IP-based Rate Limiting (max 5 requests per 10 minutes per IP)
    if (ip !== "unknown") {
        const ipRateKey = `rate_limit_ip:${ip}`;
        const rlWindow = 600;
        let ipCount = 0;
        const countRaw = await kv.get(ipRateKey);
        if (countRaw) {
            ipCount = parseInt(countRaw, 10);
        }

        if (ipCount >= 5) {
            return { success: false, error: "Too many requests from this IP. Please try again later.", httpStatus: 429 };
        }

        await kv.put(ipRateKey, (ipCount + 1).toString(), { expirationTtl: rlWindow });
    }

    // Check if a recent OTP exists (prevent spam — must wait 2 min between sends)
    const existingOtpRaw = await kv.get(otpKey, "text");
    if (existingOtpRaw) {
        const existing = JSON.parse(existingOtpRaw) as StoredOtp;
        const now = Date.now();
        if (existing.expiresAt - now > (OTP_TTL_SECONDS - 120) * 1000) {
            return {
                success: false,
                error: "A verification code was recently sent. Please wait a moment before requesting a new one.",
                retryAfter: 120,
                httpStatus: 429,
            };
        }
    }

    // Generate and store OTP
    const code = generateOtpCode();
    const now = Date.now();
    const storedOtp: StoredOtp = {
        code,
        email: identifier,
        expiresAt: now + OTP_TTL_SECONDS * 1000,
        attempts: 0,
    };

    await kv.put(otpKey, JSON.stringify(storedOtp), { expirationTtl: OTP_TTL_SECONDS });

    if (method === "phone" && allowedMethod === "whatsapp_otp") {
        const waToken = settings?.whatsappAccessToken;
        const waPhoneId = settings?.whatsappPhoneNumberId;
        if (!waToken || !waPhoneId) {
            console.error("[CustomerAuth] WhatsApp API keys missing in DB settings.");
            return { success: false, error: "WhatsApp verification is currently unavailable. Contact store support.", httpStatus: 500 };
        }
    }

    // Build queue payload for async delivery
    const queuePayload = {
        type: "auth.send_otp",
        method,
        allowedMethod,
        identifier,
        code,
        name,
        waToken: settings?.whatsappAccessToken,
        waPhoneId: settings?.whatsappPhoneNumberId,
        waTemplate: settings?.whatsappTemplateName || "auth_otp",
    };

    const successMessage = method === "email"
        ? "Verification code sent to your email"
        : allowedMethod === "whatsapp_otp"
            ? "Verification code sent via WhatsApp"
            : "Verification code sent via SMS";

    return { success: true, message: successMessage, queuePayload };
}

/**
 * Verifies an OTP code and creates a customer session.
 * Handles customer lookup/creation in DB.
 */
export async function verifyOtp(
    db: Database,
    kv: KVNamespace,
    input: VerifyOtpInput,
): Promise<VerifyOtpResult> {
    const { method, identifier, code, name, phone } = input;

    if (!identifier || !code) {
        return { success: false, error: "Contact identifier and code are required", httpStatus: 400 };
    }

    const otpKey = `${OTP_PREFIX}${identifier}`;

    // Fetch stored OTP
    const storedRaw = await kv.get(otpKey, "text");
    if (!storedRaw) {
        return { success: false, error: "No verification code found. Please request a new one.", httpStatus: 400 };
    }

    const stored = JSON.parse(storedRaw) as StoredOtp;

    // Check expiry
    if (Date.now() > stored.expiresAt) {
        await kv.delete(otpKey);
        return { success: false, error: "Verification code has expired. Please request a new one.", httpStatus: 400 };
    }

    // Increment attempts
    stored.attempts++;

    // Max 5 attempts
    if (stored.attempts > 5) {
        await kv.delete(otpKey);
        return { success: false, error: "Too many failed attempts. Please request a new code.", httpStatus: 429 };
    }

    // Verify code
    if (stored.code !== code) {
        const remaining = OTP_TTL_SECONDS - Math.floor((Date.now() - (stored.expiresAt - OTP_TTL_SECONDS * 1000)) / 1000);
        await kv.put(otpKey, JSON.stringify(stored), { expirationTtl: Math.max(remaining, 1) });
        return {
            success: false,
            error: "Incorrect code. Please try again.",
            attemptsLeft: 5 - stored.attempts,
            httpStatus: 400,
        };
    }

    // OTP is valid — delete it
    await kv.delete(otpKey);

    // Look up customer in DB (if exists)
    let customerId: string | undefined;
    let customerName = name;
    let resolvedEmail = method === "email" ? identifier : undefined;
    let resolvedPhone = method === "phone" ? identifier : undefined;
    let isNewUser = false;

    try {
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
                    return { success: false, error: "Phone number is required for registration.", httpStatus: 400 };
                }
                // Prevent duplicates/account takeover
                const phoneExists = await db.select().from(customers).where(eq(customers.phone, phone)).get();
                if (phoneExists) {
                    return { success: false, error: "This phone number is already registered. Please sign in with it instead.", httpStatus: 400 };
                }
            }

            // Create new customer record
            customerId = nanoid();

            const insertPayload: Record<string, unknown> = {
                id: customerId,
                name: customerName,
                status: "active",
            };

            if (resolvedEmail) insertPayload.email = resolvedEmail;
            if (method === "email" && phone) {
                insertPayload.phone = phone;
                resolvedPhone = phone;
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
        email: resolvedEmail || "",
        name: customerName,
        phone: resolvedPhone,
        customerId,
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
    };

    const sessionKey = `${SESSION_PREFIX}${sessionToken}`;
    await kv.put(sessionKey, JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });

    return {
        success: true,
        session,
        isNewUser,
        customer: {
            identifier,
            name: session.name,
            email: session.email,
            phone: session.phone,
            customerId: session.customerId,
        },
    };
}

/**
 * Retrieves the customer session from a session token.
 * Returns null if the session is expired or not found.
 */
export async function getCustomerBySession(
    kv: KVNamespace,
    sessionToken: string,
): Promise<CustomerSession | null> {
    const sessionKey = `${SESSION_PREFIX}${sessionToken}`;
    const sessionRaw = await kv.get(sessionKey, "text");

    if (!sessionRaw) return null;

    const session = JSON.parse(sessionRaw) as CustomerSession;

    if (Date.now() > session.expiresAt) {
        await kv.delete(sessionKey);
        return null;
    }

    return session;
}

/**
 * Deletes a customer session from KV.
 */
export async function deleteCustomerSession(
    kv: KVNamespace,
    sessionToken: string,
): Promise<void> {
    const sessionKey = `${SESSION_PREFIX}${sessionToken}`;
    await kv.delete(sessionKey);
}

/**
 * Updates a customer profile and refreshes the session in KV.
 */
export async function updateCustomerProfile(
    db: Database,
    kv: KVNamespace,
    session: CustomerSession,
    sessionToken: string,
    updates: Record<string, string | undefined>,
): Promise<{ session: CustomerSession; updates: Record<string, string | undefined> }> {
    // Update customer record in DB if customerId exists
    if (session.customerId) {
        const dbUpdates: Record<string, unknown> = {
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

    const remainingTtl = Math.max(
        60,
        Math.floor((session.expiresAt - Date.now()) / 1000),
    );

    const sessionKey = `${SESSION_PREFIX}${sessionToken}`;
    await kv.put(sessionKey, JSON.stringify(updatedSession), {
        expirationTtl: remainingTtl,
    });

    return { session: updatedSession, updates };
}
