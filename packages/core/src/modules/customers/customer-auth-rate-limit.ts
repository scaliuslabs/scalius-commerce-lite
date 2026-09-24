import { customerAuthOtpRateLimits } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { and, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import { RateLimitError } from "@scalius/core/errors";

/**
 * Codes are limited per contact (email, phone, order reference): that is what
 * an attacker targets. The IP bucket is only a generous flood ceiling,
 * because Bangladeshi carriers put many buyers behind one CGNAT address.
 */
export const OTP_IDENTIFIER_RATE_LIMIT = { attempts: 5, windowSeconds: 15 * 60 } as const;
export const OTP_IP_RATE_LIMIT = { attempts: 30, windowSeconds: 10 * 60 } as const;

export const OTP_RATE_LIMIT_MESSAGE = "Too many codes requested. Please wait and try again.";

export interface CleanupExpiredCustomerAuthOtpRateLimitsResult {
    scanned: number;
    deleted: number;
    limit: number;
    hasMore: boolean;
}

/**
 * Counts one code request against every contact it targets and the caller's
 * IP. Throws RateLimitError with the honest wait (seconds until the fullest
 * bucket's window resets) once any bucket is full.
 */
export async function enforceOtpSendRateLimits(
    db: Database,
    input: {
        ip: string;
        identifiers: string[];
        hashKey?: string;
        nowSeconds?: number;
    },
): Promise<void> {
    const nowSeconds = input.nowSeconds ?? currentUnixSeconds();
    const buckets = [
        ...[...new Set(input.identifiers.map((value) => value.trim().toLowerCase()).filter(Boolean))]
            .map((subject) => ({ scope: "identifier" as const, subject, ...OTP_IDENTIFIER_RATE_LIMIT })),
        { scope: "ip" as const, subject: input.ip.trim() || "unknown", ...OTP_IP_RATE_LIMIT },
    ];
    for (const bucket of buckets) {
        const retryAfterSeconds = await consumeRateLimitBucket(db, { ...bucket, hashKey: input.hashKey, nowSeconds });
        if (retryAfterSeconds !== null) {
            throw new RateLimitError(OTP_RATE_LIMIT_MESSAGE, retryAfterSeconds);
        }
    }
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
): Promise<number | null> {
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
    if (inserted[0]?.key) return null;

    const reset = await db
        .update(customerAuthOtpRateLimits)
        .set({ attempts: 1, windowExpiresAt, updatedAt: nowSeconds })
        .where(and(
            eq(customerAuthOtpRateLimits.key, key),
            lte(customerAuthOtpRateLimits.windowExpiresAt, nowSeconds),
        ))
        .returning({ key: customerAuthOtpRateLimits.key });
    if (reset[0]?.key) return null;

    const incremented = await db
        .update(customerAuthOtpRateLimits)
        .set({ attempts: sql`${customerAuthOtpRateLimits.attempts} + 1`, updatedAt: nowSeconds })
        .where(and(
            eq(customerAuthOtpRateLimits.key, key),
            gt(customerAuthOtpRateLimits.windowExpiresAt, nowSeconds),
            lt(customerAuthOtpRateLimits.attempts, input.attempts),
        ))
        .returning({ key: customerAuthOtpRateLimits.key });
    if (incremented[0]?.key) return null;

    const row = await db
        .select({ windowExpiresAt: customerAuthOtpRateLimits.windowExpiresAt })
        .from(customerAuthOtpRateLimits)
        .where(eq(customerAuthOtpRateLimits.key, key))
        .get();
    return Math.max(1, (row?.windowExpiresAt ?? windowExpiresAt) - nowSeconds);
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
