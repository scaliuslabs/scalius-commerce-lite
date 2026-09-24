// src/modules/customers/customer-auth.service.ts
// Customer sign-in: one-time codes, account resolution, sessions.
// Used by the customer-auth route handler (apps/api/src/routes/customer-auth.ts).
//
// Identity rule (Shopify's): a VERIFIED identifier owns an account. An email
// owns an account only once a code sent to it was entered; the phone is the
// merchant's CRM key and is proven by an SMS/WhatsApp code. Contact details a
// guest types at checkout never change who an account belongs to, and never
// block anyone from signing in.

import { nanoid } from "nanoid";
import { customers, customerSessions, deliveryLocations } from "@scalius/database/schema";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
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
    enforceOtpSendRateLimits,
} from "./customer-auth-rate-limit";
import { buildVerifiedContactOrderLink } from "./order-account-claim";
import { validateAndFormatPhone, type PhoneCountryPolicy } from "@scalius/shared/customer-utils";
import {
    isContactFieldRequiredForAuthChannel,
    resolveCustomerAuthChannelForRequest,
    type CustomerAuthOtpChannel,
    type CustomerAuthPolicyConfig,
} from "@scalius/shared/customer-auth-policy";
import { getWhatsAppCloudApiSettings } from "../../integrations/whatsapp";
import { getSmsProviderReadiness } from "../../integrations/sms";
import { getEmailProviderReadiness, type EmailRuntimeContext } from "../../integrations/email";
import { isReady } from "@scalius/shared/readiness";
import { getAllowedCountries } from "../settings/site-settings.service";
import {
    customerAuthDocument,
    customerCountriesDocument,
    type CustomerAuthSettings,
} from "../settings/documents";
import { selectSettingsDocuments } from "../settings/settings-store";

// ─────────────────────────────────────────
// Constants
// ─────────────────────────────────────────

export const COOKIE_NAME = "cs_tok";
export const OTP_PREFIX = "cust_otp:";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const OTP_TTL_SECONDS = 60 * 5; // 5 minutes
export const OTP_RESEND_COOLDOWN_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;

export {
    deleteCustomerAuthOtpChallenge,
    cleanupExpiredCustomerAuthOtpChallenges,
    cleanupExpiredCustomerAuthOtpRateLimits,
};

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
    createdAt: number;
    expiresAt: number;
}

export interface SendOtpInput {
    method: "email" | "phone";
    channel?: CustomerAuthOtpChannel;
    identifier: string;
    ip: string;
    emailEnv?: EmailRuntimeContext["env"];
    encryptionKey?: string;
    credentialEncryptionKey?: string;
}

export interface SendOtpResult {
    message: string;
    /** Seconds until another code can be requested for this contact. */
    resendAfterSeconds: number;
    /** Queue payload for async OTP delivery. */
    queuePayload: OtpQueuePayload;
    /** Exact D1 challenge key, so a failed queue handoff can clear it. */
    otpStorageKey: string;
    /** Per-attempt delivery key used for provider idempotency and receipt fencing. */
    deliveryKey: string;
}

/** Name and contact a buyer adds when the proven email/phone has no account yet. */
export interface NewAccountDetails {
    name: string;
    phone?: string;
    email?: string;
}

export interface VerifyOtpInput {
    method: "email" | "phone";
    channel?: CustomerAuthOtpChannel;
    identifier: string;
    code: string;
    account?: NewAccountDetails;
    encryptionKey?: string;
    sessionHashKey?: string;
}

export type VerifyOtpResult =
    | {
        /** The code is right but this email/phone has no account: ask for name (and phone). */
        status: "needs_account_details";
    }
    | {
        status: "signed_in";
        session: CustomerSession;
        customer: CustomerAuthProfile;
        isNewUser: boolean;
    };

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
    const secret = requireKey(input.encryptionKey, "Customer OTP signing key is not configured.");
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

function requireKey(value: string | undefined, message: string): string {
    const key = value?.trim();
    if (!key) throw new ServiceUnavailableError(message);
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

async function getCustomerAuthRuntimePolicy(db: Database): Promise<{
    settings: CustomerAuthSettings;
    policy: CustomerAuthPolicyConfig;
    phoneCountryPolicy: PhoneCountryPolicy;
}> {
    const rows = await selectSettingsDocuments(db, [customerAuthDocument, customerCountriesDocument]);
    const [auth, countries] = await Promise.all([
        customerAuthDocument.fromRows(rows),
        customerCountriesDocument.fromRows(rows),
    ]);
    return {
        settings: auth.value,
        policy: auth.value.policy,
        phoneCountryPolicy: {
            countries: countries.value.allowedCountries,
            mode: countries.value.allowedCountriesMode,
        },
    };
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

function normalizeEmailOrThrow(email: string): string {
    if (!isValidEmailAddress(email)) {
        throw new ValidationError("Enter a valid email address.");
    }
    return email.trim().toLowerCase();
}

function normalizeIdentifier(
    method: "email" | "phone",
    identifier: string,
    phoneCountryPolicy?: PhoneCountryPolicy,
): string {
    if (!identifier?.trim()) {
        throw new ValidationError(method === "email" ? "Enter your email address." : "Enter your phone number.");
    }
    return method === "email"
        ? normalizeEmailOrThrow(identifier)
        : normalizePhoneOrThrow(identifier, phoneCountryPolicy);
}

export async function hashCustomerSessionToken(sessionToken: string, sessionHashKey: string | undefined): Promise<string> {
    const secret = requireKey(sessionHashKey, "Customer session signing key is not configured.");
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

type CustomerRow = typeof customers.$inferSelect;
type CustomerInsertRow = typeof customers.$inferInsert;
type SQLiteBatchItem = BatchItem<"sqlite">;

export interface CustomerAuthProfile {
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
    /** A delivery address is saved (checkout can prefill it). Never required. */
    profileComplete: boolean;
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

function hasSavedDeliveryAddress(row: {
    address?: string | null;
    city?: string | null;
    zone?: string | null;
}): boolean {
    return Boolean(row.address?.trim() && row.city?.trim() && row.zone?.trim());
}

function buildCustomerAuthProfile(row: CustomerRow): CustomerAuthProfile {
    return {
        name: row.name,
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
        profileComplete: hasSavedDeliveryAddress(row),
    };
}

async function getActiveCustomerById(db: Database, customerId: string): Promise<CustomerRow | null> {
    const row = await db
        .select()
        .from(customers)
        .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)))
        .get();
    return row ?? null;
}

type ProofOwner =
    | { kind: "account"; row: CustomerRow }
    /** An unclaimed CRM profile keyed by the phone just proven: the buyer owns it. */
    | { kind: "guest_profile"; row: CustomerRow }
    | { kind: "deleted" }
    | { kind: "none" };

/**
 * Who owns a just-proven identifier. An email resolves ONLY to an account
 * whose email was itself verified, so an email typed into someone else's
 * checkout, or saved unverified on another account, can neither block the
 * inbox owner nor hand them a stranger's account.
 */
async function resolveProofOwner(
    db: Database,
    method: "email" | "phone",
    identifier: string,
): Promise<ProofOwner> {
    if (method === "email") {
        const [verified] = await db
            .select()
            .from(customers)
            .where(and(
                eq(customers.email, identifier),
                isNotNull(customers.emailVerifiedAt),
                isNotNull(customers.accountClaimedAt),
            ))
            .orderBy(sql`${customers.deletedAt} IS NOT NULL`, desc(customers.lastAuthenticatedAt))
            .limit(1);
        if (!verified) return { kind: "none" };
        return verified.deletedAt ? { kind: "deleted" } : { kind: "account", row: verified };
    }

    const row = await db.select().from(customers).where(eq(customers.phone, identifier)).get();
    if (!row) return { kind: "none" };
    if (row.deletedAt) return { kind: "deleted" };
    return row.accountClaimedAt ? { kind: "account", row } : { kind: "guest_profile", row };
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
 * Sends a one-time code to an email or phone. Whether an account exists is
 * decided only after the code is entered, so this never reveals it.
 *
 * @throws {ValidationError} for a malformed identifier
 * @throws {ForbiddenError} when the store has not enabled this channel
 * @throws {RateLimitError} per contact, per resend cooldown, or the IP ceiling
 * @throws {ServiceUnavailableError} when the delivery provider is not ready
 */
export async function sendOtp(
    db: Database,
    input: SendOtpInput,
): Promise<SendOtpResult> {
    const { settings, policy, phoneCountryPolicy } = await getCustomerAuthRuntimePolicy(db);
    const identifier = normalizeIdentifier(input.method, input.identifier, phoneCountryPolicy);
    const channel = resolveCustomerAuthChannelForRequest(policy, input.method, input.channel);
    if (!channel) {
        throw new ForbiddenError(
            input.method === "email"
                ? "This store doesn't offer sign-in by email."
                : "This store doesn't offer sign-in by phone.",
        );
    }
    requireKey(input.credentialEncryptionKey, "Customer OTP delivery target encryption key is not configured.");

    // Resolve and validate the delivery transport before counting the request
    // or touching challenge state.
    const transport = getOtpTransport(input.method, policy, channel);
    await assertOtpChannelReady(db, channel, input);
    const configError = transport.validateConfig(settings);
    if (configError) {
        console.error(`[CustomerAuth] Transport ${transport.label} misconfigured: ${configError}`);
        throw new ServiceUnavailableError(configError);
    }

    await enforceOtpSendRateLimits(db, {
        ip: input.ip,
        identifiers: [`${input.method}:${identifier}`],
        hashKey: input.encryptionKey,
    });

    // D1 is the OTP authority: the challenge row counts attempts and
    // consumes codes atomically. The raw code is never stored or queued.
    const otpKey = await buildCustomerAuthOtpStorageKey(channel, identifier, input.encryptionKey);
    const deliveryKey = createAuthOtpDeliveryKey();
    const code = await deriveCustomerAuthOtpDeliveryCode({
        otpKey,
        deliveryKey,
        encryptionKey: input.encryptionKey,
    });
    const challenge = await persistCustomerAuthOtpChallenge(db, {
        otpKey,
        deliveryKey,
        method: input.method,
        channel,
        identifier,
        deliveryTarget: identifier,
        code,
        encryptionKey: input.encryptionKey,
        contactEncryptionKey: input.credentialEncryptionKey,
        ttlSeconds: OTP_TTL_SECONDS,
        resendCooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
        maxAttempts: OTP_MAX_ATTEMPTS,
    });

    return {
        message: "We sent you a code.",
        resendAfterSeconds: Math.max(0, challenge.resendAvailableAt - Math.floor(Date.now() / 1000)),
        queuePayload: transport.buildQueuePayload(settings, channel, deliveryKey, challenge.expiresAt, otpKey),
        otpStorageKey: otpKey,
        deliveryKey,
    };
}

async function assertOtpChannelReady(
    db: Database,
    channel: CustomerAuthOtpChannel,
    input: Pick<SendOtpInput, "emailEnv" | "credentialEncryptionKey">,
): Promise<void> {
    if (channel === "email") {
        const readiness = await getEmailProviderReadiness({
            db,
            env: input.emailEnv,
            encryptionKey: input.credentialEncryptionKey,
        });
        if (!isReady(readiness)) {
            console.error(`[CustomerAuth] Email transport unavailable: ${readiness.issues[0]?.message ?? "not configured"}`);
            throw new ServiceUnavailableError("Email codes are unavailable right now. Contact the store.");
        }
        return;
    }
    if (channel === "whatsapp") {
        const whatsApp = await getWhatsAppCloudApiSettings(db, input.credentialEncryptionKey);
        if (!whatsApp.accessToken || !whatsApp.phoneNumberId) {
            throw new ServiceUnavailableError("WhatsApp codes are unavailable right now. Contact the store.");
        }
        return;
    }
    const readiness = await getSmsProviderReadiness(db, input.credentialEncryptionKey);
    if (!isReady(readiness)) {
        console.error(`[CustomerAuth] SMS transport unavailable: ${readiness.issues[0]?.message ?? "not configured"}`);
        throw new ServiceUnavailableError("SMS codes are unavailable right now. Contact the store.");
    }
}

/**
 * Checks a one-time code and signs the buyer in. One flow for everyone:
 * - the proven identifier already has an account → signed in;
 * - a proven phone matches an unclaimed CRM profile → that profile becomes
 *   the buyer's account;
 * - otherwise the code is kept (not used up) and the buyer is asked for their
 *   name (and phone, for email sign-ups); the second call with `account`
 *   creates the account.
 * On every sign-in, guest orders whose contact matches an identifier the
 * account has VERIFIED are added to its order history.
 */
export async function verifyOtp(
    db: Database,
    input: VerifyOtpInput,
): Promise<VerifyOtpResult> {
    if (!input.code?.trim()) {
        throw new ValidationError("Enter the 6-digit code.");
    }
    const { policy, phoneCountryPolicy } = await getCustomerAuthRuntimePolicy(db);
    const identifier = normalizeIdentifier(input.method, input.identifier, phoneCountryPolicy);
    const channel = resolveCustomerAuthChannelForRequest(policy, input.method, input.channel)
        ?? (input.method === "email" ? "email" : "sms");
    const otpKey = await buildCustomerAuthOtpStorageKey(channel, identifier, input.encryptionKey);
    const challengeInput = {
        otpKey,
        method: input.method,
        channel,
        identifier,
        code: input.code,
        encryptionKey: input.encryptionKey,
    };
    const owner = await resolveProofOwner(db, input.method, identifier);
    let newAccount: Awaited<ReturnType<typeof prepareNewAccount>> = null;
    if (owner.kind === "none" || owner.kind === "deleted") {
        // Prove the code first (wrong codes still count), so nothing about
        // accounts is revealed to someone who doesn't hold it.
        await claimCustomerAuthOtpChallenge(db, { ...challengeInput, consume: false });
        if (owner.kind === "deleted") {
            throw new ValidationError("This account was closed. Contact the store to restore it.");
        }
        newAccount = await prepareNewAccount(db, input, identifier, channel, policy, phoneCountryPolicy);
        if (!newAccount) return { status: "needs_account_details" };
    }
    await claimCustomerAuthOtpChallenge(db, challengeInput);

    const authenticatedAt = new Date();
    const statements: SQLiteBatchItem[] = [];
    let row: CustomerRow;
    let isNewUser = false;
    if (owner.kind === "account") {
        row = markProven(owner.row, input.method, authenticatedAt);
        statements.push(db.update(customers).set(proofUpdate(input.method)).where(eq(customers.id, row.id)) as SQLiteBatchItem);
    } else if (owner.kind === "guest_profile") {
        row = { ...markProven(owner.row, input.method, authenticatedAt), accountClaimedAt: authenticatedAt };
        isNewUser = true;
        statements.push(db.update(customers)
            .set({ ...proofUpdate(input.method), accountClaimedAt: authenticatedAt })
            .where(and(eq(customers.id, row.id), isNull(customers.accountClaimedAt))) as SQLiteBatchItem);
    } else {
        row = newAccount!.row;
        isNewUser = true;
        statements.push(newAccount!.write);
    }

    const session = await createSessionForCustomer(db, row, input.sessionHashKey, statements);
    return { status: "signed_in", session, customer: buildCustomerAuthProfile(row), isNewUser };
}

function proofUpdate(method: "email" | "phone") {
    return {
        ...(method === "email"
            ? { emailVerifiedAt: sql`coalesce(${customers.emailVerifiedAt}, unixepoch())` }
            : { phoneVerifiedAt: sql`coalesce(${customers.phoneVerifiedAt}, unixepoch())` }),
        lastAuthenticatedAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
    };
}

function markProven(row: CustomerRow, method: "email" | "phone", at: Date): CustomerRow {
    return {
        ...row,
        emailVerifiedAt: method === "email" ? row.emailVerifiedAt ?? at : row.emailVerifiedAt,
        phoneVerifiedAt: method === "phone" ? row.phoneVerifiedAt ?? at : row.phoneVerifiedAt,
        lastAuthenticatedAt: at,
    };
}

/**
 * Validates the details a new buyer adds after proving an email or phone
 * that has no account. Returns null when the details were not sent yet.
 */
async function prepareNewAccount(
    db: Database,
    input: VerifyOtpInput,
    identifier: string,
    channel: CustomerAuthOtpChannel,
    policy: CustomerAuthPolicyConfig,
    phoneCountryPolicy: PhoneCountryPolicy,
): Promise<{ row: CustomerRow; write: SQLiteBatchItem } | null> {
    if (!input.account) return null;
    const name = input.account.name?.trim();
    if (!name) throw new ValidationError("Enter your name.");

    const email = input.method === "email"
        ? identifier
        : input.account.email?.trim() ? normalizeEmailOrThrow(input.account.email) : null;
    if (!email && isContactFieldRequiredForAuthChannel(policy, channel, "email")) {
        throw new ValidationError("Enter your email address.");
    }
    const phone = input.method === "phone"
        ? identifier
        : input.account.phone?.trim() ? normalizePhoneOrThrow(input.account.phone, phoneCountryPolicy) : null;
    if (!phone) throw new ValidationError("Enter your phone number.");

    const now = new Date();
    const proof = {
        accountClaimedAt: now,
        lastAuthenticatedAt: now,
        emailVerifiedAt: input.method === "email" ? now : null,
        phoneVerifiedAt: input.method === "phone" ? now : null,
    };

    if (input.method === "email") {
        // The phone is typed, not proven. It is the CRM key, so an unclaimed
        // profile with that phone is taken over, but its saved address is
        // kept only when the profile carries the email just proven: typing
        // a number must not reveal where its owner lives.
        const existing = await db.select().from(customers).where(eq(customers.phone, phone)).get();
        if (existing?.deletedAt) {
            throw new ValidationError("This phone number belongs to a closed account. Contact the store.");
        }
        if (existing?.accountClaimedAt) {
            throw new ValidationError("This phone number is already on another account. Sign in to that account instead.");
        }
        if (existing) {
            const sameBuyer = existing.email?.trim().toLowerCase() === email;
            const cleared = {
                name,
                email,
                ...(sameBuyer ? {} : {
                    address: null,
                    city: null,
                    zone: null,
                    area: null,
                    cityName: null,
                    zoneName: null,
                    areaName: null,
                }),
                ...proof,
                updatedAt: now,
            };
            return {
                row: { ...existing, ...cleared },
                write: db.update(customers)
                    .set(cleared)
                    .where(and(eq(customers.id, existing.id), isNull(customers.accountClaimedAt))) as SQLiteBatchItem,
            };
        }
    }

    const values: CustomerInsertRow = {
        id: `cust_${nanoid()}`,
        name,
        email,
        phone,
        ...proof,
        createdAt: now,
        updatedAt: now,
    };
    return {
        row: {
            address: null,
            city: null,
            zone: null,
            area: null,
            cityName: null,
            zoneName: null,
            areaName: null,
            totalOrders: 0,
            lastOrderAt: null,
            deletedAt: null,
            ...values,
        } as CustomerRow,
        write: db.insert(customers).values(values) as SQLiteBatchItem,
    };
}

/**
 * Commits the account write, the D1 session and the verified-contact order
 * link in one batch. The raw bearer token only goes to the httpOnly cookie;
 * D1 stores an HMAC so a database leak cannot replay sessions.
 */
async function createSessionForCustomer(
    db: Database,
    row: CustomerRow,
    sessionHashKey: string | undefined,
    accountWrites: SQLiteBatchItem[],
): Promise<CustomerSession> {
    const nowMs = Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    const token = nanoid(48);
    const expiresAt = nowSeconds + SESSION_TTL_SECONDS;
    const tokenHash = await hashCustomerSessionToken(token, sessionHashKey);
    const statements = [
        ...accountWrites,
        db.insert(customerSessions).values({
            tokenHash,
            customerId: row.id,
            expiresAt,
            revokedAt: null,
            createdAt: nowSeconds,
            updatedAt: nowSeconds,
        }) as SQLiteBatchItem,
    ];
    const link = buildVerifiedContactOrderLink(db, {
        customerId: row.id,
        email: row.emailVerifiedAt ? row.email : null,
        phone: row.phoneVerifiedAt ? row.phone : null,
    });
    if (link) statements.push(link as SQLiteBatchItem);

    try {
        await safeBatch(db, statements);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("customers.phone") || message.includes("customer_phone_unique")) {
            throw new ValidationError("This phone number is already on another account. Sign in to that account instead.");
        }
        console.warn("[CustomerAuth] Account/session persistence failed:", error instanceof Error ? error.name : typeof error);
        throw new ServiceUnavailableError("We couldn't sign you in. Please try again.");
    }

    return {
        token,
        ...buildCustomerAuthProfile(row),
        createdAt: nowMs,
        expiresAt: expiresAt * 1000,
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
        .select({ session: customerSessions, customer: customers })
        .from(customerSessions)
        .innerJoin(customers, eq(customerSessions.customerId, customers.id))
        .where(and(
            eq(customerSessions.tokenHash, tokenHash),
            isNull(customerSessions.revokedAt),
            gt(customerSessions.expiresAt, nowSeconds),
            isNull(customers.deletedAt),
        ))
        .get();

    if (!row) return null;
    return {
        token: sessionToken,
        ...buildCustomerAuthProfile(row.customer),
        createdAt: row.session.createdAt * 1000,
        expiresAt: row.session.expiresAt * 1000,
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
        throw new ValidationError("Enter your name.");
    }

    const nextAddress = updates.address !== undefined
        ? normalizeOptionalProfileText(updates.address)
        : existing.address;
    const nextLocationInput = {
        city: updates.city !== undefined ? normalizeOptionalProfileText(updates.city) : existing.city,
        zone: updates.zone !== undefined ? normalizeOptionalProfileText(updates.zone) : existing.zone,
        area: updates.area !== undefined ? normalizeOptionalProfileText(updates.area) : existing.area,
    };
    if (!nextAddress && (nextLocationInput.city || nextLocationInput.zone)) {
        throw new ValidationError("Enter your delivery address.");
    }
    const resolvedLocation = await resolveActiveCustomerLocation(db, nextLocationInput);

    const dbUpdates: Record<string, unknown> = {
        name: nextName,
        address: nextAddress,
        city: resolvedLocation.city,
        zone: resolvedLocation.zone,
        area: resolvedLocation.area,
        cityName: resolvedLocation.cityName,
        zoneName: resolvedLocation.zoneName,
        areaName: resolvedLocation.areaName,
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
    return { session: { ...session, ...authProfile }, customer: authProfile };
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
