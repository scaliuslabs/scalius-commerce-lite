// The surfaces that change marketing consent: the storefront newsletter
// form, the buyer's account, staff (and plugins) in the dashboard, and the
// independent checkout choices (`checkoutConsentChanges`).

import type { Database } from "@scalius/database/client";
import { customerHistory, customers } from "@scalius/database/schema";
import {
    MARKETING_CHANNELS,
    accountMarketingConsentText,
    marketingConsentContact,
    marketingConsentLabel,
    marketingConsentTextVersion,
    newsletterSubscribeSchema,
    newsletterMarketingConsentText,
    type MarketingChannel,
    type MarketingConsentSettings,
} from "@scalius/shared/customer-marketing";
import { and, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { NotFoundError, ValidationError } from "@scalius/core/errors";
import {
  chooseOrderCustomer,
  enforceNewsletterSignupRateLimits,
  normalizeContactEmail,
  selectContactCustomerCandidates,
} from "../customers";
import type { NotificationSender } from "../notifications";
import { marketingConsentDocument, validateCustomerPhoneCountry } from "../settings";
import {
    applyConsentChanges,
    getCustomerMarketingConsents,
    type ConsentChange,
    type ConsentChangeResult,
    type ConsentText,
    type MarketingConsentView,
} from "./consent";
import type { MarketingLinkEnv } from "./links";

export interface ConsentRuntime {
    env: MarketingLinkEnv;
    send?: NotificationSender;
}

const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

export async function readMarketingConsentSettings(db: Database): Promise<MarketingConsentSettings> {
    return marketingConsentDocument.read(db);
}

function normalizeEmail(value: string | undefined): string | null {
    if (!value) return null;
    const email = normalizeContactEmail(value);
    if (!email || !EMAIL.test(email)) throw new ValidationError("Enter a valid email address.", { field: "email" });
    return email;
}

// ── Newsletter ───────────────────────────────────────────────────────────

/**
 * A newsletter signup: the phone (mandatory customer identity) and an
 * optional e-mail resolve to a customer record by the identity rules
 * (verified phone owner, verified e-mail owner, the phone's guest record,
 * else a new guest record). Only individually selected channels subscribe;
 * e-mail waits for its confirmation link when double opt-in is on.
 * The result depends only on the input and the settings, never on
 * whether the contact was known.
 */
export async function subscribeToNewsletter(
    db: Database,
    raw: unknown,
    runtime: ConsentRuntime & { ip: string; rateLimitKey?: string },
): Promise<{ result: "subscribed" | "pending" }> {
    const parsed = newsletterSubscribeSchema.safeParse(raw);
    if (!parsed.success) {
        const channelIssue = parsed.error.issues.some((issue) => issue.path[0] === "channels");
        throw new ValidationError(channelIssue ? "Choose at least one contact channel." : "Enter a valid phone number.", { field: channelIssue ? "channel" : "phone" });
    }
    const input = parsed.data;
    let phone: string;
    try {
        phone = await validateCustomerPhoneCountry(db, input.phone);
    } catch {
        throw new ValidationError("Enter a valid phone number.", { field: "phone" });
    }
    const email = normalizeEmail(input.email);
    await enforceNewsletterSignupRateLimits(db, {
        ip: runtime.ip,
        contacts: [phone, ...(email ? [email] : [])],
        hashKey: runtime.rateLimitKey,
    });
    const settings = await readMarketingConsentSettings(db);
    if (input.channels.includes("email") && !email) throw new ValidationError("Add your email address for email offers.", { field: "email" });
    const customerId = await resolveSubscriberCustomer(db, { phone, email });
    const consentTextValue = newsletterMarketingConsentText(input.language, input.channels);
    const consentText: ConsentText = { text: consentTextValue, version: await marketingConsentTextVersion("newsletter", consentTextValue) };
    const author = { source: "newsletter" as const, actor: "buyer" as const };
    const changes: ConsentChange[] = [
        ...(input.channels.includes("sms") ? [{ ...author, channel: "sms" as const, action: "subscribe" as const, contact: phone, consentText }] : []),
        ...(input.channels.includes("whatsapp") ? [{ ...author, channel: "whatsapp" as const, action: "subscribe" as const, contact: phone, consentText }] : []),
        ...(email && input.channels.includes("email") ? [{
            ...author,
            channel: "email" as const,
            action: "subscribe" as const,
            contact: email,
            consentText,
            doubleOptIn: settings.emailDoubleOptIn,
            allowBlankGuestEmail: true,
        }] : []),
    ];
    await applyConsentChanges(db, { customerId, changes, env: runtime.env, send: runtime.send });
    return { result: input.channels.includes("email") && email && settings.emailDoubleOptIn ? "pending" : "subscribed" };
}

/** The record a subscriber's contact files under, creating a guest record when there is none. */
async function resolveSubscriberCustomer(db: Database, contact: { phone: string; email: string | null }): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const candidates = await selectContactCustomerCandidates(db, contact);
        const chosen = chooseOrderCustomer(candidates, contact);
        if (chosen) return chosen.customerId;
        const id = `cust_${nanoid()}`;
        // One guest record per phone (customers_guest_phone_unique): a racing
        // signup or checkout that created it first wins and is re-resolved.
        const inserted = await db.insert(customers).values({
            id,
            name: "",
            phone: contact.phone,
            email: contact.email,
            origin: "order",
            totalOrders: 0,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }).onConflictDoNothing().returning({ id: customers.id });
        if (inserted.length > 0) {
            await db.insert(customerHistory).values({
                id: `hist_${nanoid()}`,
                customerId: id,
                name: "",
                email: contact.email,
                phone: contact.phone,
                changeType: "created",
                actor: "buyer",
                createdAt: sql`unixepoch()`,
            });
            return id;
        }
    }
    throw new ValidationError("We could not save your signup. Try again.");
}

// ── The buyer's account ───────────────────────────────────────────────────

export interface AccountMarketingChannel {
    channel: MarketingChannel;
    status: MarketingConsentView["status"];
    /** The account has an address for this channel. */
    available: boolean;
}

export async function getAccountMarketingPreferences(db: Database, customerId: string): Promise<{ channels: AccountMarketingChannel[] }> {
    const views = await getCustomerMarketingConsents(db, customerId);
    return { channels: views.map((view) => ({ channel: view.channel, status: view.status, available: view.contact !== null })) };
}

/**
 * The signed-in buyer turns channels on or off. A verified e-mail subscribes
 * straight away; an unverified one waits for its confirmation link when
 * double opt-in is on.
 */
export async function updateAccountMarketingPreferences(
    db: Database,
    customerId: string,
    input: Partial<Record<MarketingChannel, boolean>> & { language?: string | null },
    runtime: ConsentRuntime,
): Promise<{ channels: AccountMarketingChannel[]; confirmationRequested: boolean }> {
    const customer = await db.select({
        id: customers.id,
        accountClaimedAt: customers.accountClaimedAt,
        email: customers.email,
        phone: customers.phone,
        emailVerifiedAt: customers.emailVerifiedAt,
    }).from(customers).where(and(eq(customers.id, customerId), isNull(customers.deletedAt), sql`${customers.accountClaimedAt} IS NOT NULL`)).get();
    if (!customer) throw new NotFoundError("Account not found");
    const settings = await readMarketingConsentSettings(db);
    const changes: ConsentChange[] = [];
    for (const channel of MARKETING_CHANNELS) {
        const wanted = input[channel];
        if (wanted === undefined) continue;
        const contact = marketingConsentContact(channel, customer);
        if (wanted && !contact) throw new ValidationError(channel === "push" ? "A customer account is required for marketing push." : channel === "email" ? "Add an email address first." : "Add a phone number first.", { field: channel });
        const text = accountMarketingConsentText(input.language, channel);
        const consentText: ConsentText | null = wanted
            ? { text, version: await marketingConsentTextVersion("account", text) }
            : null;
        changes.push(wanted
            ? {
                channel,
                action: "subscribe",
                source: "account",
                actor: "buyer",
                contact,
                consentText,
                doubleOptIn: channel === "email" && settings.emailDoubleOptIn && !customer.emailVerifiedAt,
            }
            : { channel, action: "unsubscribe", source: "account", actor: "buyer" });
    }
    const results = await applyConsentChanges(db, { customerId, changes, env: runtime.env, send: runtime.send });
    return {
        ...(await getAccountMarketingPreferences(db, customerId)),
        confirmationRequested: results.some((result) => result.confirmationRequested),
    };
}

// ── Staff and plugins ─────────────────────────────────────────────────────

/**
 * Staff (or a plugin through the same operation) record consent the
 * customer gave outside the store, or an opt-out. A subscribe needs a note
 * saying how the customer agreed; it is kept on the audit log.
 */
export async function setCustomerMarketingConsent(
    db: Database,
    customerId: string,
    input: { channel: MarketingChannel; state: "subscribed" | "unsubscribed"; note?: string | null },
    author: { actor: "staff" | "plugin"; actorId: string | null },
    runtime: ConsentRuntime,
): Promise<{ consents: MarketingConsentView[]; result: ConsentChangeResult }> {
    const customer = await db.select({ id: customers.id, accountClaimedAt: customers.accountClaimedAt, email: customers.email, phone: customers.phone })
        .from(customers).where(and(eq(customers.id, customerId), isNull(customers.deletedAt))).get();
    if (!customer) throw new NotFoundError("Customer not found");
    const contact = marketingConsentContact(input.channel, customer);
    if (input.state === "subscribed" && !contact) throw new ValidationError(input.channel === "push" ? "Marketing push requires a customer account." : input.channel === "email" ? "This customer has no email address." : "This customer has no phone number.", { field: "channel" });
    const note = input.note?.trim() || null;
    if (input.state === "subscribed" && author.actor === "staff" && !note) {
        throw new ValidationError("Add a note saying how the customer agreed.", { field: "note" });
    }
    const source = author.actor === "plugin" ? "plugin" as const : "admin" as const;
    const change: ConsentChange = input.state === "subscribed"
        ? { channel: input.channel, action: "subscribe", contact, source, actor: author.actor, actorId: author.actorId, note }
        : { channel: input.channel, action: "unsubscribe", source, actor: author.actor, actorId: author.actorId, note };
    const [result] = await applyConsentChanges(db, { customerId, changes: [change], env: runtime.env, send: runtime.send });
    return { consents: await getCustomerMarketingConsents(db, customerId), result: result! };
}

// ── Checkout ──────────────────────────────────────────────────────────────

/**
 * The checkout checkbox, recorded after the order commit (never inside it:
 * consent must not be able to fail an order). Idempotent, best effort: an
 * error is logged without contact details and the order stands.
 */
export async function recordCheckoutMarketingConsent(
    db: Database,
    input: {
        /** The customer the order was filed under. */
        customerId: string;
        /** The signed-in account, when the buyer was signed in. */
        signedInCustomerId: string | null;
        order: { phone: string | null; email: string | null; whatsapp: string | null };
        language: string | null | undefined;
        channels: readonly MarketingChannel[];
    },
    runtime: ConsentRuntime,
): Promise<ConsentChangeResult[]> {
    try {
        const settings = await readMarketingConsentSettings(db);
        const account = input.signedInCustomerId
            ? await db.select({ email: customers.email }).from(customers)
                .where(and(eq(customers.id, input.signedInCustomerId), sql`${customers.emailVerifiedAt} IS NOT NULL`)).get()
            : null;
        const changes = await checkoutConsentChanges({
            settings,
            language: input.language,
            channels: input.channels,
            order: input.order,
            signedInVerifiedEmail: account?.email ?? null,
        });
        if (changes.length === 0) return [];
        return await applyConsentChanges(db, { customerId: input.customerId, changes, env: runtime.env, send: runtime.send });
    } catch (error) {
        console.warn(`[Marketing] Checkout consent not recorded: ${error instanceof Error ? error.name : "error"}`);
        return [];
    }
}

/**
 * The changes the checkout checkbox makes for the order's customer: each
 * configured channel the order has a contact for, only for the address the
 * customer record already has (the order's contact never re-addresses a
 * record). E-mail waits for its confirmation link with double opt-in,
 * unless a signed-in account's verified e-mail is the order's.
 */
export async function checkoutConsentChanges(input: {
    settings: MarketingConsentSettings;
    language: string | null | undefined;
    order: { phone: string | null; email: string | null; whatsapp: string | null };
    signedInVerifiedEmail: string | null;
    channels?: readonly MarketingChannel[];
}): Promise<ConsentChange[]> {
    if (!input.settings.checkout.enabled) return [];
    const label = marketingConsentLabel(input.settings, input.language);

    const email = normalizeContactEmail(input.order.email);
    const changes: ConsentChange[] = [];
    for (const channel of input.settings.checkout.channels) {
        if (!input.channels?.includes(channel)) continue;
        const contact = channel === "email" ? email : channel === "whatsapp" ? (input.order.whatsapp ?? input.order.phone) : input.order.phone;
        if (!contact) continue;
        changes.push({
            channel,
            action: "subscribe",
            source: "checkout",
            actor: "buyer",
            contact,
            consentText: { text: `${label} [${channel}]`, version: await marketingConsentTextVersion("checkout", `${label} [${channel}]`) },
            doubleOptIn: channel === "email" && input.settings.emailDoubleOptIn
                && normalizeContactEmail(input.signedInVerifiedEmail) !== contact,
        });
    }
    return changes;
}
