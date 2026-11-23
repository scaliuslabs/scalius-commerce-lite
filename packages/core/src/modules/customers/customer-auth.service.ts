import { sweepExpiredRows } from "../../utils/sweep-expired-rows";
// src/modules/customers/customer-auth.service.ts
// Customer sign-in: one-time codes, account resolution, sessions.
// Used by the customer-auth route handler (apps/api/src/routes/customer-auth/).
//
// Identity rule (Shopify's): a VERIFIED identifier owns an account. An email
// owns an account only once a code sent to it was entered; the phone is the
// merchant's CRM key and is proven by an SMS/WhatsApp code. Contact details a
// guest types at checkout never change who an account belongs to, and never
// block anyone from signing in.

import { isEmailAddress, trimTrailingCharacter } from "@scalius/shared/text-scan";
import { nanoid } from "nanoid";
import { customerAddresses, customerIdentities, customers, customerSessions, firstCustomerAddressId, orders } from "@scalius/database/schema";
import { and, desc, eq, gt, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import {
    ValidationError,
    ConflictError,
    ForbiddenError,
    ServiceUnavailableError,
    UnauthorizedError,
} from "@scalius/core/errors";
import { buildOtpDelivery, type OtpDelivery } from "./otp-transport";
import { createAuthOtpDeliveryKey } from "./otp-delivery-receipts";
import {
    claimCustomerAuthOtpChallenge,
    persistCustomerAuthOtpChallenge,
    cleanupExpiredCustomerAuthOtpChallenges,
    buildCustomerAuthOtpStorageKey,
    extendPendingCustomerAuthOtpChallenge,
} from "./customer-auth-otp-challenges";
import {
    cleanupExpiredCustomerAuthOtpRateLimits,
    gateOtpStoreChannelSend,
    enforceOtpSendRateLimits,
    OtpContactCeilingError,
} from "./customer-auth-rate-limit";
import { buildVerifiedContactOrderLink, phoneChangedHistory, signedUpHistory } from "./customer-identity";
import { recoveryOwnerQuery } from "./sign-in-recovery";
import {
    insertCustomer,
    isSignInChangedError,
    linkIdentity,
    proveSignIn,
    signInChangedConflict,
    signInWithLinkedIdentity,
    writeSignIn,
} from "./sign-in-writes";
import { parseContactPhone, validateAndFormatPhone, type PhoneCountryPolicy } from "@scalius/shared/customer-utils";
import { isQualifiedProviderId, type IdentityExchangeOutput } from "@scalius/shared/plugins/providers";
import {
    newAccountPhoneNeed,
    phoneOrNull,
    resolveSignInChannel,
    storedPhone,
    type CustomerAuthOtpChannel,
    type CustomerIdentitySettings,
} from "@scalius/shared/customer-auth-policy";
import type { EmailRuntimeContext } from "../../integrations/email";
import type { AppProviders } from "../../integrations/provider-port";
import { assertCustomerChannelReady, phoneCodeChannel } from "./customer-code-channels";
import { readSignInPolicy } from "./sign-in-policy";
import { formatAddressInline, usesDeliveryHierarchy } from "@scalius/shared/address";
import { customerAddressFromRow, type CustomerAddress } from "./addresses";
import { otpHmacSha256Hex } from "../../utils/credential-encryption";

// ─────────────────────────────────────────
// Constants
// ─────────────────────────────────────────

export const COOKIE_NAME = "cs_tok";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const OTP_TTL_SECONDS = 60 * 5; // 5 minutes
const OTP_MAX_ATTEMPTS = 5;

export {
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
    /** The address book's default address (checkout prefills it), or null. */
    defaultAddress: CustomerAddress | null;
    profileComplete: boolean;
    createdAt: number;
    expiresAt: number;
    /** The account is tax-exempt (checkout prices it so); null: it pays tax. Never shown to the buyer. */
    taxExemption?: { exemptionId: string | null } | null;
}

export interface SendOtpInput {
    method: "email" | "phone";
    channel?: CustomerAuthOtpChannel;
    identifier: string;
    ip: string;
    emailEnv?: EmailRuntimeContext["env"];
    encryptionKey?: string;
    credentialEncryptionKey?: string;
    /** The app providers a saved SMS or email choice may name. */
    appProviders?: AppProviders;
    /**
     * Binds the code to one change (`phoneChangeBinding`): its challenge is
     * keyed by the contact and the change, so it proves nothing else. A bound
     * code is not a sign-in: it goes out on any channel of its method the
     * store can send on, whether or not sign-in offers it.
     */
    bind?: string;
    /** The message the code goes out with (`phone_change` names the new number); default sign-in. */
    purpose?: "customer_login" | "phone_change";
    /** For `phone_change`: the new number, masked (`•••022`). */
    maskedPhone?: string;
}

export interface SendOtpResult {
    message: string;
    /** Seconds until another code can be requested for this contact. */
    resendAfterSeconds: number;
    /**
     * Opaque references the API sends the code from, after the response; null
     * when nothing is sent (the store's hourly ceiling held a code back).
     */
    otpDelivery: OtpDelivery | null;
}

/** Name and contact a buyer adds when the proven email/phone has no account yet. */
export interface NewAccountDetails {
    name: string;
    phone?: string;
    email?: string;
    /** Save the delivery address of the latest order placed with the proven contact. */
    saveOrderAddress?: boolean;
}

/**
 * What the store already knows about a new buyer, from the latest order placed
 * with the email/phone they just proved: shown pre-filled, never saved unasked.
 */
export interface NewAccountSuggestion {
    name: string | null;
    phone: string | null;
    email: string | null;
    address: { orderNumber: number | null; text: string } | null;
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
        suggestion: NewAccountSuggestion | null;
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

export async function deriveCustomerAuthOtpDeliveryCode(input: {
    otpKey: string;
    deliveryKey: string;
    encryptionKey?: string;
}): Promise<string> {
    const secret = requireKey(input.encryptionKey, "Customer OTP signing key is not configured.");
    const signature = await otpHmacSha256Hex(secret, `customer-auth-otp-delivery:${input.otpKey}:${input.deliveryKey}`);
    // The signature's first four bytes, big-endian.
    const num = (Number.parseInt(signature.slice(0, 8), 16) % 900000) + 100000;
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
    const normalized = trimTrailingCharacter((cookieDomain ?? "")
        .trim()
        .replace(/^domain=/i, "")
        .replace(/^\.+/, "")
        .toLowerCase(), ".");

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

function isValidEmailAddress(value: string): boolean {
    return isEmailAddress(value.trim());
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
    /** The WhatsApp number when it is not the phone (absent: the phone). */
    whatsapp?: string;
    /** The phone is proven by code: the account signs in with it, and changing it takes a code. */
    phoneVerified: boolean;
    customerId?: string;
    /** The address book's default address (checkout prefills it), or null. */
    defaultAddress: CustomerAddress | null;
    /** A complete default delivery address is saved (checkout can prefill it). Never required. */
    profileComplete: boolean;
}

type CustomerAddressRowValue = typeof customerAddresses.$inferSelect;

function normalizeOptionalProfileText(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

/** A default address checkout can prefill: a first line and, in Bangladesh, its city and thana. */
function isCompleteDeliveryAddress(address: CustomerAddress | null): boolean {
    if (!address?.line1?.trim() || address.validationSkipped) return false;
    return usesDeliveryHierarchy(address.countryCode) ? Boolean(address.city && address.zone) : true;
}

function buildCustomerAuthProfile(row: CustomerRow, addressRow: CustomerAddressRowValue | null = null): CustomerAuthProfile {
    const defaultAddress = addressRow ? customerAddressFromRow(addressRow) : null;
    return {
        name: row.name,
        email: row.email ?? "",
        phone: phoneOrNull(row.phone) ?? undefined,
        whatsapp: row.whatsapp ?? undefined,
        phoneVerified: Boolean(row.phoneVerifiedAt),
        customerId: row.id,
        defaultAddress,
        profileComplete: isCompleteDeliveryAddress(defaultAddress),
    };
}

/** The default address joined in the same statement as its customer. */
const joinDefaultAddress = and(
    eq(customerAddresses.customerId, customers.id),
    eq(customerAddresses.isDefault, true),
);

async function getActiveCustomerById(db: Database, customerId: string): Promise<CustomerRow | null> {
    const row = await db
        .select()
        .from(customers)
        .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)))
        .get();
    return row ?? null;
}

/** The active customer and its default address, in one statement. */
async function getActiveCustomerProfileRow(
    db: Database,
    customerId: string,
): Promise<{ customer: CustomerRow; address: CustomerAddressRowValue | null } | null> {
    const row = await db
        .select({ customer: customers, address: customerAddresses })
        .from(customers)
        .leftJoin(customerAddresses, joinDefaultAddress)
        .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)))
        .get();
    return row ?? null;
}

type ProofOwner =
    | { kind: "account"; row: CustomerRow; address: CustomerAddressRowValue | null }
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
        // The live owner: exactly the predicates of the partial unique index
        // `customers_verified_email_unique` (lower(email), email verified, not
        // deleted), so this is one index SEARCH, never a scan of every customer.
        const [verified] = await db
            .select({ customer: customers, address: customerAddresses })
            .from(customers)
            .leftJoin(customerAddresses, joinDefaultAddress)
            .where(and(
                sql`lower(${customers.email}) = ${identifier}`,
                isNotNull(customers.emailVerifiedAt),
                isNull(customers.deletedAt),
                isNotNull(customers.accountClaimedAt),
            ))
            .limit(1);
        if (verified) return { kind: "account", row: verified.customer, address: verified.address };
        // Only on a miss, in one round trip: an account a sign-in reset named this email on, and whether it is
        // the email of a closed account. The closed-account read uses exactly the terms of the
        // partial index `customers_deleted_verified_email_idx` (lower(email); deleted, email
        // verified, claimed), so it is one index SEARCH of the closed verified accounts.
        const [staffRows, closedRows] = await db.batch([
            recoveryOwnerQuery(db, "email", identifier),
            db.select({ id: customers.id })
                .from(customers)
                .where(and(
                    sql`lower(${customers.email}) = ${identifier}`,
                    isNotNull(customers.deletedAt),
                    isNotNull(customers.emailVerifiedAt),
                    isNotNull(customers.accountClaimedAt),
                ))
                .limit(1),
        ] as unknown as Parameters<Database["batch"]>[0]) as unknown as [Array<{ id: string }>, Array<{ id: string }>];
        const recovered = await recoveryOwner(db, staffRows);
        if (recovered) return recovered;
        return closedRows[0] ? { kind: "deleted" } : { kind: "none" };
    }

    // A phone owns an account only once proven. Accounts that merely typed
    // this phone are not candidates, and neither is the phone's guest record:
    // it can hold several people's orders, so the buyer creates their own
    // account and the orders placed with the proven phone move into it.
    const rows = await db.select({ customer: customers, address: customerAddresses })
        .from(customers)
        .leftJoin(customerAddresses, joinDefaultAddress)
        .where(and(
            eq(customers.phone, identifier),
            isNotNull(customers.phoneVerifiedAt),
            isNotNull(customers.accountClaimedAt),
        ));
    const verified = rows.find((row) => !row.customer.deletedAt);
    if (verified) return { kind: "account", row: verified.customer, address: verified.address };
    if (rows.length > 0) return { kind: "deleted" };
    // Only on a miss: an account a sign-in reset named this phone on.
    return await recoveryOwner(db, await recoveryOwnerQuery(db, "phone", identifier)) ?? { kind: "none" };
}

/**
 * The one account a sign-in reset named this contact on, while that reset
 * stands (`recoveryOwnerQuery`); read whole only then. Two such accounts
 * reach neither.
 */
async function recoveryOwner(db: Database, rows: ReadonlyArray<{ id: string }>): Promise<ProofOwner | null> {
    if (rows.length !== 1) return null;
    const owner = await getActiveCustomerProfileRow(db, rows[0]!.id);
    return owner ? { kind: "account", row: owner.customer, address: owner.address } : null;
}

/**
 * Whether a contact belongs to an account that already proved it (a verified
 * email or phone): the store's code ceiling never holds back its codes.
 */
export async function isProvenAccountContact(db: Database, method: "email" | "phone", identifier: string): Promise<boolean> {
    const normalized = method === "email" ? identifier.trim().toLowerCase() : identifier.trim();
    return (await resolveProofOwner(db, method, normalized)).kind === "account";
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
    const { identity, phoneCountryPolicy } = await readSignInPolicy(db);
    const identifier = normalizeIdentifier(input.method, input.identifier, phoneCountryPolicy);
    // Only the channels the store chose in Customer accounts; never another one.
    // A bound change code is not a sign-in: email goes out wherever the store can send it.
    const channel = input.bind && input.method === "email"
        ? "email" as const
        : resolveSignInChannel(identity.channels, input.method, input.channel);
    if (!channel) {
        throw new ForbiddenError(
            input.method === "email"
                ? "This store doesn't offer sign-in by email."
                : "Phone sign-in isn't available yet. Use your email.",
        );
    }
    requireKey(input.credentialEncryptionKey, "Customer OTP delivery target encryption key is not configured.");

    // A chosen channel that can't send fails closed before counting the
    // request or touching challenge state.
    await assertCustomerChannelReady(db, channel, input);

    // D1 is the OTP authority: the challenge row counts attempts and
    // consumes codes atomically. The raw code is never stored or queued.
    const otpKey = await buildCustomerAuthOtpStorageKey(channel, boundIdentifier(identifier, input.bind), input.encryptionKey);
    let allowance: Awaited<ReturnType<typeof enforceOtpSendRateLimits>>;
    try {
        allowance = await enforceOtpSendRateLimits(db, {
            ip: input.ip,
            identifiers: [`${input.method}:${identifier}`],
            hashKey: input.encryptionKey,
        });
    } catch (error) {
        // Whoever flooded this contact can't strand its owner: the latest code
        // already delivered stays usable until requests open again.
        if (error instanceof OtpContactCeilingError) {
            await extendPendingCustomerAuthOtpChallenge(db, otpKey, error.retryAfterSeconds ?? OTP_TTL_SECONDS);
        }
        throw error;
    }
    // The store's hourly ceiling for this channel is counted atomically before
    // the code is stored, so a burst cannot pass it. Over the ceiling, only a
    // contact that already proved itself (a buyer with an account) is sent its
    // code; for anyone else only the resend cooldown is written (any code it
    // already holds stays usable) and nothing is delivered, with the same
    // answer and the same cooldown, so neither reveals who has an account.
    const deliveryKey = createAuthOtpDeliveryKey();
    const code = await deriveCustomerAuthOtpDeliveryCode({
        otpKey,
        deliveryKey,
        encryptionKey: input.encryptionKey,
    });
    const { challenge, holdBack } = await gateOtpStoreChannelSend(db, {
        channel,
        hashKey: input.encryptionKey,
        isProvenContact: () => isProvenAccountContact(db, input.method, identifier),
    }, async ({ heldBack }) => ({
        holdBack: heldBack,
        challenge: await persistCustomerAuthOtpChallenge(db, {
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
            resendCooldownSeconds: allowance.resendCooldownSeconds,
            maxAttempts: OTP_MAX_ATTEMPTS,
            holdBack: heldBack,
        }),
    }));
    // From the clock reading the row was written with: a second boundary
    // crossed since then must not shave a second off the cooldown shown.
    const { resendAfterSeconds } = challenge;
    if (holdBack) return { message: "We sent you a code.", resendAfterSeconds, otpDelivery: null };

    return {
        message: "We sent you a code.",
        resendAfterSeconds,
        otpDelivery: buildOtpDelivery({
            channel,
            purpose: input.purpose ?? "customer_login",
            challengeKey: otpKey,
            deliveryKey,
            ...(input.maskedPhone ? { maskedPhone: input.maskedPhone } : {}),
        }),
    };
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
    const { identity, phoneCountryPolicy } = await readSignInPolicy(db);
    const identifier = normalizeIdentifier(input.method, input.identifier, phoneCountryPolicy);
    const channel = resolveSignInChannel(identity.channels, input.method, input.channel);
    if (!channel) throw new ValidationError("There's no active code. Send a new code.");
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
        const latestOrder = await latestOrderForProvenContact(db, input.method, identifier);
        newAccount = await prepareNewAccount(db, input, identifier, identity, phoneCountryPolicy, latestOrder);
        if (!newAccount) return { status: "needs_account_details", suggestion: suggestNewAccount(latestOrder) };
    }
    await claimCustomerAuthOtpChallenge(db, challengeInput);

    const authenticatedAt = new Date();
    const statements: SQLiteBatchItem[] = [];
    let row: CustomerRow;
    let address: CustomerAddressRowValue | null;
    let isNewUser = false;
    if (owner.kind === "account") {
        row = markProven(owner.row, input.method, authenticatedAt);
        address = owner.address;
        // Decided from the row as read: the contact it holds is the one the code went to.
        statements.push(...proveSignIn(db, owner.row, input.method, identifier));
    } else {
        row = newAccount!.row;
        address = newAccount!.address;
        isNewUser = true;
        statements.push(...newAccount!.writes, signedUpHistory(db, { accountId: row.id, via: input.method }) as SQLiteBatchItem);
    }

    const session = await createSessionForCustomer(db, row, address, input.sessionHashKey, statements);
    return { status: "signed_in", session, customer: buildCustomerAuthProfile(row, address), isNewUser };
}

/** What `signInWithIdentity` takes: the app provider and the facts its `exchange` verified. */
export interface IdentitySignInInput {
    /** The app provider id (`<plugin id>:<provider id>`). */
    providerId: string;
    facts: Pick<IdentityExchangeOutput, "subject" | "email" | "emailVerified" | "phone" | "phoneVerified" | "name">;
    sessionHashKey?: string;
}

export type IdentitySignInResult =
    | {
        /** A new account needs details the provider did not verify: the buyer uses the normal sign-in page. */
        status: "needs_account_details";
    }
    | {
        status: "signed_in";
        session: CustomerSession;
        customer: CustomerAuthProfile;
        isNewUser: boolean;
        /** `known`: the provider's subject was seen before; `linked`: a verified email/phone proved an existing account; `created`: a new account. */
        via: "known" | "linked" | "created";
    };

/**
 * Signs a buyer in with a verified identity from an app provider ("Continue
 * with Google"). The provider's facts are trusted only as far as the provider
 * verified them:
 * - a known `(provider, subject)` signs in its customer;
 * - else a VERIFIED email (then phone) that proves an existing account links
 *   the identity to it and counts as that contact's proof;
 * - else a new account, when the store's customer accounts policy accepts it
 *   from the verified facts (a name, the email or phone the policy requires);
 *   otherwise the buyer is asked for details on the normal sign-in page.
 * An unverified email or phone never links an account and never creates one.
 * The identity row, the proof and the session commit in one batch.
 *
 * @throws {ValidationError} for a closed account or a malformed provider id
 */
export async function signInWithIdentity(
    db: Database,
    input: IdentitySignInInput,
): Promise<IdentitySignInResult> {
    const subject = input.facts.subject.trim();
    if (!isQualifiedProviderId(input.providerId) || !subject || subject.length > 255) {
        throw new ValidationError("This way of signing in isn't available.");
    }
    const closed = () => new ValidationError("This account was closed. Contact the store to restore it.");
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const linked = { providerId: input.providerId, subject, at: nowSeconds };

    const known = await db
        .select({ customer: customers, address: customerAddresses })
        .from(customerIdentities)
        .innerJoin(customers, eq(customers.id, customerIdentities.customerId))
        .leftJoin(customerAddresses, joinDefaultAddress)
        .where(and(eq(customerIdentities.providerId, input.providerId), eq(customerIdentities.subject, subject)))
        .get();
    if (known) {
        if (known.customer.deletedAt) throw closed();
        const row: CustomerRow = { ...known.customer, lastAuthenticatedAt: now };
        const session = await createSessionForCustomer(db, row, known.address, input.sessionHashKey,
            signInWithLinkedIdentity(db, known.customer, linked));
        return { status: "signed_in", session, customer: buildCustomerAuthProfile(row, known.address), isNewUser: false, via: "known" };
    }

    // Only what the provider verified counts; the rest is ignored.
    const email = input.facts.emailVerified && input.facts.email && isValidEmailAddress(input.facts.email)
        ? input.facts.email.trim().toLowerCase()
        : null;
    let phone: string | null = null;
    if (input.facts.phoneVerified && input.facts.phone) {
        try {
            phone = validateAndFormatPhone(input.facts.phone);
        } catch {
            phone = null;
        }
    }

    const candidates: Array<{ method: "email" | "phone"; identifier: string }> = [];
    if (email) candidates.push({ method: "email", identifier: email });
    if (phone) candidates.push({ method: "phone", identifier: phone });
    for (const { method, identifier } of candidates) {
        const owner = await resolveProofOwner(db, method, identifier);
        if (owner.kind === "deleted") throw closed();
        if (owner.kind !== "account") continue;
        const row = markProven(owner.row, method, now);
        const session = await createSessionForCustomer(db, row, owner.address, input.sessionHashKey,
            proveSignIn(db, owner.row, method, identifier, linked));
        return { status: "signed_in", session, customer: buildCustomerAuthProfile(row, owner.address), isNewUser: false, via: "linked" };
    }

    // A new account: the same rules as a code sign-up, from verified facts only.
    const name = input.facts.name?.trim();
    const method: "email" | "phone" | null = email ? "email" : phone ? "phone" : null;
    if (!name || !method) return { status: "needs_account_details" };
    const { identity, phoneCountryPolicy } = await readSignInPolicy(db);
    let accountPhone: string | null = null;
    if (phone) {
        try {
            accountPhone = validateAndFormatPhone(phone, phoneCountryPolicy);
        } catch {
            accountPhone = null;
        }
    }
    if (!email && identity.email === "required") return { status: "needs_account_details" };
    if (!accountPhone && newAccountPhoneNeed(identity, method) === "required") return { status: "needs_account_details" };

    const values: CustomerInsertRow = {
        id: `cust_${nanoid()}`,
        name,
        email,
        phone: storedPhone(accountPhone),
        origin: "account",
        accountClaimedAt: now,
        lastAuthenticatedAt: now,
        emailVerifiedAt: email ? now : null,
        phoneVerifiedAt: accountPhone ? now : null,
        createdAt: now,
        updatedAt: now,
    };
    const row = { totalOrders: 0, lastOrderAt: null, deletedAt: null, ...values } as CustomerRow;
    const session = await createSessionForCustomer(db, row, null, input.sessionHashKey, [
        insertCustomer(db, values),
        signedUpHistory(db, { accountId: row.id, via: method }) as SQLiteBatchItem,
        linkIdentity(db, { ...linked, customerId: row.id }),
    ]);
    return { status: "signed_in", session, customer: buildCustomerAuthProfile(row, null), isNewUser: true, via: "created" };
}

/**
 * The account page's only prompt about phones: the buyer's OWN account phone,
 * unproven, when a code can reach it. It never mentions orders, counts or
 * anyone else's records; proving the phone is what brings over orders placed
 * with it.
 */
export async function getAccountPhoneVerificationPrompt(
    db: Database,
    accountId: string,
    credentialEncryptionKey: string | undefined,
    appProviders?: AppProviders,
): Promise<{ phone: string } | null> {
    const account = await getActiveCustomerById(db, accountId);
    const phone = phoneOrNull(account?.phone);
    if (!account?.accountClaimedAt || account.phoneVerifiedAt || !phone) return null;
    const { identity } = await readSignInPolicy(db);
    return await phoneCodeChannel(db, identity, credentialEncryptionKey, appProviders) ? { phone } : null;
}

/** A challenge's key identifier: the contact, or the contact and the one change it proves. */
function boundIdentifier(identifier: string, bind: string | undefined): string {
    return bind ? `${identifier}#${bind}` : identifier;
}

/** The one change a pair of codes proves: this account's phone becoming this number. */
function phoneChangeBinding(accountId: string, phone: string): string {
    return `phone-change:${accountId}:${phone}`;
}

/** `details.reason` when a phone change is asked for without the codes it needs. */
export const PHONE_CHANGE_NEEDS_CODES_REASON = "phone_change_needs_codes";

/**
 * The identity the account already signs in with, which adding or changing a
 * sign-in phone must be confirmed from: its proven email, else its proven
 * phone (the one being replaced).
 */
function currentSignIn(account: CustomerRow): { method: "phone" | "email"; identifier: string } | null {
    if (account.emailVerifiedAt && account.email) return { method: "email", identifier: account.email.trim().toLowerCase() };
    const phone = phoneOrNull(account.phone);
    if (account.phoneVerifiedAt && phone) return { method: "phone", identifier: phone };
    return null;
}

function noSignInToConfirm(): ConflictError {
    return new ConflictError("We can't send a code to how you sign in now. Ask the store to change your phone for you.", {
        field: "phone",
        reason: "no_sign_in_to_confirm",
        allowed: ["ask_store"],
    });
}

/** A number as a code message names it: its last three digits ("the number ending 022"). */
function maskedNumber(phone: string): string {
    return phone.replace(/\D/g, "").slice(-3);
}

/**
 * The number an account phone code is for: the account's own phone, or a new
 * number the buyer is moving their phone to (read as checkout reads it).
 */
function accountPhoneTarget(account: CustomerRow, typed: string | null | undefined, policy: PhoneCountryPolicy): { phone: string; changing: boolean } {
    const own = phoneOrNull(account.phone);
    const phone = typed?.trim() ? contactNumberOrThrow(typed, "phone", policy) : own;
    if (!phone) throw new ValidationError("Add a phone number to your account first.");
    return { phone, changing: phone !== own };
}

async function assertPhoneFree(db: Database, accountId: string, phone: string): Promise<void> {
    const otherOwner = await db.select({ id: customers.id }).from(customers).where(and(
        eq(customers.phone, phone),
        isNotNull(customers.phoneVerifiedAt),
        isNotNull(customers.accountClaimedAt),
        isNull(customers.deletedAt),
    )).get();
    if (otherOwner && otherOwner.id !== accountId) {
        throw new ConflictError("This phone number is verified on another account. Sign in with it instead.", { field: "phone", reason: "phone_on_another_account" });
    }
}

export interface AccountPhoneCodeResult {
    message: string;
    resendAfterSeconds: number;
    /** The codes to send after the response: the one to how the account signs in now, then the one to the number. */
    otpDeliveries: OtpDelivery[];
    /** Where the confirming code went (`email` or `phone`); the verify call sends it as `currentCode`. */
    confirmWith: "phone" | "email";
}

/**
 * Starts making a phone the account's sign-in phone: its own unproven phone,
 * or with `phone` a new number. Adding or changing a sign-in identity on an
 * account that already has one always takes two codes, both bound to this
 * account and this number and as short-lived as a sign-in code: one to the
 * identity the account signs in with now (its proven email, else its proven
 * phone) and one to the number. A session alone, or a code to a planted
 * number alone, never adds a way in. The codes go out as a phone change
 * (purpose `phone_change`), naming the new number's last digits.
 */
export async function sendAccountPhoneCode(
    db: Database,
    input: Omit<SendOtpInput, "method" | "identifier" | "channel" | "bind" | "purpose" | "maskedPhone"> & { accountId: string; phone?: string | null },
): Promise<AccountPhoneCodeResult> {
    const account = await getActiveCustomerById(db, input.accountId);
    if (!account?.accountClaimedAt) throw new UnauthorizedError("Please sign in again.");
    const { identity, phoneCountryPolicy } = await readSignInPolicy(db);
    const { phone, changing } = accountPhoneTarget(account, input.phone, phoneCountryPolicy);
    if (account.phoneVerifiedAt && !changing) throw new ConflictError("Your phone number is already verified.");
    // Whether the number is proven on another account is answered only at verify, after both
    // codes: a send says the same for a free and a taken number.
    const channel = await phoneCodeChannel(db, identity, input.credentialEncryptionKey, input.appProviders);
    if (!channel) throw new ServiceUnavailableError("Text message codes aren't available right now.");
    const current = currentSignIn(account);
    if (!current) throw noSignInToConfirm();
    const { accountId: _accountId, phone: _phone, ...send } = input;
    const bound = { bind: phoneChangeBinding(account.id, phone), purpose: "phone_change" as const, maskedPhone: maskedNumber(phone) };
    let confirm: SendOtpResult;
    try {
        confirm = await sendOtp(db, { ...send, ...bound, method: current.method, identifier: current.identifier, ...(current.method === "phone" ? { channel } : {}) });
    } catch (error) {
        // The store cannot send to the identity the account signs in with: only the store can change it.
        if (error instanceof ForbiddenError || error instanceof ServiceUnavailableError) throw noSignInToConfirm();
        throw error;
    }
    const prove = await sendOtp(db, { ...send, ...bound, method: "phone", identifier: phone, channel });
    const where = current.method === "phone" ? `your current phone ${formatAccountPhone(current.identifier)}` : "your email";
    return {
        message: `We sent a code to ${where} and one to ${formatAccountPhone(phone)}.`,
        resendAfterSeconds: Math.max(confirm.resendAfterSeconds, prove.resendAfterSeconds),
        otpDeliveries: [confirm.otpDelivery, prove.otpDelivery].filter((delivery): delivery is OtpDelivery => delivery !== null),
        confirmWith: current.method,
    };
}

function formatAccountPhone(phone: string): string {
    const digits = phone.replace(/\D/g, "");
    const local = digits.startsWith("880") ? `0${digits.slice(3)}` : phone;
    return /^01\d{9}$/.test(local) ? `${local.slice(0, 5)}-${local.slice(5)}` : phone;
}

export interface AccountPhoneProof {
    movedOrders: number;
    /** The session that replaces the caller's: every session of the account, the caller's too, is revoked. */
    session: CustomerSession;
    /** Notices to every identity proven before the change, sent after the response. */
    notices: OtpDelivery[];
}

/**
 * Finishes `sendAccountPhoneCode`: `code` (sent to the number) and
 * `currentCode` (sent to how the account signs in now) must both be the
 * codes of this one change; both are checked before either is used, and the
 * number must not be proven on another account. Then, in one batch: the
 * number becomes the account's proven phone (an old proven phone stops
 * signing in; a WhatsApp number equal to it becomes none), the orders placed
 * with it join, every session of the account is revoked and a new one is
 * issued for the caller, and the change is written to the customer's
 * history. After the batch, a notice goes to the identity that signed in
 * before (the proven email, else the old phone by text message).
 */
export async function verifyAccountPhoneCode(
    db: Database,
    input: {
        accountId: string;
        code: string;
        encryptionKey?: string;
        credentialEncryptionKey?: string;
        sessionHashKey?: string;
        phone?: string | null;
        /** The code sent to how the account signs in now. */
        currentCode?: string | null;
        /** The caller's session: the new session is issued only while it is still live. */
        callerSessionTokenHash?: string | null;
    },
): Promise<AccountPhoneProof> {
    if (!input.code?.trim()) throw new ValidationError("Enter the 6-digit code.");
    const loaded = await getActiveCustomerProfileRow(db, input.accountId);
    const account = loaded?.customer;
    if (!account?.accountClaimedAt) throw new UnauthorizedError("Please sign in again.");
    const { identity, phoneCountryPolicy } = await readSignInPolicy(db);
    const { phone } = accountPhoneTarget(account, input.phone, phoneCountryPolicy);
    const current = currentSignIn(account);
    if (!current) throw noSignInToConfirm();
    if (!input.currentCode?.trim()) {
        throw new ValidationError(`Enter the code we sent to your ${current.method === "email" ? "email" : "current phone"}.`, {
            field: "currentCode",
            reason: "current_sign_in_code_required",
        });
    }
    const channel = resolveSignInChannel(identity.channels, "phone");
    if (!channel) throw new ValidationError("There's no active code. Send a new code.");
    const bind = phoneChangeBinding(account.id, phone);
    const currentChannel = current.method === "email" ? "email" as const : channel;
    const claims: Array<Parameters<typeof claimCustomerAuthOtpChallenge>[1]> = [
        {
            otpKey: await buildCustomerAuthOtpStorageKey(channel, boundIdentifier(phone, bind), input.encryptionKey),
            method: "phone", channel, identifier: phone, code: input.code, encryptionKey: input.encryptionKey,
        },
        {
            otpKey: await buildCustomerAuthOtpStorageKey(currentChannel, boundIdentifier(current.identifier, bind), input.encryptionKey),
            method: current.method, channel: currentChannel, identifier: current.identifier, code: input.currentCode, encryptionKey: input.encryptionKey,
        },
    ];
    // Both codes are checked before either is used up (a check never extends a code's life).
    for (const claim of claims) await claimCustomerAuthOtpChallenge(db, { ...claim, consume: false, extend: false });
    // Only a buyer holding both codes learns whether the number is proven on another account; neither code is used up then.
    await assertPhoneFree(db, account.id, phone);
    for (const claim of claims) await claimCustomerAuthOtpChallenge(db, claim);

    const joining = await db.select({ count: sql<number>`count(*)` }).from(orders).where(and(
        eq(orders.customerPhone, phone),
        isNull(orders.accountOwnerCustomerId),
        isNull(orders.deletedAt),
    )).get();
    const now = new Date();
    const whatsapp = account.whatsapp && account.whatsapp !== phone ? account.whatsapp : null;
    const proven: CustomerRow = { ...account, phone, whatsapp, phoneVerifiedAt: now, signInRecovery: null, signInRecoveryAt: null, lastAuthenticatedAt: now };
    let session: CustomerSession;
    try {
        session = await createSessionForCustomer(db, proven, loaded!.address, input.sessionHashKey, [
            // Two finishes of one change race: only the one whose session is still live writes.
            ...(input.callerSessionTokenHash ? [buildBatchGuard(db, sql`EXISTS (SELECT 1 FROM ${customerSessions}
                WHERE ${customerSessions.tokenHash} = ${input.callerSessionTokenHash} AND ${customerSessions.revokedAt} IS NULL)`, CALLER_SESSION_ENDED) as SQLiteBatchItem] : []),
            // Decided from the account as read: a sign-in write since (a reset, a staff edit) refuses it.
            ...writeSignIn(db, account, {
                phone,
                whatsapp,
                phoneVerifiedAt: sql`unixepoch()`,
                signInRecovery: null,
                signInRecoveryAt: null,
                lastAuthenticatedAt: sql`unixepoch()`,
            }),
            // Every session ends, the caller's too (its cookie may be a copy); the new one is written after.
            db.update(customerSessions).set({ revokedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
                .where(and(eq(customerSessions.customerId, account.id), isNull(customerSessions.revokedAt))) as SQLiteBatchItem,
            phoneChangedHistory(db, { accountId: account.id }) as SQLiteBatchItem,
        ]);
    } catch (error) {
        if (error instanceof ValidationError) {
            throw new ConflictError("This phone number is verified on another account. Sign in with it instead.", { field: "phone", reason: "phone_on_another_account" });
        }
        throw error;
    }
    // The change is committed: a notice that cannot be queued is logged, never the buyer's failure.
    const notices: OtpDelivery[] = [];
    for (const target of previousSignIns(account, channel === "sms" ? "sms" : null)) {
        try {
            notices.push(await queuePhoneChangedNotice(db, {
                target,
                accountId: account.id,
                maskedPhone: maskedNumber(phone),
                encryptionKey: input.encryptionKey,
                credentialEncryptionKey: input.credentialEncryptionKey,
            }));
        } catch (error) {
            console.warn("[CustomerAuth] Phone change notice not queued:", error instanceof Error ? error.name : typeof error);
        }
    }
    return { movedOrders: Number(joining?.count ?? 0), session, notices };
}

const CALLER_SESSION_ENDED = "CALLER_SESSION_ENDED";

type NoticeTarget = { method: "email" | "phone"; channel: "email" | "sms"; identifier: string };

/**
 * Every identity proven before a phone change: the proven email, and the old
 * proven phone by text message (a WhatsApp channel carries only code
 * templates: no notice there).
 */
function previousSignIns(account: CustomerRow, smsChannel: "sms" | null): NoticeTarget[] {
    const targets: NoticeTarget[] = [];
    if (account.emailVerifiedAt && account.email) targets.push({ method: "email", channel: "email", identifier: account.email.trim().toLowerCase() });
    const oldPhone = account.phoneVerifiedAt ? phoneOrNull(account.phone) : null;
    if (oldPhone && smsChannel) targets.push({ method: "phone", channel: smsChannel, identifier: oldPhone });
    return targets;
}

/**
 * The notice that the sign-in phone changed, to one identity proven before.
 * It rides the code delivery (receipts, retries) as purpose `phone_changed`,
 * whose message carries no code; its challenge is keyed to this notice
 * alone, so nothing can prove it.
 */
async function queuePhoneChangedNotice(
    db: Database,
    input: { target: NoticeTarget; accountId: string; maskedPhone: string; encryptionKey?: string; credentialEncryptionKey?: string },
): Promise<OtpDelivery> {
    const { target } = input;
    requireKey(input.credentialEncryptionKey, "Customer OTP delivery target encryption key is not configured.");
    const otpKey = await buildCustomerAuthOtpStorageKey(target.channel, boundIdentifier(target.identifier, `notice:phone-changed:${input.accountId}:${nanoid()}`), input.encryptionKey);
    const deliveryKey = createAuthOtpDeliveryKey();
    await persistCustomerAuthOtpChallenge(db, {
        otpKey,
        deliveryKey,
        method: target.method,
        channel: target.channel,
        identifier: target.identifier,
        deliveryTarget: target.identifier,
        code: await deriveCustomerAuthOtpDeliveryCode({ otpKey, deliveryKey, encryptionKey: input.encryptionKey }),
        encryptionKey: input.encryptionKey,
        contactEncryptionKey: input.credentialEncryptionKey,
        ttlSeconds: OTP_TTL_SECONDS,
        resendCooldownSeconds: 0,
        maxAttempts: 1,
    });
    return buildOtpDelivery({ channel: target.channel, purpose: "phone_changed", challengeKey: otpKey, deliveryKey, maskedPhone: input.maskedPhone });
}

function markProven(row: CustomerRow, method: "email" | "phone", at: Date): CustomerRow {
    return {
        ...row,
        emailVerifiedAt: method === "email" ? row.emailVerifiedAt ?? at : row.emailVerifiedAt,
        phoneVerifiedAt: method === "phone" ? row.phoneVerifiedAt ?? at : row.phoneVerifiedAt,
        lastAuthenticatedAt: at,
    };
}

type LatestContactOrder = Awaited<ReturnType<typeof latestOrderForProvenContact>>;

/** The latest order placed with a contact the buyer has just proven by code. */
async function latestOrderForProvenContact(db: Database, method: "email" | "phone", identifier: string) {
    return await db
        .select({
            orderNumber: orders.orderNumber,
            customerName: orders.customerName,
            customerPhone: orders.customerPhone,
            customerEmail: orders.customerEmail,
            shippingAddress: orders.shippingAddress,
            shippingAddressLine2: orders.shippingAddressLine2,
            shippingCountryCode: orders.shippingCountryCode,
            shippingDependentLocality: orders.shippingDependentLocality,
            shippingLocality: orders.shippingLocality,
            shippingAdminArea: orders.shippingAdminArea,
            shippingPostalCode: orders.shippingPostalCode,
            shippingCompany: orders.shippingCompany,
            shippingName: orders.shippingName,
            shippingPhone: orders.shippingPhone,
            shippingValidationSkipped: orders.shippingValidationSkipped,
            city: orders.city,
            zone: orders.zone,
            area: orders.area,
            cityName: orders.cityName,
            zoneName: orders.zoneName,
            areaName: orders.areaName,
        })
        .from(orders)
        .where(and(
            method === "email"
                ? sql`lower(trim(${orders.customerEmail})) = ${identifier}`
                : eq(orders.customerPhone, identifier),
            isNull(orders.deletedAt),
        ))
        .orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(1)
        .get() ?? null;
}

/**
 * The order's address in one line. Bangladesh: "House 9, Mirpur" + Mirpur,
 * Dhaka reads "House 9, Mirpur, Dhaka" (names already in the line are not
 * repeated); elsewhere the canonical one-line form.
 */
function suggestedAddressText(order: NonNullable<LatestContactOrder>, line1: string): string {
    if (!usesDeliveryHierarchy(order.shippingCountryCode)) {
        return formatAddressInline({
            countryCode: order.shippingCountryCode,
            line1,
            line2: order.shippingAddressLine2,
            dependentLocality: order.shippingDependentLocality,
            locality: order.shippingLocality,
            adminArea: order.shippingAdminArea,
            postalCode: order.shippingPostalCode,
        });
    }
    return [order.areaName, order.zoneName, order.cityName].reduce<string>((text, part) => {
        const value = part?.trim();
        return value && !text.toLowerCase().includes(value.toLowerCase()) ? `${text}, ${value}` : text;
    }, line1);
}

function suggestNewAccount(order: LatestContactOrder | null): NewAccountSuggestion | null {
    if (!order) return null;
    const address = order.shippingAddress?.trim();
    return {
        name: order.customerName?.trim() || null,
        phone: phoneOrNull(order.customerPhone),
        email: order.customerEmail?.trim() || null,
        address: address
            ? {
                orderNumber: order.orderNumber ?? null,
                text: suggestedAddressText(order, address),
            }
            : null,
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
    identity: CustomerIdentitySettings,
    phoneCountryPolicy: PhoneCountryPolicy,
    latestOrder: LatestContactOrder | null,
): Promise<{ row: CustomerRow; address: CustomerAddressRowValue | null; writes: SQLiteBatchItem[] } | null> {
    if (!input.account) return null;
    const name = input.account.name?.trim();
    if (!name) throw new ValidationError("Enter your name.");

    const email = input.method === "email"
        ? identifier
        : input.account.email?.trim() ? normalizeEmailOrThrow(input.account.email) : null;
    // Customer accounts decides whether a new account must give an email.
    if (!email && identity.email === "required") {
        throw new ValidationError("Enter your email address.");
    }
    const phone = input.method === "phone"
        ? identifier
        : input.account.phone?.trim() ? normalizePhoneOrThrow(input.account.phone, phoneCountryPolicy) : null;
    // An email sign-up may skip the phone only with the merchant's opt-in
    // (each order still asks for one when it needs it).
    if (!phone && newAccountPhoneNeed(identity, input.method) === "required") {
        throw new ValidationError("Enter your phone number.");
    }

    const now = new Date();
    const proof = {
        accountClaimedAt: now,
        lastAuthenticatedAt: now,
        emailVerifiedAt: input.method === "email" ? now : null,
        phoneVerifiedAt: input.method === "phone" ? now : null,
    };

    // A typed phone (email sign-up) is only this account's contact: it never
    // claims the phone's guest record or another account, and never blocks
    // anyone. Proving the phone by code is what links its orders.
    const values: CustomerInsertRow = {
        id: `cust_${nanoid()}`,
        name,
        email,
        phone: storedPhone(phone),
        origin: "account",
        ...proof,
        createdAt: now,
        updatedAt: now,
    };
    // Asked for by the buyer, and read here from the order, never from the request:
    // the order's address becomes the new address book's default.
    const orderLine = input.account.saveOrderAddress ? latestOrder?.shippingAddress?.trim() : null;
    const address: CustomerAddressRowValue | null = orderLine && latestOrder
        ? {
            id: firstCustomerAddressId(values.id),
            customerId: values.id,
            isDefault: true,
            isDefaultBilling: false,
            countryCode: latestOrder.shippingCountryCode ?? "BD",
            name: latestOrder.shippingName,
            company: latestOrder.shippingCompany,
            line1: orderLine,
            line2: latestOrder.shippingAddressLine2,
            dependentLocality: latestOrder.shippingDependentLocality,
            locality: latestOrder.shippingLocality,
            adminArea: latestOrder.shippingAdminArea,
            postalCode: latestOrder.shippingPostalCode,
            phoneE164: latestOrder.shippingPhone,
            phoneRaw: null,
            city: latestOrder.city,
            zone: latestOrder.zone,
            area: latestOrder.area,
            cityName: latestOrder.cityName,
            zoneName: latestOrder.zoneName,
            areaName: latestOrder.areaName,
            validationSkipped: Boolean(latestOrder.shippingValidationSkipped),
            createdAt: now,
            updatedAt: now,
        }
        : null;
    return {
        row: {
            totalOrders: 0,
            lastOrderAt: null,
            deletedAt: null,
            ...values,
        } as CustomerRow,
        address,
        writes: [
            insertCustomer(db, values),
            ...(address ? [db.insert(customerAddresses).values(address) as SQLiteBatchItem] : []),
        ],
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
    address: CustomerAddressRowValue | null,
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
    statements.push(...buildVerifiedContactOrderLink(db, {
        customerId: row.id,
        email: row.emailVerifiedAt ? row.email : null,
        phone: row.phoneVerifiedAt ? row.phone : null,
    }) as SQLiteBatchItem[]);

    try {
        await safeBatch(db, statements);
    } catch (error: unknown) {
        if (isBatchGuardError(error, CALLER_SESSION_ENDED)) throw new UnauthorizedError("Your session ended. Sign in again.");
        if (isSignInChangedError(error)) throw signInChangedConflict();
        const message = error instanceof Error ? error.message : String(error);
        // Only a proven identifier is unique: a concurrent sign-up proved it first.
        if (message.includes("customers_verified_") || message.includes("UNIQUE constraint failed: customers.")) {
            throw new ValidationError("This contact was just used to create an account. Sign in instead.");
        }
        console.warn("[CustomerAuth] Account/session persistence failed:", error instanceof Error ? error.name : typeof error);
        throw new ServiceUnavailableError("We couldn't sign you in. Please try again.");
    }

    return {
        token,
        ...buildCustomerAuthProfile(row, address),
        createdAt: nowMs,
        expiresAt: expiresAt * 1000,
    };
}

/** A session that signs its customer in: not revoked, not expired, its customer not deleted. */
function liveCustomerSession(tokenHash: string) {
    return and(
        eq(customerSessions.tokenHash, tokenHash),
        isNull(customerSessions.revokedAt),
        gt(customerSessions.expiresAt, Math.floor(Date.now() / 1000)),
        isNull(customers.deletedAt),
    );
}

/**
 * The customer a live session signs in (`getCustomerBySession`'s rule) by
 * its token hash; composable into a read batch, so a checkout reads the
 * session with its other rows instead of in a round trip of its own.
 */
export function selectSessionCustomer(db: Database, tokenHash: string) {
    return db
        // The account's tax exemption rides the session row (audit I9).
        .select({ customerId: customers.id, taxExempt: customers.taxExempt, taxExemptionId: customers.taxExemptionId })
        .from(customerSessions)
        .innerJoin(customers, eq(customerSessions.customerId, customers.id))
        .where(liveCustomerSession(tokenHash));
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

    const tokenHash = await hashCustomerSessionToken(sessionToken, sessionHashKey);
    const row = await db
        .select({ session: customerSessions, customer: customers, address: customerAddresses })
        .from(customerSessions)
        .innerJoin(customers, eq(customerSessions.customerId, customers.id))
        // The default address rides the session read (no extra statement).
        .leftJoin(customerAddresses, joinDefaultAddress)
        .where(liveCustomerSession(tokenHash))
        .get();

    if (!row) return null;
    return {
        token: sessionToken,
        ...buildCustomerAuthProfile(row.customer, row.address),
        createdAt: row.session.createdAt * 1000,
        expiresAt: row.session.expiresAt * 1000,
        taxExemption: row.customer.taxExempt ? { exemptionId: row.customer.taxExemptionId ?? null } : null,
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
 * Updates the signed-in buyer's name and WhatsApp number and returns a fresh
 * session projection from D1. A phone on an account can become how it signs
 * in, so a session alone never changes it: a different `phone` is a 409
 * `phone_change_needs_codes` naming the change flow (`sendAccountPhoneCode` /
 * `verifyAccountPhoneCode` with `phone`: a code to the identity the account
 * signs in with and one to the new number), or the store when the buyer
 * cannot reach that identity. The WhatsApp number is read as checkout reads
 * it, is a contact and never an identity, is kept only while the store
 * collects one apart from the phone (a stored one is dropped on the next save
 * once it does not), and is null when it is the phone. Addresses are the
 * address book's.
 */
export async function updateCustomerProfile(
    db: Database,
    session: CustomerSession,
    updates: { name?: string; phone?: string | null; whatsapp?: string | null },
): Promise<{ session: CustomerSession; customer: CustomerAuthProfile }> {
    if (!session.customerId) {
        throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
    }

    const existing = await getActiveCustomerById(db, session.customerId);
    if (!existing) {
        throw new UnauthorizedError("Customer profile is no longer available. Please log in again.");
    }

    const nextName = updates.name !== undefined
        ? normalizeOptionalProfileText(updates.name)
        : existing.name;
    if (!nextName) {
        throw new ValidationError("Enter your name.");
    }

    let whatsapp: string | null | undefined;
    const phone = phoneOrNull(existing.phone);
    if (updates.whatsapp !== undefined || existing.whatsapp || updates.phone !== undefined) {
        const { identity, phoneCountryPolicy } = await readSignInPolicy(db);
        if (updates.phone !== undefined) {
            const typed = updates.phone?.trim() ? contactNumberOrThrow(updates.phone, "phone", phoneCountryPolicy) : null;
            if (typed !== phone) {
                throw new ConflictError("Changing your phone takes a code to how you sign in now and one to the new number. If you can't get the first code, ask the store to change it for you.", {
                    field: "phone",
                    reason: PHONE_CHANGE_NEEDS_CODES_REASON,
                    allowed: ["phone_change_codes", "ask_store"],
                });
            }
        }
        const typedWhatsapp = updates.whatsapp !== undefined
            ? (updates.whatsapp?.trim() ? contactNumberOrThrow(updates.whatsapp, "whatsapp") : null)
            : undefined;
        if (identity.whatsapp !== "separate") {
            if (typedWhatsapp) {
                throw new ValidationError("This store doesn't ask for a separate WhatsApp number.", { field: "whatsapp", reason: "whatsapp_not_collected" });
            }
            whatsapp = null;
        } else {
            const kept = typedWhatsapp === undefined ? existing.whatsapp : typedWhatsapp;
            // Null means "the phone", as on an order.
            whatsapp = kept && kept !== phone ? kept : null;
        }
    }

    // Name and WhatsApp only: how the buyer signs in is never written here.
    await db
        .update(customers)
        .set({ name: nextName, whatsapp: whatsapp === undefined ? sql`${customers.whatsapp}` : whatsapp, updatedAt: sql`unixepoch()` })
        .where(and(eq(customers.id, session.customerId), isNull(customers.deletedAt)));

    return readCustomerProfile(db, session);
}

/** A typed number in E.164 as checkout reads it, or a refusal naming the field and why. */
function contactNumberOrThrow(value: string, field: "phone" | "whatsapp", policy?: PhoneCountryPolicy): string {
    const parsed = parseContactPhone(value, { allowedCountries: policy });
    if (parsed.ok) return parsed.value;
    throw new ValidationError(field === "whatsapp" ? "Enter a valid WhatsApp number." : parsed.message, { field, reason: parsed.reason });
}

/** The signed-in customer's fresh profile (one statement, the default address joined). */
export async function readCustomerProfile(
    db: Database,
    session: CustomerSession,
): Promise<{ session: CustomerSession; customer: CustomerAuthProfile }> {
    const row = session.customerId ? await getActiveCustomerProfileRow(db, session.customerId) : null;
    if (!row) {
        throw new UnauthorizedError("Customer profile is no longer available. Please log in again.");
    }
    const authProfile = buildCustomerAuthProfile(row.customer, row.address);
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
    // Stale = expired, or revoked longer ago than the retention. One OR across
    // those plans a SCAN of every session, so the set is split into three
    // disjoint ranges of customer_sessions_active_expiry_idx (revoked_at, expires_at).
    const expired = [
        // never revoked, expired
        and(isNull(customerSessions.revokedAt), lte(customerSessions.expiresAt, nowSeconds))!,
        // revoked before the retention cutoff (expired or not)
        lte(customerSessions.revokedAt, revokedCutoff),
        // revoked recently, but expired anyway
        and(gt(customerSessions.revokedAt, revokedCutoff), lte(customerSessions.expiresAt, nowSeconds))!,
    ];
    return sweepExpiredRows(db, customerSessions, customerSessions.tokenHash, expired, limit);
}
