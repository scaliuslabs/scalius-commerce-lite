import { customerAuthOtpRateLimits } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { and, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import { RateLimitError } from "@scalius/core/errors";

export const CUSTOMER_AUTH_OTP_IP_RATE_LIMIT_ATTEMPTS = 5;
export const CUSTOMER_AUTH_OTP_IP_RATE_LIMIT_WINDOW_SECONDS = 10 * 60;

export interface CleanupExpiredCustomerAuthOtpRateLimitsResult {
    scanned: number;
    deleted: number;
    limit: number;
    hasMore: boolean;
}

export async function enforceCustomerAuthOtpIpRateLimit(
    db: Database,
    input: {
        ip: string;
        hashKey?: string;
        nowSeconds?: number;
    },
): Promise<void> {
    const ip = input.ip.trim() || "unknown";

    const nowSeconds = input.nowSeconds ?? currentUnixSeconds();
    const key = await buildCustomerAuthOtpRateLimitKey("ip", ip, input.hashKey);
    const windowExpiresAt = nowSeconds + CUSTOMER_AUTH_OTP_IP_RATE_LIMIT_WINDOW_SECONDS;

    const inserted = await db
        .insert(customerAuthOtpRateLimits)
        .values({
            key,
            scope: "ip",
            attempts: 1,
            windowExpiresAt,
            createdAt: nowSeconds,
            updatedAt: nowSeconds,
        })
        .onConflictDoNothing()
        .returning({ key: customerAuthOtpRateLimits.key });

    if (inserted[0]?.key) return;

    const reset = await db
        .update(customerAuthOtpRateLimits)
        .set({
            attempts: 1,
            windowExpiresAt,
            updatedAt: nowSeconds,
        })
        .where(
            and(
                eq(customerAuthOtpRateLimits.key, key),
                lte(customerAuthOtpRateLimits.windowExpiresAt, nowSeconds),
            ),
        )
        .returning({ key: customerAuthOtpRateLimits.key });

    if (reset[0]?.key) return;

    const incremented = await db
        .update(customerAuthOtpRateLimits)
        .set({
            attempts: sql`${customerAuthOtpRateLimits.attempts} + 1`,
            updatedAt: nowSeconds,
        })
        .where(
            and(
                eq(customerAuthOtpRateLimits.key, key),
                gt(customerAuthOtpRateLimits.windowExpiresAt, nowSeconds),
                lt(customerAuthOtpRateLimits.attempts, CUSTOMER_AUTH_OTP_IP_RATE_LIMIT_ATTEMPTS),
            ),
        )
        .returning({
            key: customerAuthOtpRateLimits.key,
            attempts: customerAuthOtpRateLimits.attempts,
        });

    if (incremented[0]?.key) return;

    const row = await db
        .select({
            attempts: customerAuthOtpRateLimits.attempts,
            windowExpiresAt: customerAuthOtpRateLimits.windowExpiresAt,
        })
        .from(customerAuthOtpRateLimits)
        .where(eq(customerAuthOtpRateLimits.key, key))
        .get();

    if (
        row &&
        row.windowExpiresAt > nowSeconds &&
        row.attempts >= CUSTOMER_AUTH_OTP_IP_RATE_LIMIT_ATTEMPTS
    ) {
        throw new RateLimitError(
            "Too many requests from this IP. Please try again later.",
            Math.max(1, row.windowExpiresAt - nowSeconds),
        );
    }
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
    scope: "ip",
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
