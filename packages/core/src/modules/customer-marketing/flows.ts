// The surfaces that change marketing consent: the storefront newsletter
// form, the buyer's account, staff (and plugins) in the dashboard, and the
// checkout checkbox (`checkoutConsentChanges`, written inside the commit).

import type { Database } from "@scalius/database/client";
import { customerHistory, customers } from "@scalius/database/schema";
import {
    MARKETING_CHANNELS,
    marketingConsentContact,
    marketingConsentLabel,
    marketingConsentTextVersion,
    newsletterSubscribeSchema,
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
import type { NotificationQueue } from "../notifications";
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
    queue?: NotificationQueue;
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

/** The storefront's default consent line when the form sends none. */
export function newsletterConsentText(language: string | null | undefined, channels: { email: boolean; whatsapp: boolean }): string {
    const bn = language?.toLowerCase().startsWith("bn");
    if (bn) {
        const via = ["এসএমএস", channels.email ? "ইমেইল" : null, channels.whatsapp ? "হোয়াটসঅ্যাপ" : null].filter(Boolean).join(", ");
        return `${via}-এ নতুন খবর ও অফার পেতে সাবস্ক্রাইব করছি। যেকোনো সময় আনসাবস্ক্রাইব করা যাবে।`;
    }
    const via = ["SMS", channels.email ? "email" : null, channels.whatsapp ? "WhatsApp" : null].filter(Boolean).join(", ");
    return `Subscribe to news and offers by ${via}. Unsubscribe anytime.`;
}

/**
 * A newsletter signup: the phone (mandatory customer identity) and an
 * optional e-mail resolve to a customer record by the identity rules
 * (verified phone owner, verified e-mail owner, the phone's guest record,
 * else a new guest record). The phone subscribes to SMS (and WhatsApp when
 * asked); the e-mail waits for its confirmation link when double opt-in is
 * on. The result depends only on the input and the settings, never on
 * whether the contact was known.
 */
export async function subscribeToNewsletter(
    db: Database,
    raw: unknown,
    runtime: ConsentRuntime & { ip: string; rateLimitKey?: string },
): Promise<{ result: "subscribed" | "pending" }> {
    const parsed = newsletterSubscribeSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError("Enter a valid phone number.", { field: "phone" });
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
    const customerId = await resolveSubscriberCustomer(db, { phone, email });

    const consentTextValue = input.consentText ?? newsletterConsentText(input.language, { email: email !== null, whatsapp: input.whatsapp === true });
    const consentText: ConsentText = { text: consentTextValue, version: await marketingConsentTextVersion("newsletter", consentTextValue) };
    const author = { source: "newsletter" as const, actor: "buyer" as const };
    const changes: ConsentChange[] = [
        { ...author, channel: "sms", action: "subscribe", contact: phone, consentText },
        ...(input.whatsapp ? [{ ...author, channel: "whatsapp" as const, action: "subscribe" as const, contact: phone, consentText }] : []),
        ...(email ? [{
            ...author,
            channel: "email" as const,
            action: "subscribe" as const,
            contact: email,
            consentText,
            doubleOptIn: settings.emailDoubleOptIn,
            allowBlankGuestEmail: true,
        }] : []),
    ];
    await applyConsentChanges(db, { customerId, changes, env: runtime.env, queue: runtime.queue });
    return { result: email && settings.emailDoubleOptIn ? "pending" : "subscribed" };
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
        email: customers.email,
        phone: customers.phone,
        emailVerifiedAt: customers.emailVerifiedAt,
    }).from(customers).where(and(eq(customers.id, customerId), isNull(customers.deletedAt), sql`${customers.accountClaimedAt} IS NOT NULL`)).get();
    if (!customer) throw new NotFoundError("Account not found");
    const settings = await readMarketingConsentSettings(db);
    const label = marketingConsentLabel(settings, input.language);
    const consentText: ConsentText = { text: label, version: await marketingConsentTextVersion("account", label) };
    const changes: ConsentChange[] = [];
    for (const channel of MARKETING_CHANNELS) {
        const wanted = input[channel];
        if (wanted === undefined) continue;
        const contact = marketingConsentContact(channel, customer);
        if (wanted && !contact) throw new ValidationError(channel === "email" ? "Add an email address first." : "Add a phone number first.", { field: channel });
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
    const results = await applyConsentChanges(db, { customerId, changes, env: runtime.env, queue: runtime.queue });
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
    const customer = await db.select({ email: customers.email, phone: customers.phone })
        .from(customers).where(and(eq(customers.id, customerId), isNull(customers.deletedAt))).get();
    if (!customer) throw new NotFoundError("Customer not found");
    const contact = marketingConsentContact(input.channel, customer);
    if (!contact) throw new ValidationError(input.channel === "email" ? "This customer has no email address." : "This customer has no phone number.", { field: "channel" });
    const note = input.note?.trim() || null;
    if (input.state === "subscribed" && author.actor === "staff" && !note) {
        throw new ValidationError("Add a note saying how the customer agreed.", { field: "note" });
    }
    const source = author.actor === "plugin" ? "plugin" as const : "admin" as const;
    const change: ConsentChange = input.state === "subscribed"
        ? { channel: input.channel, action: "subscribe", contact, source, actor: author.actor, actorId: author.actorId, note }
        : { channel: input.channel, action: "unsubscribe", source, actor: author.actor, actorId: author.actorId, note };
    const [result] = await applyConsentChanges(db, { customerId, changes: [change], env: runtime.env, queue: runtime.queue });
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
            order: input.order,
            signedInVerifiedEmail: account?.email ?? null,
        });
        if (changes.length === 0) return [];
        return await applyConsentChanges(db, { customerId: input.customerId, changes, env: runtime.env, queue: runtime.queue });
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
}): Promise<ConsentChange[]> {
    if (!input.settings.checkout.enabled) return [];
    const label = marketingConsentLabel(input.settings, input.language);
    const consentText: ConsentText = { text: label, version: await marketingConsentTextVersion("checkout", label) };
    const email = normalizeContactEmail(input.order.email);
    const changes: ConsentChange[] = [];
    for (const channel of input.settings.checkout.channels) {
        const contact = channel === "email" ? email : channel === "whatsapp" ? (input.order.whatsapp ?? input.order.phone) : input.order.phone;
        if (!contact) continue;
        changes.push({
            channel,
            action: "subscribe",
            source: "checkout",
            actor: "buyer",
            contact,
            consentText,
            doubleOptIn: channel === "email" && input.settings.emailDoubleOptIn
                && normalizeContactEmail(input.signedInVerifiedEmail) !== contact,
        });
    }
    return changes;
}
