import { customerAuthOtpRateLimits } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { and, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import { RateLimitError } from "@scalius/core/errors";

/**
 * Rate limits that can't be turned against a buyer.
 * - Per contact AND sender (email/phone/order reference + IP): stops one source
 *   from flooding a contact without touching anyone else's requests.
 * - Per contact overall: a higher ceiling that caps inbox/SMS spam from many
 *   sources. When it trips, the last code already sent stays usable longer
 *   (see sendOtp), so an attacker can't strand the owner.
 * - Per IP: only a generous flood ceiling, because Bangladeshi carriers put
 *   many buyers behind one CGNAT address.
 * The resend cooldown escalates with the contact's recent sends (60 s, 2 min,
 * 4 min … up to 10 min).
 */
export const OTP_CONTACT_SENDER_RATE_LIMIT = { attempts: 5, windowSeconds: 15 * 60 } as const;
export const OTP_CONTACT_RATE_LIMIT = { attempts: 10, windowSeconds: 60 * 60 } as const;
export const OTP_IP_RATE_LIMIT = { attempts: 30, windowSeconds: 10 * 60 } as const;
const BASE_RESEND_COOLDOWN_SECONDS = 60;
const MAX_RESEND_COOLDOWN_SECONDS = 10 * 60;

export const OTP_RATE_LIMIT_MESSAGE = "Too many codes.";
export const OTP_CONTACT_CEILING_MESSAGE = "Too many codes. Enter the latest code we sent.";

export interface CleanupExpiredCustomerAuthOtpRateLimitsResult {
    scanned: number;
    deleted: number;
    limit: number;
    hasMore: boolean;
}

export interface OtpSendAllowance {
    /** Cooldown before the next code for these contacts, escalating with recent sends. */
    resendCooldownSeconds: number;
}

/** Thrown when a contact's overall ceiling (not one sender's) is reached. */
export class OtpContactCeilingError extends RateLimitError {
    constructor(retryAfterSeconds: number) {
        super(OTP_CONTACT_CEILING_MESSAGE, retryAfterSeconds);
    }
}

/**
 * Counts one code request against every contact it targets, per sender and
 * overall, and the caller's IP. Throws RateLimitError with the honest wait
 * (seconds until that bucket's window resets) once any bucket is full.
 */
export async function enforceOtpSendRateLimits(
    db: Database,
    input: {
        ip: string;
        identifiers: string[];
        hashKey?: string;
        nowSeconds?: number;
    },
): Promise<OtpSendAllowance> {
    const nowSeconds = input.nowSeconds ?? currentUnixSeconds();
    const ip = input.ip.trim() || "unknown";
    const contacts = [...new Set(input.identifiers.map((value) => value.trim().toLowerCase()).filter(Boolean))];
    let recentContactSends = 1;
    for (const contact of contacts) {
        const sender = await consumeRateLimitBucket(db, {
            scope: "identifier", subject: `${contact}|${ip}`, ...OTP_CONTACT_SENDER_RATE_LIMIT, hashKey: input.hashKey, nowSeconds,
        });
        if ("retryAfterSeconds" in sender) throw new RateLimitError(OTP_RATE_LIMIT_MESSAGE, sender.retryAfterSeconds);
        const overall = await consumeRateLimitBucket(db, {
            scope: "identifier", subject: contact, ...OTP_CONTACT_RATE_LIMIT, hashKey: input.hashKey, nowSeconds,
        });
        if ("retryAfterSeconds" in overall) throw new OtpContactCeilingError(overall.retryAfterSeconds);
        recentContactSends = Math.max(recentContactSends, overall.attempts);
    }
    const flood = await consumeRateLimitBucket(db, { scope: "ip", subject: ip, ...OTP_IP_RATE_LIMIT, hashKey: input.hashKey, nowSeconds });
    if ("retryAfterSeconds" in flood) throw new RateLimitError(OTP_RATE_LIMIT_MESSAGE, flood.retryAfterSeconds);
    return {
        resendCooldownSeconds: Math.min(
            MAX_RESEND_COOLDOWN_SECONDS,
            BASE_RESEND_COOLDOWN_SECONDS * 2 ** Math.max(0, recentContactSends - 2),
        ),
    };
}

async function consumeRateLimitBucket(
    db: Database,
    input: {
        scope: "ip" | "identifier";
        subject: string;
        attempts: number;
        windowSeconds: number;
        hashKey?: string;
        nowSeconds: number;
    },
): Promise<{ attempts: number } | { retryAfterSeconds: number }> {
    const { nowSeconds } = input;
    const key = await buildCustomerAuthOtpRateLimitKey(input.scope, input.subject, input.hashKey);
    const windowExpiresAt = nowSeconds + input.windowSeconds;

    const inserted = await db
        .insert(customerAuthOtpRateLimits)
        .values({
            key,
            scope: input.scope,
            attempts: 1,
            windowExpiresAt,
            createdAt: nowSeconds,
            updatedAt: nowSeconds,
        })
        .onConflictDoNothing()
        .returning({ key: customerAuthOtpRateLimits.key });
    if (inserted[0]?.key) return { attempts: 1 };

    const reset = await db
        .update(customerAuthOtpRateLimits)
        .set({ attempts: 1, windowExpiresAt, updatedAt: nowSeconds })
        .where(and(
            eq(customerAuthOtpRateLimits.key, key),
            lte(customerAuthOtpRateLimits.windowExpiresAt, nowSeconds),
        ))
        .returning({ key: customerAuthOtpRateLimits.key });
    if (reset[0]?.key) return { attempts: 1 };

    const incremented = await db
        .update(customerAuthOtpRateLimits)
        .set({ attempts: sql`${customerAuthOtpRateLimits.attempts} + 1`, updatedAt: nowSeconds })
        .where(and(
            eq(customerAuthOtpRateLimits.key, key),
            gt(customerAuthOtpRateLimits.windowExpiresAt, nowSeconds),
            lt(customerAuthOtpRateLimits.attempts, input.attempts),
        ))
        .returning({ attempts: customerAuthOtpRateLimits.attempts });
    if (incremented[0]) return { attempts: incremented[0].attempts };

    const row = await db
        .select({ windowExpiresAt: customerAuthOtpRateLimits.windowExpiresAt })
        .from(customerAuthOtpRateLimits)
        .where(eq(customerAuthOtpRateLimits.key, key))
        .get();
    return { retryAfterSeconds: Math.max(1, (row?.windowExpiresAt ?? windowExpiresAt) - nowSeconds) };
}

export async function cleanupExpiredCustomerAuthOtpRateLimits(
    db: Database,
    nowSeconds = currentUnixSeconds(),
    options: { limit?: number } = {},
): Promise<CleanupExpiredCustomerAuthOtpRateLimitsResult> {
    const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
    const rows = await db
        .select({ key: customerAuthOtpRateLimits.key })
        .from(customerAuthOtpRateLimits)
        .where(lte(customerAuthOtpRateLimits.windowExpiresAt, nowSeconds))
        .limit(limit + 1);

    const deleteKeys = rows.slice(0, limit).map((row) => row.key);
    if (deleteKeys.length > 0) {
        await db.delete(customerAuthOtpRateLimits)
            .where(inArray(customerAuthOtpRateLimits.key, deleteKeys));
    }

    return {
        scanned: Math.min(rows.length, limit),
        deleted: deleteKeys.length,
        limit,
        hasMore: rows.length > limit,
    };
}

async function buildCustomerAuthOtpRateLimitKey(
    scope: "ip" | "identifier",
    identifier: string,
    hashKey: string | undefined,
): Promise<string> {
    const material = `${scope}:${identifier}`;
    const digest = hashKey?.trim()
        ? await hmacSha256Hex(hashKey.trim(), `customer-auth-otp-rate-limit:${material}`)
        : await sha256Hex(`customer-auth-otp-rate-limit:${material}`);
    return `customer_auth_otp:${scope}:${digest}`;
}

function currentUnixSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
    return bytesToHex(signature);
}

async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return bytesToHex(digest);
}

function bytesToHex(value: ArrayBuffer): string {
    return Array.from(new Uint8Array(value))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}
