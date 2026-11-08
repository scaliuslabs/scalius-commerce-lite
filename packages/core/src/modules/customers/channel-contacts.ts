// The customer behind a chat-channel contact (COMMERCE-HOOKS H18): when a
// buyer first writes on WhatsApp, Messenger, … through a messaging app, the
// inbox files the thread under a customer. On a phone channel (WhatsApp,
// Viber) that is the store's customer with the phone, an account first;
// otherwise a new record named by the contact, created by the app. Nothing
// is verified or merged: a channel's sender id proves no identity.

import { customerHistory, customers } from "@scalius/database/schema";
import { NO_PHONE } from "@scalius/shared/customer-auth-policy";
import { and, desc, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import { validateCustomerPhoneCountry } from "../settings";

/** The channels whose contact address is the buyer's phone (E.164). */
const PHONE_CHANNELS: ReadonlySet<string> = new Set(["whatsapp", "viber"]);

const CHANNEL_NAMES: Record<string, string> = {
    whatsapp: "WhatsApp",
    messenger: "Messenger",
    instagram: "Instagram",
    telegram: "Telegram",
    viber: "Viber",
};

async function activeCustomerWithPhone(db: Database, phone: string): Promise<string | null> {
    const row = await db.select({ id: customers.id }).from(customers)
        .where(and(eq(customers.phone, phone), isNull(customers.deletedAt)))
        .orderBy(desc(customers.accountClaimedAt))
        .get();
    return row?.id ?? null;
}

/**
 * The customer a new channel thread belongs to. `appId` is the messaging app
 * that delivered the first message: a record it creates names it in the
 * customer's history.
 */
export async function resolveChannelContactCustomer(
    db: Database,
    contact: { channel: string; address: string; name: string | null },
    appId: string,
): Promise<string> {
    let phone: string | null = null;
    if (PHONE_CHANNELS.has(contact.channel)) {
        // A phone outside the store's accepted countries is kept on the thread only.
        phone = await validateCustomerPhoneCountry(db, contact.address).catch(() => null);
        const existing = phone ? await activeCustomerWithPhone(db, phone) : null;
        if (existing) return existing;
    }
    const name = (contact.name?.trim() || phone || `${CHANNEL_NAMES[contact.channel] ?? "Chat"} contact`).slice(0, 200);
    const id = `cust_${nanoid()}`;
    try {
        await db.batch([
            db.insert(customers).values({ id, name, email: null, phone: phone ?? NO_PHONE, origin: "merchant", totalOrders: 0 }),
            db.insert(customerHistory).values({
                id: `hist_${nanoid()}`,
                customerId: id,
                name,
                email: null,
                phone: phone ?? NO_PHONE,
                changeType: "created",
                actor: "app",
                actorId: `app:${appId}`,
            }),
        ]);
    } catch (error) {
        // Another delivery created the phone's guest record first: use it.
        const raced = phone ? await activeCustomerWithPhone(db, phone) : null;
        if (raced) return raced;
        throw error;
    }
    return id;
}
