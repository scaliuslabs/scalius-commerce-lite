// src/modules/customers/customer-auth.service.ts
// Customer authentication business logic: OTP generation/verification, session management.
// Used by the customer-auth route handler (apps/api/src/routes/customer-auth.ts).

import { nanoid } from "nanoid";
import { customers, customerSessions, deliveryLocations, siteSettings, settings as genericSettings } from "@scalius/database/schema";
import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { safeBatch, type Database } from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
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
    buildCustomerAuthOtpStorageKey,
} from "./customer-auth-otp-challenges";
import {
    cleanupExpiredCustomerAuthOtpRateLimits,
    enforceCustomerAuthOtpIpRateLimit,
} from "./customer-auth-rate-limit";
import { validateAndFormatPhone, type PhoneCountryPolicy } from "@scalius/shared/customer-utils";
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
import { getAllowedCountries } from "../settings/site-settings.service";

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
    address?: string | null;
    city?: string | null;
    zone?: string | null;
    area?: string | null;
    cityName?: string | null;
    zoneName?: string | null;
    areaName?: string | null;
    profileComplete: boolean;
    needsProfileCompletion: boolean;
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
    credentialEncryptionKey?: string;
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
        address?: string | null;
        city?: string | null;
        zone?: string | null;
        area?: string | null;
        cityName?: string | null;
        zoneName?: string | null;
        areaName?: string | null;
        profileComplete: boolean;
        needsProfileCompletion: boolean;
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

export async function deriveCustomerAuthOtpDeliveryCode(input: {
    otpKey: string;
    deliveryKey: string;
    encryptionKey?: string;
}): Promise<string> {
    const secret = requireCustomerOtpDeliveryKey(input.encryptionKey);
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
        new TextEncoder().encode(`customer-auth-otp-delivery:${input.otpKey}:${input.deliveryKey}`),
    );
    const num = (new DataView(signature).getUint32(0) % 900000) + 100000;
    return String(num);
}

function requireCustomerOtpDeliveryKey(encryptionKey: string | undefined): string {
    const key = encryptionKey?.trim();
    if (!key) {
        throw new ServiceUnavailableError("Customer OTP signing key is not configured.");
    }
    return key;
}

export function getSessionCookie(cookieHeader: string | null): string | null {
    if (!cookieHeader) return null;
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
    return match ? (match[1] ?? null) : null;
}

export function normalizeCustomerAuthCookieDomain(cookieDomain?: string): string {
    const normalized = cookieDomain
        ?.trim()
        .replace(/^domain=/i, "")
        .replace(/^\.+/, "")
        .replace(/\.+$/, "")
        .toLowerCase();

    if (!normalized) return "";
    if (normalized === "localhost") return "";
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) return "";
    if (!normalized.includes(".")) return "";
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(normalized)) return "";
    return normalized;
}

export function getCustomerAuthCookieDomainAttr(cookieDomain?: string): string {
    const normalized = normalizeCustomerAuthCookieDomain(cookieDomain);
    return normalized ? `; Domain=.${normalized}` : "";
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

export function getCookieConfig(
    storefrontUrl?: string,
    customerAuthCookieDomain?: string,
): { sameSite: string; domainAttr: string } {
    const isProd = isProduction(storefrontUrl);
    return {
        sameSite: isProd ? "None" : "Lax",
        domainAttr: getCustomerAuthCookieDomainAttr(customerAuthCookieDomain),
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
    phoneCountryPolicy: PhoneCountryPolicy;
}> {
    const [settingsRow, policyRow, allowedCountriesConfig] = await Promise.all([
        db.select().from(siteSettings).limit(1).then((rows) => rows[0] ?? null),
        db.select({ value: genericSettings.value })
            .from(genericSettings)
            .where(and(eq(genericSettings.category, "customer_auth"), eq(genericSettings.key, "policy")))
            .get()
            .catch(() => null),
        getAllowedCountries(db),
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
        phoneCountryPolicy: {
            countries: allowedCountriesConfig.allowedCountries,
            mode: allowedCountriesConfig.allowedCountriesMode,
        },
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

function normalizePhoneOrThrow(phone: string, phoneCountryPolicy?: PhoneCountryPolicy): string {
    try {
        return validateAndFormatPhone(phone, phoneCountryPolicy);
    } catch (error) {
        throw new ValidationError(error instanceof Error ? error.message : "Valid phone number required");
    }
}

function normalizePrimaryIdentifier(
    method: "email" | "phone",
    identifier: string,
    phoneCountryPolicy?: PhoneCountryPolicy,
): string {
    if (method === "email") {
        if (!isValidEmailAddress(identifier)) {
            throw new ValidationError("Valid email address required");
        }
        return identifier.trim().toLowerCase();
    }

    return normalizePhoneOrThrow(identifier, phoneCountryPolicy);
}

function getPrimaryEmail(method: "email" | "phone", identifier: string, email?: string): string | undefined {
    return method === "email" ? identifier.trim().toLowerCase() : normalizeEmail(email);
}

function getPrimaryPhone(
    method: "email" | "phone",
    identifier: string,
    phone?: string,
    phoneCountryPolicy?: PhoneCountryPolicy,
): string | undefined {
    if (method === "phone") return normalizePhoneOrThrow(identifier, phoneCountryPolicy);
    return phone ? normalizePhoneOrThrow(phone, phoneCountryPolicy) : undefined;
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
}, phoneCountryPolicy?: PhoneCountryPolicy): void {
    const email = normalizeEmail(input.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new ValidationError("Valid email address required");
    }
    if (input.phone) {
        normalizePhoneOrThrow(input.phone, phoneCountryPolicy);
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
    phoneCountryPolicy?: PhoneCountryPolicy,
): void {
    if (input.intent !== "sign_up") return;

    const email = getPrimaryEmail(input.method, input.normalizedIdentifier, input.email);
    const phone = getPrimaryPhone(input.method, input.normalizedIdentifier, input.phone, phoneCountryPolicy);

    if (isContactFieldRequiredForAuthChannel(policy, input.channel, "email") && !email) {
        throw new ValidationError("Email address is required to create an account.");
    }

    if (isContactFieldRequiredForAuthChannel(policy, input.channel, "phone") && !phone) {
        throw new ValidationError("Phone number is required to create an account.");
    }
}

type CustomerAuthProfileRow = typeof customers.$inferSelect;
type CustomerInsertRow = typeof customers.$inferInsert;
type SQLiteBatchItem = BatchItem<"sqlite">;
type SQLTimestamp = ReturnType<typeof sql>;

function customerAccountStateForProof(input: {
    verifiedEmail?: string | null;
    verifiedPhone?: string | null;
}): {
    accountClaimedAt: SQLTimestamp;
    phoneVerifiedAt?: SQLTimestamp;
    emailVerifiedAt?: SQLTimestamp;
    lastAuthenticatedAt: SQLTimestamp;
} {
    const updates: {
        accountClaimedAt: SQLTimestamp;
        phoneVerifiedAt?: SQLTimestamp;
        emailVerifiedAt?: SQLTimestamp;
        lastAuthenticatedAt: SQLTimestamp;
    } = {
        accountClaimedAt: sql`coalesce(${customers.accountClaimedAt}, unixepoch())`,
        lastAuthenticatedAt: sql`unixepoch()`,
    };

    if (input.verifiedPhone) {
        updates.phoneVerifiedAt = sql`coalesce(${customers.phoneVerifiedAt}, unixepoch())`;
    }
    if (input.verifiedEmail) {
        updates.emailVerifiedAt = sql`coalesce(${customers.emailVerifiedAt}, unixepoch())`;
    }

    return updates;
}

function customerAccountInsertStateForProof(input: {
    verifiedEmail?: string | null;
    verifiedPhone?: string | null;
    authenticatedAt: Date;
}): Pick<CustomerInsertRow, "accountClaimedAt" | "phoneVerifiedAt" | "emailVerifiedAt" | "lastAuthenticatedAt"> {
    return {
        accountClaimedAt: input.authenticatedAt,
        phoneVerifiedAt: input.verifiedPhone ? input.authenticatedAt : null,
        emailVerifiedAt: input.verifiedEmail ? input.authenticatedAt : null,
        lastAuthenticatedAt: input.authenticatedAt,
    };
}

function isCustomerUniqueConstraintError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
        message.includes("customer_phone_unique") ||
        message.includes("UNIQUE constraint failed: customers.phone") ||
        message.includes("customers.phone")
    );
}

export interface CustomerAuthProfile {
    identifier?: string;
    name: string;
    email: string;
    phone?: string;
    customerId?: string;
    address?: string | null;
    city?: string | null;
    zone?: string | null;
    area?: string | null;
    cityName?: string | null;
    zoneName?: string | null;
    areaName?: string | null;
    profileComplete: boolean;
    needsProfileCompletion: boolean;
}

interface ResolvedCustomerLocation {
    city: string | null;
    zone: string | null;
    area: string | null;
    cityName: string | null;
    zoneName: string | null;
    areaName: string | null;
}

function normalizeOptionalProfileText(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

function hasRequiredCustomerProfileFields(row: {
    name?: string | null;
    phone?: string | null;
    address?: string | null;
    city?: string | null;
    zone?: string | null;
}): boolean {
    return Boolean(
        row.name?.trim() &&
        row.phone?.trim() &&
        row.address?.trim() &&
        row.city?.trim() &&
        row.zone?.trim(),
    );
}

function buildCustomerAuthProfile(row: CustomerAuthProfileRow, identifier?: string): CustomerAuthProfile {
    const profileComplete = hasRequiredCustomerProfileFields(row);
    return {
        identifier,
        name: row.name || "Customer",
        email: row.email ?? "",
        phone: row.phone,
        customerId: row.id,
        address: row.address ?? null,
        city: row.city ?? null,
        zone: row.zone ?? null,
        area: row.area ?? null,
        cityName: row.cityName ?? null,
        zoneName: row.zoneName ?? null,
        areaName: row.areaName ?? null,
        profileComplete,
        needsProfileCompletion: !profileComplete && row.profileCompletionRequiredAt != null,
    };
}

async function getActiveCustomerById(db: Database, customerId: string): Promise<CustomerAuthProfileRow | null> {
    const row = await db
        .select()
        .from(customers)
        .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)))
        .get();
    return row ?? null;
}

async function getActiveCustomerByPhone(db: Database, phone: string): Promise<CustomerAuthProfileRow | null> {
    const row = await db
        .select()
        .from(customers)
        .where(and(eq(customers.phone, phone), isNull(customers.deletedAt)))
        .get();
    return row ?? null;
}

async function getDeletedCustomerByPhone(db: Database, phone: string): Promise<Pick<CustomerAuthProfileRow, "id"> | null> {
    const row = await db
        .select({
            id: customers.id,
        })
        .from(customers)
        .where(and(eq(customers.phone, phone), isNotNull(customers.deletedAt)))
        .get();
    return row ?? null;
}

async function getDeletedCustomerByEmail(db: Database, email: string): Promise<Pick<CustomerAuthProfileRow, "id"> | null> {
    const row = await db
        .select({
            id: customers.id,
        })
        .from(customers)
        .where(and(eq(customers.email, email), isNotNull(customers.deletedAt)))
        .get();
    return row ?? null;
}

async function getActiveCustomersByEmail(
    db: Database,
    email: string,
    limit = 2,
): Promise<CustomerAuthProfileRow[]> {
    return db
        .select()
        .from(customers)
        .where(and(eq(customers.email, email), isNull(customers.deletedAt)))
        .limit(limit)
        .all();
}

async function getActiveCustomerByEmailForSignIn(db: Database, email: string): Promise<CustomerAuthProfileRow | null> {
    const matches = await getActiveCustomersByEmail(db, email, 2);
    if (matches.length > 1) {
        throw new ValidationError("Multiple accounts use this email. Please use phone verification or contact store support.");
    }
    return matches[0] ?? null;
}

async function resolveActiveCustomerLocation(
    db: Database,
    input: { city: string | null; zone: string | null; area: string | null },
): Promise<ResolvedCustomerLocation> {
    if (!input.city && !input.zone && !input.area) {
        return {
            city: null,
            zone: null,
            area: null,
            cityName: null,
            zoneName: null,
            areaName: null,
        };
    }

    if (!input.city || !input.zone) {
        throw new ValidationError("City and zone are required to save a delivery profile.");
    }

    const locationIds = [input.city, input.zone, input.area].filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
    );
    const rows = await db
        .select({
            id: deliveryLocations.id,
            name: deliveryLocations.name,
            type: deliveryLocations.type,
            parentId: deliveryLocations.parentId,
            isActive: deliveryLocations.isActive,
            deletedAt: deliveryLocations.deletedAt,
        })
        .from(deliveryLocations)
        .where(and(
            inArray(deliveryLocations.id, locationIds),
            eq(deliveryLocations.isActive, true),
            isNull(deliveryLocations.deletedAt),
        ));

    const locationMap = new Map(rows.map((row) => [row.id, row]));
    const city = locationMap.get(input.city);
    if (!city || city.type !== "city" || city.parentId !== null || city.isActive !== true || city.deletedAt != null) {
        throw new ValidationError("Selected city is no longer available.");
    }

    const zone = locationMap.get(input.zone);
    if (!zone || zone.type !== "zone" || zone.parentId !== city.id || zone.isActive !== true || zone.deletedAt != null) {
        throw new ValidationError("Selected zone is no longer available for the chosen city.");
    }

    const area = input.area ? locationMap.get(input.area) : null;
    if (input.area && (!area || area.type !== "area" || area.parentId !== zone.id || area.isActive !== true || area.deletedAt != null)) {
        throw new ValidationError("Selected area is no longer available for the chosen zone.");
    }

    return {
        city: city.id,
        zone: zone.id,
        area: area?.id ?? null,
        cityName: city.name,
        zoneName: zone.name,
        areaName: area?.name ?? null,
    };
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

    normalizePrimaryIdentifier(method, identifier);
    assertSecondaryContactFormats({
        email: input.email,
        phone: input.phone,
    });

    const { settings, policy, phoneCountryPolicy } = await getCustomerAuthRuntimePolicy(db);

    assertSecondaryContactFormats({
        email: input.email,
        phone: input.phone,
    }, phoneCountryPolicy);

    // Normalize phone identifier to E.164 for consistent storage/lookup
    const normalizedIdentifier = normalizePrimaryIdentifier(method, identifier, phoneCountryPolicy);
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
    }, phoneCountryPolicy);

    const otpKey = await buildCustomerAuthOtpStorageKey(channel, normalizedIdentifier, input.encryptionKey);
    const contactEmail = getPrimaryEmail(method, normalizedIdentifier, input.email);
    const contactPhone = getPrimaryPhone(method, normalizedIdentifier, input.phone, phoneCountryPolicy);
    if (!input.credentialEncryptionKey?.trim()) {
        throw new ServiceUnavailableError("Customer OTP delivery target encryption key is not configured.");
    }
    if (
        intent === "sign_up" &&
        ((method === "email" && contactPhone) || (method === "phone" && contactEmail)) &&
        !input.credentialEncryptionKey?.trim()
    ) {
        throw new ServiceUnavailableError("Customer OTP contact encryption key is not configured.");
    }

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
    const deliveryKey = createAuthOtpDeliveryKey();
    const code = await deriveCustomerAuthOtpDeliveryCode({
        otpKey,
        deliveryKey,
        encryptionKey: input.encryptionKey,
    });
    const challenge = await persistCustomerAuthOtpChallenge(db, {
        otpKey,
        deliveryKey,
        method,
        channel,
        intent,
        identifier: normalizedIdentifier,
        deliveryTarget: normalizedIdentifier,
        deliveryName: name,
        contactEmail: intent === "sign_up" && method === "phone" ? contactEmail : undefined,
        phone: intent === "sign_up" && method === "email" ? contactPhone : undefined,
        code,
        encryptionKey: input.encryptionKey,
        contactEncryptionKey: input.credentialEncryptionKey,
        ttlSeconds: OTP_TTL_SECONDS,
        resendCooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
        maxAttempts: OTP_MAX_ATTEMPTS,
    });

    // OTP code is intentionally NOT logged — it would leak secrets in production.

    // Build queue payload via transport. The raw OTP is intentionally absent; the
    // consumer derives the code and recipient target from the challenge and delivery references.
    const queuePayload = transport.buildQueuePayload(
        { ...settings, authVerificationMethod: normalizeCustomerAuthMethod(settings.authVerificationMethod) },
        channel,
        deliveryKey,
        challenge.expiresAt,
        otpKey,
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

    normalizePrimaryIdentifier(method, identifier);
    assertSecondaryContactFormats({ email, phone });

    const runtimePolicy = await getCustomerAuthRuntimePolicy(db);
    const { phoneCountryPolicy } = runtimePolicy;

    assertSecondaryContactFormats({ email, phone }, phoneCountryPolicy);

    // Normalize the primary destination exactly as sendOtp() did. Verification
    // payloads prove an OTP; they may not reinterpret which contact was verified.
    const normalizedIdentifier = normalizePrimaryIdentifier(method, identifier, phoneCountryPolicy);

    const channel = input.channel ?? getFallbackOtpChannel(method);
    const otpKey = await buildCustomerAuthOtpStorageKey(channel, normalizedIdentifier, input.encryptionKey);

    const challenge = await claimCustomerAuthOtpChallenge(db, {
        otpKey,
        method,
        channel,
        identifier: normalizedIdentifier,
        code,
        encryptionKey: input.encryptionKey,
        contactEncryptionKey: input.credentialEncryptionKey,
    });
    const intent = normalizeCustomerAuthIntent(challenge.intent ?? input.intent);
    const otpVerifiedEmail = challenge.method === "email" ? challenge.identifier : null;
    const otpVerifiedPhone = challenge.method === "phone" ? challenge.identifier : null;
    const verifiedEmail = otpVerifiedEmail ?? challenge.contactEmail;
    const verifiedPhone = otpVerifiedPhone ?? challenge.phone;
    if (verifiedPhone) {
        normalizePhoneOrThrow(verifiedPhone, phoneCountryPolicy);
    }

    // Look up customer in DB (if exists)
    let customerId: string | undefined;
    let customerName = name;
    let resolvedEmail = method === "email" ? normalizedIdentifier : verifiedEmail;
    let isNewUser = false;
    let customerProfileRow: CustomerAuthProfileRow | null | undefined;
    let pendingCustomerInsertValues: CustomerInsertRow | null = null;

    try {
        if (intent === "sign_up") {
            assertPolicyRequiredFields(runtimePolicy.policy, {
                intent,
                channel,
                method,
                normalizedIdentifier,
                email: verifiedEmail,
                phone: verifiedPhone,
            }, phoneCountryPolicy);
        }

        const existing = method === "email"
            ? await getActiveCustomerByEmailForSignIn(db, normalizedIdentifier)
            : await getActiveCustomerByPhone(db, normalizedIdentifier);

        if (intent === "sign_in") {
            if (!existing || !existing.accountClaimedAt) {
                if (method === "email" && await getDeletedCustomerByEmail(db, normalizedIdentifier)) {
                    throw new ValidationError("This email belongs to a deleted customer account. Contact store support to restore access.");
                }
                if (method === "phone" && await getDeletedCustomerByPhone(db, normalizedIdentifier)) {
                    throw new ValidationError("This phone number belongs to a deleted customer account. Contact store support to restore access.");
                }
                throw new ValidationError(
                    method === "email"
                        ? "No account was found for this email. Create an account instead."
                        : "No account was found for this phone number. Create an account instead.",
                );
            }
            customerProfileRow = existing;
            customerId = existing.id;
            customerName = existing.name || name;
            resolvedEmail = existing.email || resolvedEmail;
        } else {
            if (existing) {
                if (existing.accountClaimedAt) {
                    throw new ValidationError(
                        method === "email"
                            ? "An account already exists for this email. Sign in instead."
                            : "An account already exists for this phone number. Sign in instead.",
                    );
                }
                if (method !== "phone") {
                    throw new ValidationError("Use phone verification to create an account for this customer profile.");
                }
                customerProfileRow = existing;
                customerId = existing.id;
                customerName = existing.name || name;
                resolvedEmail = existing.email || resolvedEmail;
                isNewUser = true;
            }
            if (!existing && method === "email") {
                if (!verifiedPhone) {
                    throw new ValidationError("Phone number is required to create an account with email OTP.");
                }
            }

            if (!existing && resolvedEmail) {
                const activeEmailCustomers = await getActiveCustomersByEmail(db, resolvedEmail, 2);
                if (activeEmailCustomers.length > 1) {
                    throw new ValidationError("Multiple accounts use this email. Please use phone verification or contact store support.");
                }
                if (activeEmailCustomers.length === 1) {
                    if (!activeEmailCustomers[0]?.accountClaimedAt) {
                        throw new ValidationError("Use phone verification to create an account for this customer profile.");
                    }
                    throw new ValidationError("An account already exists for this email. Sign in instead.");
                }
            }

            if (!existing) {
                const phoneForNewCustomer = method === "phone" ? normalizedIdentifier : verifiedPhone;
                if (!phoneForNewCustomer) {
                    throw new ValidationError("Phone number is required to create an account.");
                }

                const activePhoneCustomer = await getActiveCustomerByPhone(db, phoneForNewCustomer);
                if (activePhoneCustomer) {
                    if (!activePhoneCustomer.accountClaimedAt) {
                        throw new ValidationError("Use phone verification to create an account for this customer profile.");
                    }
                    throw new ValidationError("An account already exists for this phone number. Sign in instead.");
                }
                const deletedPhoneCustomer = await getDeletedCustomerByPhone(db, phoneForNewCustomer);
                if (deletedPhoneCustomer) {
                    throw new ValidationError("This phone number belongs to a deleted customer account. Contact store support to restore access.");
                }

                // Create new customer record — use "cust_" prefix for consistency with customers.service.ts
                customerId = "cust_" + nanoid();
                const profileRequiredAt = new Date();

                // Determine phone value
                const customerPhone = phoneForNewCustomer;

                const newCustomerValues: CustomerInsertRow = {
                    id: customerId,
                    name: customerName,
                    email: resolvedEmail || null,
                    phone: customerPhone || "",
                    ...customerAccountInsertStateForProof({
                        verifiedEmail: otpVerifiedEmail,
                        verifiedPhone: otpVerifiedPhone,
                        authenticatedAt: profileRequiredAt,
                    }),
                    profileCompletionRequiredAt: profileRequiredAt,
                    profileCompletedAt: null,
                    createdAt: profileRequiredAt,
                    updatedAt: profileRequiredAt,
                };

                pendingCustomerInsertValues = newCustomerValues;
                customerProfileRow = {
                    id: customerId,
                    name: customerName,
                    email: resolvedEmail || null,
                    phone: customerPhone || "",
                    address: null,
                    city: null,
                    zone: null,
                    area: null,
                    cityName: null,
                    zoneName: null,
                    areaName: null,
                    accountClaimedAt: profileRequiredAt,
                    phoneVerifiedAt: otpVerifiedPhone ? profileRequiredAt : null,
                    emailVerifiedAt: otpVerifiedEmail ? profileRequiredAt : null,
                    lastAuthenticatedAt: profileRequiredAt,
                    profileCompletionRequiredAt: profileRequiredAt,
                    profileCompletedAt: null,
                    totalOrders: 0,
                    totalSpent: 0,
                    lastOrderAt: null,
                    createdAt: profileRequiredAt,
                    updatedAt: profileRequiredAt,
                    deletedAt: null,
                };
                isNewUser = true;
            }
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

    if (!customerProfileRow) {
        customerProfileRow = await getActiveCustomerById(db, customerId);
    }

    if (!customerProfileRow) {
        throw new ServiceUnavailableError("Customer profile could not be read. Please try again.");
    }

    const customerProfile = buildCustomerAuthProfile(customerProfileRow, identifier);

    // Create session. The raw bearer token is only returned for the httpOnly
    // cookie; D1 stores an HMAC hash so a database leak cannot replay sessions.
    const nowMs = Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    const sessionToken = nanoid(48);
    const sessionExpiresAtSeconds = nowSeconds + SESSION_TTL_SECONDS;
    const tokenHash = await hashCustomerSessionToken(sessionToken, input.sessionHashKey);
    const session: CustomerSession = {
        token: sessionToken,
        email: customerProfile.email,
        name: customerProfile.name,
        phone: customerProfile.phone,
        customerId,
        address: customerProfile.address,
        city: customerProfile.city,
        zone: customerProfile.zone,
        area: customerProfile.area,
        cityName: customerProfile.cityName,
        zoneName: customerProfile.zoneName,
        areaName: customerProfile.areaName,
        profileComplete: customerProfile.profileComplete,
        needsProfileCompletion: customerProfile.needsProfileCompletion,
        createdAt: nowMs,
        expiresAt: sessionExpiresAtSeconds * 1000,
    };

    const sessionInsertValues = {
        tokenHash,
        customerId,
        expiresAt: sessionExpiresAtSeconds,
        revokedAt: null,
        createdAt: nowSeconds,
        updatedAt: nowSeconds,
    };

    const sessionStatements: SQLiteBatchItem[] = [];
    if (pendingCustomerInsertValues) {
        sessionStatements.push(
            db.insert(customers).values(pendingCustomerInsertValues) as SQLiteBatchItem,
        );
    } else {
        sessionStatements.push(
            db
                .update(customers)
                .set(customerAccountStateForProof({ verifiedEmail: otpVerifiedEmail, verifiedPhone: otpVerifiedPhone }))
                .where(and(eq(customers.id, customerId), isNull(customers.deletedAt))) as SQLiteBatchItem,
        );
    }
    sessionStatements.push(
        db.insert(customerSessions).values(sessionInsertValues) as SQLiteBatchItem,
    );

    try {
        await safeBatch(db, sessionStatements);
    } catch (error: unknown) {
        if (isCustomerUniqueConstraintError(error)) {
            throw new ValidationError("An account already exists for this phone number. Sign in instead.");
        }
        console.warn("[CustomerAuth] Account/session persistence failed:", error);
        throw new ServiceUnavailableError("Customer session could not be created. Please try again.");
    }

    return {
        success: true,
        session,
        isNewUser,
        customer: {
            ...customerProfile,
            identifier,
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
            customerAddress: customers.address,
            customerCity: customers.city,
            customerZone: customers.zone,
            customerArea: customers.area,
            customerCityName: customers.cityName,
            customerZoneName: customers.zoneName,
            customerAreaName: customers.areaName,
            customerProfileCompletionRequiredAt: customers.profileCompletionRequiredAt,
            customerProfileCompletedAt: customers.profileCompletedAt,
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

    const profileComplete = hasRequiredCustomerProfileFields({
        name: row.customerName,
        phone: row.customerPhone,
        address: row.customerAddress,
        city: row.customerCity,
        zone: row.customerZone,
    });

    return {
        token: sessionToken,
        email: row.customerEmail ?? "",
        name: row.customerName,
        phone: row.customerPhone,
        customerId: row.customerId,
        address: row.customerAddress ?? null,
        city: row.customerCity ?? null,
        zone: row.customerZone ?? null,
        area: row.customerArea ?? null,
        cityName: row.customerCityName ?? null,
        zoneName: row.customerZoneName ?? null,
        areaName: row.customerAreaName ?? null,
        profileComplete,
        needsProfileCompletion: !profileComplete && row.customerProfileCompletionRequiredAt != null,
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
): Promise<{ session: CustomerSession; customer: CustomerAuthProfile }> {
    if (!session.customerId) {
        throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
    }

    const existing = await getActiveCustomerById(db, session.customerId);
    if (!existing) {
        throw new UnauthorizedError("Customer profile is no longer available. Please log in again.");
    }

    const allowedCountriesConfig = await getAllowedCountries(db);
    if (existing.phone) {
        normalizePhoneOrThrow(existing.phone, {
            countries: allowedCountriesConfig.allowedCountries,
            mode: allowedCountriesConfig.allowedCountriesMode,
        });
    }

    const nextName = updates.name !== undefined
        ? normalizeOptionalProfileText(updates.name)
        : existing.name;
    if (!nextName) {
        throw new ValidationError("Name is required to save your profile.");
    }

    const nextAddress = updates.address !== undefined
        ? normalizeOptionalProfileText(updates.address)
        : existing.address;
    const nextLocationInput = {
        city: updates.city !== undefined ? normalizeOptionalProfileText(updates.city) : existing.city,
        zone: updates.zone !== undefined ? normalizeOptionalProfileText(updates.zone) : existing.zone,
        area: updates.area !== undefined ? normalizeOptionalProfileText(updates.area) : existing.area,
    };
    const resolvedLocation = await resolveActiveCustomerLocation(db, nextLocationInput);
    const mergedProfile = {
        name: nextName,
        phone: existing.phone,
        address: nextAddress,
        city: resolvedLocation.city,
        zone: resolvedLocation.zone,
    };
    const profileComplete = hasRequiredCustomerProfileFields(mergedProfile);

    const dbUpdates: Record<string, unknown> = {
        name: nextName,
        address: nextAddress,
        city: resolvedLocation.city,
        zone: resolvedLocation.zone,
        area: resolvedLocation.area,
        cityName: resolvedLocation.cityName,
        zoneName: resolvedLocation.zoneName,
        areaName: resolvedLocation.areaName,
        profileCompletedAt: profileComplete ? sql`coalesce(${customers.profileCompletedAt}, unixepoch())` : null,
        updatedAt: sql`unixepoch()`,
    };

    await db
        .update(customers)
        .set(dbUpdates)
        .where(and(eq(customers.id, session.customerId), isNull(customers.deletedAt)));

    const customer = await getActiveCustomerById(db, session.customerId);

    if (!customer) {
        throw new UnauthorizedError("Customer profile is no longer available. Please log in again.");
    }

    const authProfile = buildCustomerAuthProfile(customer);
    const updatedSession: CustomerSession = {
        ...session,
        email: authProfile.email,
        name: authProfile.name,
        phone: authProfile.phone,
        address: authProfile.address,
        city: authProfile.city,
        zone: authProfile.zone,
        area: authProfile.area,
        cityName: authProfile.cityName,
        zoneName: authProfile.zoneName,
        areaName: authProfile.areaName,
        profileComplete: authProfile.profileComplete,
        needsProfileCompletion: authProfile.needsProfileCompletion,
        customerId: customer.id,
    };

    return { session: updatedSession, customer: authProfile };
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
