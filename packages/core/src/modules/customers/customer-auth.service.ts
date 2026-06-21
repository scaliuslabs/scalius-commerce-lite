// src/modules/customers/customer-auth.service.ts
// Customer authentication business logic: OTP generation/verification, session management.
// Used by the customer-auth route handler (apps/api/src/routes/customer-auth.ts).

import { nanoid } from "nanoid";
import { customers, customerSessions, siteSettings, settings as genericSettings } from "@scalius/database/schema";
import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import {
    ValidationError,
    ForbiddenError,
    ServiceUnavailableError,
    UnauthorizedError,
} from "@scalius/core/errors";
import { getOtpTransport, type OtpQueuePayload } from "./otp-transport";
import { createAuthOtpDeliveryKey } from "./otp-delivery-receipts";
import {
    claimCustomerAuthOtpChallenge,
    persistCustomerAuthOtpChallenge,
    deleteCustomerAuthOtpChallenge,
    cleanupExpiredCustomerAuthOtpChallenges,
} from "./customer-auth-otp-challenges";
import {
    cleanupExpiredCustomerAuthOtpRateLimits,
    enforceCustomerAuthOtpIpRateLimit,
} from "./customer-auth-rate-limit";
import { validateAndFormatPhone, isValidPhoneNumber } from "@scalius/shared/customer-utils";
import {
    isContactFieldRequiredForAuthChannel,
    normalizeCustomerAuthMethod,
    normalizeCustomerAuthPolicy,
    resolveCustomerAuthChannelForRequest,
    type CustomerAuthOtpChannel,
    type CustomerAuthPolicyConfig,
} from "@scalius/shared/customer-auth-policy";
import { getWhatsAppCloudApiSettings } from "../../integrations/whatsapp";
import { getSmsProviderReadiness } from "../../integrations/sms";
import { getEmailProviderReadiness, type EmailRuntimeContext } from "../../integrations/email";

// ─────────────────────────────────────────
// Constants
// ─────────────────────────────────────────

export const COOKIE_NAME = "cs_tok";
export const OTP_PREFIX = "cust_otp:";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const OTP_TTL_SECONDS = 60 * 5; // 5 minutes
const OTP_RESEND_COOLDOWN_SECONDS = 120;
const OTP_MAX_ATTEMPTS = 5;

export {
    deleteCustomerAuthOtpChallenge,
    cleanupExpiredCustomerAuthOtpChallenges,
    cleanupExpiredCustomerAuthOtpRateLimits,
};

function getOtpStorageKey(channel: CustomerAuthOtpChannel, normalizedIdentifier: string): string {
    return `${OTP_PREFIX}${channel}:${normalizedIdentifier}`;
}

function getFallbackOtpChannel(method: "email" | "phone"): CustomerAuthOtpChannel {
    return method === "email" ? "email" : "sms";
}

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

export type CustomerAuthIntent = "sign_in" | "sign_up";

export interface SendOtpInput {
    method: "email" | "phone";
    channel?: CustomerAuthOtpChannel;
    identifier: string;
    name: string;
    ip: string;
    intent?: CustomerAuthIntent;
    phone?: string;
    email?: string;
    emailEnv?: EmailRuntimeContext["env"];
    encryptionKey?: string;
    credentialEncryptionKey?: string;
    migrationEncryptionKey?: string;
}

export interface SendOtpResult {
    success: boolean;
    message?: string;
    error?: string;
    retryAfter?: number;
    httpStatus?: number;
    /** Queue payload for async OTP delivery */
    queuePayload?: OtpQueuePayload;
    /** Exact D1 challenge key used for this OTP attempt, so route-level queue failures can clear cooldown state. */
    otpStorageKey?: string;
    /** Stable per-attempt delivery key used for provider idempotency and D1 receipt fencing. */
    deliveryKey?: string;
}

export interface VerifyOtpInput {
    method: "email" | "phone";
    channel?: CustomerAuthOtpChannel;
    identifier: string;
    code: string;
    name: string;
    intent?: CustomerAuthIntent;
    phone?: string;
    email?: string;
    encryptionKey?: string;
    sessionHashKey?: string;
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

export interface CleanupExpiredCustomerSessionsResult {
    scanned: number;
    deleted: number;
    limit: number;
    hasMore: boolean;
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
    return match ? (match[1] ?? null) : null;
}

export function getRootDomainAttr(url?: string): string {
    if (!url) return "";
    try {
        const hostname = new URL(url).hostname;
        const parts = hostname.split(".");
        if (parts.length >= 2 && parts[parts.length - 1] !== "localhost") {
            return `; Domain=.${parts.slice(-2).join(".")}`;
        }
    } catch {
        return "";
    }
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

function parseStoredCustomerAuthPolicy(value: string | null | undefined): unknown {
    if (!value) return undefined;
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return undefined;
    }
}

async function getCustomerAuthRuntimePolicy(db: Database): Promise<{
    settings: typeof siteSettings.$inferSelect;
    policy: CustomerAuthPolicyConfig;
}> {
    const [settingsRow, policyRow] = await Promise.all([
        db.select().from(siteSettings).limit(1).then((rows) => rows[0] ?? null),
        db.select({ value: genericSettings.value })
            .from(genericSettings)
            .where(and(eq(genericSettings.category, "customer_auth"), eq(genericSettings.key, "policy")))
            .get()
            .catch(() => null),
    ]);

    if (!settingsRow) {
        throw new ServiceUnavailableError("Customer authentication settings are not initialized.");
    }

    return {
        settings: settingsRow,
        policy: normalizeCustomerAuthPolicy(
            parseStoredCustomerAuthPolicy(policyRow?.value),
            settingsRow.authVerificationMethod,
        ),
    };
}

function normalizeCustomerAuthIntent(intent: unknown): CustomerAuthIntent {
    return intent === "sign_up" ? "sign_up" : "sign_in";
}

function normalizeEmail(value: string | undefined): string | undefined {
    const trimmed = value?.trim().toLowerCase();
    return trimmed || undefined;
}

function isValidEmailAddress(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function normalizePrimaryIdentifier(method: "email" | "phone", identifier: string): string {
    if (method === "email") {
        if (!isValidEmailAddress(identifier)) {
            throw new ValidationError("Valid email address required");
        }
        return identifier.trim().toLowerCase();
    }

    if (!isValidPhoneNumber(identifier)) {
        throw new ValidationError("Valid phone number required");
    }
    return validateAndFormatPhone(identifier);
}

function getPrimaryEmail(method: "email" | "phone", identifier: string, email?: string): string | undefined {
    return method === "email" ? identifier.trim().toLowerCase() : normalizeEmail(email);
}

function getPrimaryPhone(method: "email" | "phone", identifier: string, phone?: string): string | undefined {
    if (method === "phone") return validateAndFormatPhone(identifier);
    return phone ? validateAndFormatPhone(phone) : undefined;
}

async function hashCustomerSessionToken(sessionToken: string, sessionHashKey: string | undefined): Promise<string> {
    const secret = requireCustomerSessionHashKey(sessionHashKey);
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`customer-session:${sessionToken}`),
    );
    return Array.from(new Uint8Array(signature))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

function requireCustomerSessionHashKey(sessionHashKey: string | undefined): string {
    const key = sessionHashKey?.trim();
    if (!key) {
        throw new ServiceUnavailableError("Customer session signing key is not configured.");
    }
    return key;
}

function assertSecondaryContactFormats(input: {
    email?: string;
    phone?: string;
}): void {
    const email = normalizeEmail(input.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new ValidationError("Valid email address required");
    }
    if (input.phone && !isValidPhoneNumber(input.phone)) {
        throw new ValidationError("Valid phone number required");
    }
}

function assertPolicyRequiredFields(
    policy: CustomerAuthPolicyConfig,
    input: {
        intent: CustomerAuthIntent;
        channel: CustomerAuthOtpChannel;
        method: "email" | "phone";
        normalizedIdentifier: string;
        email?: string;
        phone?: string;
    },
): void {
    if (input.intent !== "sign_up") return;

    const email = getPrimaryEmail(input.method, input.normalizedIdentifier, input.email);
    const phone = getPrimaryPhone(input.method, input.normalizedIdentifier, input.phone);

    if (isContactFieldRequiredForAuthChannel(policy, input.channel, "email") && !email) {
        throw new ValidationError("Email address is required to create an account.");
    }

    if (isContactFieldRequiredForAuthChannel(policy, input.channel, "phone") && !phone) {
        throw new ValidationError("Phone number is required to create an account.");
    }
}

// ─────────────────────────────────────────
// Service functions
// ─────────────────────────────────────────

/**
 * Handles OTP generation, rate limiting, and queueing for delivery.
 * Send-time checks intentionally avoid account existence lookups so registration
 * state is disclosed only after a valid OTP proves contact ownership.
 * Returns a queue payload that the route should send to AUTH_OTP_QUEUE.
 *
 * @throws {ValidationError} if the identifier is missing or malformed
 * @throws {ForbiddenError} if the requested method is disabled by the store
 * @throws {RateLimitError} if the IP or identifier is rate-limited
 * @throws {ServiceUnavailableError} if the transport is misconfigured
 */
export async function sendOtp(
    db: Database,
    _kv: KVNamespace,
    input: SendOtpInput,
): Promise<SendOtpResult> {
    const { method, identifier, name, ip } = input;
    const intent = normalizeCustomerAuthIntent(input.intent);

    // Validate identifier format
    if (!identifier) {
        throw new ValidationError("Contact identifier required (email or phone)");
    }

    assertSecondaryContactFormats({
        email: input.email,
        phone: input.phone,
    });

    // Normalize phone identifier to E.164 for consistent storage/lookup
    const normalizedIdentifier = normalizePrimaryIdentifier(method, identifier);

    const { settings, policy } = await getCustomerAuthRuntimePolicy(db);
    const channel = resolveCustomerAuthChannelForRequest(policy, method, input.channel);

    if (!channel) {
        throw new ForbiddenError(`Verification via ${method} is currently disabled by the store.`);
    }

    assertPolicyRequiredFields(policy, {
        intent,
        channel,
        method,
        normalizedIdentifier,
        email: input.email,
        phone: input.phone,
    });

    const otpKey = getOtpStorageKey(channel, normalizedIdentifier);
    const contactEmail = getPrimaryEmail(method, normalizedIdentifier, input.email);
    const contactPhone = getPrimaryPhone(method, normalizedIdentifier, input.phone);

    // Resolve and validate the delivery transport before mutating rate-limit or OTP challenge state.
    const transport = getOtpTransport(method, policy, channel);
    if (channel === "email") {
        const emailReadiness = await getEmailProviderReadiness({
            db,
            env: input.emailEnv,
            encryptionKey: input.credentialEncryptionKey,
        });
        if (!emailReadiness.configured) {
            console.error(`[CustomerAuth] Email transport unavailable: ${emailReadiness.error ?? "not configured"}`);
            throw new ServiceUnavailableError("Email verification is currently unavailable. Contact store support.");
        }
    }
    if (channel === "whatsapp") {
        const whatsAppSettings = await getWhatsAppCloudApiSettings(db, input.credentialEncryptionKey, {
            migrateLegacy: true,
            migrationEncryptionKey: input.migrationEncryptionKey,
        });
        if (!whatsAppSettings.accessToken || !whatsAppSettings.phoneNumberId) {
            throw new ServiceUnavailableError("WhatsApp verification is currently unavailable. Contact store support.");
        }
    }
    if (channel === "sms") {
        const smsReadiness = await getSmsProviderReadiness(db, input.credentialEncryptionKey);
        if (!smsReadiness.configured) {
            console.error(`[CustomerAuth] SMS transport unavailable: ${smsReadiness.error ?? "not configured"}`);
            throw new ServiceUnavailableError("SMS verification is currently unavailable. Contact store support.");
        }
    }
    const configError = transport.validateConfig(settings);
    if (configError) {
        console.error(`[CustomerAuth] Transport ${transport.label} misconfigured: ${configError}`);
        throw new ServiceUnavailableError(configError);
    }

    await enforceCustomerAuthOtpIpRateLimit(db, {
        ip,
        hashKey: input.encryptionKey,
    });

    // Generate and persist an atomic D1 challenge. KV is intentionally not the
    // OTP authority; it cannot safely count attempts or consume one-time codes.
    const code = generateOtpCode();
    const deliveryKey = createAuthOtpDeliveryKey();
    const challenge = await persistCustomerAuthOtpChallenge(db, {
        otpKey,
        deliveryKey,
        method,
        channel,
        intent,
        identifier: normalizedIdentifier,
        contactEmail,
        phone: contactPhone,
        code,
        encryptionKey: input.encryptionKey,
        ttlSeconds: OTP_TTL_SECONDS,
        resendCooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
        maxAttempts: OTP_MAX_ATTEMPTS,
    });

    // OTP code is intentionally NOT logged — it would leak secrets in production.

    // Build queue payload via transport — use original identifier for delivery (user-facing)
    const queuePayload = transport.buildQueuePayload(
        code,
        normalizedIdentifier,
        name,
        { ...settings, authVerificationMethod: normalizeCustomerAuthMethod(settings.authVerificationMethod) },
        channel,
        deliveryKey,
        challenge.expiresAt,
    );

    return {
        success: true,
        message: "Verification code sent. Please check your selected contact.",
        queuePayload,
        otpStorageKey: otpKey,
        deliveryKey,
    };
}

/**
 * Verifies an OTP code and creates a customer session.
 * Handles customer lookup/creation in DB.
 *
 * @throws {ValidationError} if the identifier/code is missing, expired, or incorrect
 * @throws {RateLimitError} if too many failed attempts
 */
export async function verifyOtp(
    db: Database,
    _kv: KVNamespace,
    input: VerifyOtpInput,
): Promise<VerifyOtpResult> {
    const { method, identifier, code, name, phone, email } = input;

    if (!identifier || !code) {
        throw new ValidationError("Contact identifier and code are required");
    }
    assertSecondaryContactFormats({ email, phone });

    // Normalize the primary destination exactly as sendOtp() did. Verification
    // payloads prove an OTP; they may not reinterpret which contact was verified.
    const normalizedIdentifier = normalizePrimaryIdentifier(method, identifier);

    const channel = input.channel ?? getFallbackOtpChannel(method);
    const otpKey = getOtpStorageKey(channel, normalizedIdentifier);

    const challenge = await claimCustomerAuthOtpChallenge(db, {
        otpKey,
        method,
        channel,
        identifier: normalizedIdentifier,
        code,
        encryptionKey: input.encryptionKey,
    });
    const intent = normalizeCustomerAuthIntent(challenge.intent ?? input.intent);
    const verifiedEmail = challenge.method === "email" ? challenge.identifier : challenge.contactEmail;
    const verifiedPhone = challenge.method === "phone" ? challenge.identifier : challenge.phone;

    // Look up customer in DB (if exists)
    let customerId: string | undefined;
    let customerName = name;
    let resolvedEmail = method === "email" ? normalizedIdentifier : verifiedEmail;
    let resolvedPhone = method === "phone" ? normalizedIdentifier : verifiedPhone;
    let isNewUser = false;

    try {
        if (intent === "sign_up") {
            const { policy } = await getCustomerAuthRuntimePolicy(db);
            assertPolicyRequiredFields(policy, {
                intent,
                channel,
                method,
                normalizedIdentifier,
                email: verifiedEmail,
                phone: verifiedPhone,
            });
        }

        const existing = method === "email"
            ? await db.select().from(customers).where(eq(customers.email, normalizedIdentifier)).get()
            : await db.select().from(customers).where(eq(customers.phone, normalizedIdentifier)).get();

        if (intent === "sign_in") {
            if (!existing) {
                throw new ValidationError(
                    method === "email"
                        ? "No account was found for this email. Create an account instead."
                        : "No account was found for this phone number. Create an account instead.",
                );
            }
            customerId = existing.id;
            customerName = existing.name || name;
            resolvedEmail = existing.email || resolvedEmail;
            resolvedPhone = existing.phone || resolvedPhone;
        } else {
            if (existing) {
                throw new ValidationError(
                    method === "email"
                        ? "An account already exists for this email. Sign in instead."
                        : "An account already exists for this phone number. Sign in instead.",
                );
            }
            if (method === "email") {
                if (!verifiedPhone) {
                    throw new ValidationError("Phone number is required to create an account with email OTP.");
                }
                resolvedPhone = verifiedPhone;
            }

            if (resolvedEmail) {
                const emailExists = await db.select().from(customers).where(eq(customers.email, resolvedEmail)).get();
                if (emailExists) {
                    throw new ValidationError("An account already exists for this email. Sign in instead.");
                }
            }

            const phoneForNewCustomer = method === "phone" ? normalizedIdentifier : verifiedPhone;
            if (!phoneForNewCustomer) {
                throw new ValidationError("Phone number is required to create an account.");
            }

            const phoneExists = await db.select().from(customers).where(eq(customers.phone, phoneForNewCustomer)).get();
            if (phoneExists) {
                throw new ValidationError("An account already exists for this phone number. Sign in instead.");
            }

            // Create new customer record — use "cust_" prefix for consistency with customers.service.ts
            customerId = "cust_" + nanoid();

            // Determine phone value
            const customerPhone = phoneForNewCustomer;
            resolvedPhone = phoneForNewCustomer;

            await db.insert(customers).values({
                id: customerId,
                name: customerName,
                email: resolvedEmail || null,
                phone: customerPhone || "",
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            });
            isNewUser = true;
        }
    } catch (dbError: unknown) {
        // Re-throw typed errors (ValidationError etc.) as-is
        if (dbError instanceof ValidationError) {
            throw dbError;
        }
        console.warn("[CustomerAuth] DB lookup/insert failed:", dbError);
        throw new ServiceUnavailableError("Customer account service is temporarily unavailable. Please try again.");
    }

    if (!customerId) {
        throw new ServiceUnavailableError("Customer session could not be created. Please try again.");
    }

    // Create session. The raw bearer token is only returned for the httpOnly
    // cookie; D1 stores an HMAC hash so a database leak cannot replay sessions.
    const nowMs = Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    const sessionToken = nanoid(48);
    const sessionExpiresAtSeconds = nowSeconds + SESSION_TTL_SECONDS;
    const tokenHash = await hashCustomerSessionToken(sessionToken, input.sessionHashKey);
    const session: CustomerSession = {
        token: sessionToken,
        email: resolvedEmail || "",
        name: customerName,
        phone: resolvedPhone,
        customerId,
        createdAt: nowMs,
        expiresAt: sessionExpiresAtSeconds * 1000,
    };

    await db.insert(customerSessions).values({
        tokenHash,
        customerId,
        expiresAt: sessionExpiresAtSeconds,
        revokedAt: null,
        createdAt: nowSeconds,
        updatedAt: nowSeconds,
    });

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
 * Retrieves a D1-backed customer session from a raw cookie token.
 * Returns null if the session is expired, revoked, missing, or points at a
 * soft-deleted/missing customer.
 */
export async function getCustomerBySession(
    db: Database,
    sessionToken: string,
    sessionHashKey: string | undefined,
): Promise<CustomerSession | null> {
    if (!sessionToken.trim()) return null;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const tokenHash = await hashCustomerSessionToken(sessionToken, sessionHashKey);
    const row = await db
        .select({
            tokenHash: customerSessions.tokenHash,
            customerId: customerSessions.customerId,
            expiresAt: customerSessions.expiresAt,
            createdAt: customerSessions.createdAt,
            customerName: customers.name,
            customerEmail: customers.email,
            customerPhone: customers.phone,
        })
        .from(customerSessions)
        .innerJoin(customers, eq(customerSessions.customerId, customers.id))
        .where(and(
            eq(customerSessions.tokenHash, tokenHash),
            isNull(customerSessions.revokedAt),
            gt(customerSessions.expiresAt, nowSeconds),
            isNull(customers.deletedAt),
        ))
        .get();

    if (!row) {
        return null;
    }

    return {
        token: sessionToken,
        email: row.customerEmail ?? "",
        name: row.customerName,
        phone: row.customerPhone,
        customerId: row.customerId,
        createdAt: row.createdAt * 1000,
        expiresAt: row.expiresAt * 1000,
    };
}

/**
 * Revokes a customer session in D1.
 */
export async function deleteCustomerSession(
    db: Database,
    sessionToken: string,
    sessionHashKey: string | undefined,
): Promise<void> {
    if (!sessionToken.trim()) return;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const tokenHash = await hashCustomerSessionToken(sessionToken, sessionHashKey);
    await db
        .update(customerSessions)
        .set({ revokedAt: nowSeconds, updatedAt: nowSeconds })
        .where(and(
            eq(customerSessions.tokenHash, tokenHash),
            isNull(customerSessions.revokedAt),
        ));
}

/**
 * Updates a customer profile and returns a fresh session projection from D1.
 */
export async function updateCustomerProfile(
    db: Database,
    session: CustomerSession,
    updates: Record<string, string | undefined>,
): Promise<{ session: CustomerSession; updates: Record<string, string | undefined> }> {
    if (!session.customerId) {
        throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
    }

    const dbUpdates: Record<string, unknown> = {
        updatedAt: sql`unixepoch()`,
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
        .where(and(eq(customers.id, session.customerId), isNull(customers.deletedAt)));

    const customer = await db
        .select({
            id: customers.id,
            name: customers.name,
            email: customers.email,
            phone: customers.phone,
        })
        .from(customers)
        .where(and(eq(customers.id, session.customerId), isNull(customers.deletedAt)))
        .get();

    if (!customer) {
        throw new UnauthorizedError("Customer profile is no longer available. Please log in again.");
    }

    const updatedSession: CustomerSession = {
        ...session,
        email: customer.email ?? "",
        name: customer.name,
        phone: customer.phone,
        customerId: customer.id,
    };

    return { session: updatedSession, updates };
}

export async function cleanupExpiredCustomerSessions(
    db: Database,
    nowSeconds = Math.floor(Date.now() / 1000),
    options: { limit?: number; revokedRetentionSeconds?: number } = {},
): Promise<CleanupExpiredCustomerSessionsResult> {
    const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
    const revokedRetentionSeconds = options.revokedRetentionSeconds ?? 7 * 24 * 60 * 60;
    const revokedCutoff = nowSeconds - revokedRetentionSeconds;
    const rows = await db
        .select({ tokenHash: customerSessions.tokenHash })
        .from(customerSessions)
        .where(or(
            lte(customerSessions.expiresAt, nowSeconds),
            and(
                isNotNull(customerSessions.revokedAt),
                lte(customerSessions.revokedAt, revokedCutoff),
            ),
        ))
        .limit(limit + 1);

    const deleteIds = rows.slice(0, limit).map((row) => row.tokenHash);
    if (deleteIds.length > 0) {
        await db
            .delete(customerSessions)
            .where(inArray(customerSessions.tokenHash, deleteIds));
    }

    return {
        scanned: Math.min(rows.length, limit),
        deleted: deleteIds.length,
        limit,
        hasMore: rows.length > limit,
    };
}
