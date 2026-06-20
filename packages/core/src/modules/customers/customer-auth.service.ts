// src/modules/customers/customer-auth.service.ts
// Customer authentication business logic: OTP generation/verification, session management.
// Used by the customer-auth route handler (apps/api/src/routes/customer-auth.ts).

import { nanoid } from "nanoid";
import { customers, siteSettings, settings as genericSettings } from "@scalius/database/schema";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import {
    ValidationError,
    RateLimitError,
    ForbiddenError,
    ServiceUnavailableError,
} from "@scalius/core/errors";
import { getOtpTransport, type OtpQueuePayload } from "./otp-transport";
import { createAuthOtpDeliveryKey } from "./otp-delivery-receipts";
import {
    claimCustomerAuthOtpChallenge,
    persistCustomerAuthOtpChallenge,
    deleteCustomerAuthOtpChallenge,
    cleanupExpiredCustomerAuthOtpChallenges,
} from "./customer-auth-otp-challenges";
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

// ─────────────────────────────────────────
// Constants
// ─────────────────────────────────────────

export const COOKIE_NAME = "cs_tok";
export const SESSION_PREFIX = "cust_session:";
export const OTP_PREFIX = "cust_otp:";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const OTP_TTL_SECONDS = 60 * 5; // 5 minutes
const OTP_RESEND_COOLDOWN_SECONDS = 120;
const OTP_MAX_ATTEMPTS = 5;

export { deleteCustomerAuthOtpChallenge, cleanupExpiredCustomerAuthOtpChallenges };

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
    encryptionKey?: string;
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

async function assertAuthIntentCanProceed(
    db: Database,
    input: {
        intent: CustomerAuthIntent;
        method: "email" | "phone";
        normalizedIdentifier: string;
        email?: string;
        phone?: string;
    },
): Promise<void> {
    const email = getPrimaryEmail(input.method, input.normalizedIdentifier, input.email);
    const phone = getPrimaryPhone(input.method, input.normalizedIdentifier, input.phone);

    if (input.intent === "sign_in") {
        const existing = input.method === "email" && email
            ? await db.select().from(customers).where(eq(customers.email, email)).get()
            : await db.select().from(customers).where(eq(customers.phone, input.normalizedIdentifier)).get();

        if (!existing) {
            throw new ValidationError(
                input.method === "email"
                    ? "No account was found for this email. Create an account instead."
                    : "No account was found for this phone number. Create an account instead.",
            );
        }
        return;
    }

    if (input.method === "email" && !phone) {
        throw new ValidationError("Phone number is required to create an account with email OTP.");
    }

    if (email) {
        const emailExists = await db.select().from(customers).where(eq(customers.email, email)).get();
        if (emailExists) {
            throw new ValidationError("An account already exists for this email. Sign in instead.");
        }
    }

    if (phone) {
        const phoneExists = await db.select().from(customers).where(eq(customers.phone, phone)).get();
        if (phoneExists) {
            throw new ValidationError("An account already exists for this phone number. Sign in instead.");
        }
    }
}

// ─────────────────────────────────────────
// Service functions
// ─────────────────────────────────────────

/**
 * Handles OTP generation, rate limiting, and queueing for delivery.
 * Returns a queue payload that the route should send to AUTH_OTP_QUEUE.
 *
 * @throws {ValidationError} if the identifier is missing or malformed
 * @throws {ForbiddenError} if the requested method is disabled by the store
 * @throws {RateLimitError} if the IP or identifier is rate-limited
 * @throws {ServiceUnavailableError} if the transport is misconfigured
 */
export async function sendOtp(
    db: Database,
    kv: KVNamespace,
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

    await assertAuthIntentCanProceed(db, {
        intent,
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
    if (channel === "whatsapp") {
        const whatsAppSettings = await getWhatsAppCloudApiSettings(db, input.encryptionKey, {
            migrateLegacy: true,
            migrationEncryptionKey: input.migrationEncryptionKey,
        });
        if (!whatsAppSettings.accessToken || !whatsAppSettings.phoneNumberId) {
            throw new ServiceUnavailableError("WhatsApp verification is currently unavailable. Contact store support.");
        }
    }
    if (channel === "sms") {
        const smsReadiness = await getSmsProviderReadiness(db, input.encryptionKey);
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
            throw new RateLimitError("Too many requests from this IP. Please try again later.", rlWindow);
        }

        await kv.put(ipRateKey, (ipCount + 1).toString(), { expirationTtl: rlWindow });
    }

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
        message: `Verification code sent${method === "email" ? " to your email" : ` via ${transport.label}`}`,
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
    kv: KVNamespace,
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
