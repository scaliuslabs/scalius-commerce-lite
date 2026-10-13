// Messages of Customers & marketing: the double opt-in confirmation e-mail
// (an outbox row, subject `customer`, sent by the API queue consumer), and
// what any marketing message to a customer must carry: consent for that
// channel now, an unsubscribe link, and RFC 2369/8058 list headers.

import type { Database } from "@scalius/database/client";
import { customerMarketingConsents, customers } from "@scalius/database/schema";
import { marketingConsentContact, type MarketingChannel } from "@scalius/shared/customer-marketing";
import { and, eq } from "drizzle-orm";
import { sendEmail, type EmailRuntimeContext } from "../../integrations/email";
import type { AppProviders } from "../../integrations/provider-port";
import {
  buildDispatchResult,
  dispatchWithReceipt,
  emailResultToDeliveryResult,
  maskEmail,
  MESSAGE_COPY,
  type OrderNotificationDispatchResult,
  readStoreIdentity,
  recordProviderBlockedDeliveryIfNeeded,
  recordSkippedDelivery,
  renderMessageEmail,
} from "../notifications";
import { MARKETING_OPT_IN_NOTIFICATION } from "./consent";
import {
    deriveOptInToken,
    hashOptInToken,
    marketingConfirmUrl,
    marketingUnsubscribeUrl,
    signUnsubscribeToken,
    type MarketingLinkEnv,
} from "./links";

export interface MarketingMessageRuntime {
    env: MarketingLinkEnv & EmailRuntimeContext["env"];
    encryptionKey?: string;
    /** The absolute storefront origin (Platform settings); links need it. */
    storefrontUrl: string | null | undefined;
    /** The app providers a saved email choice may name. */
    appProviders?: AppProviders;
}

/**
 * Sends one opt-in confirmation. Nothing is sent (a terminal skipped
 * receipt) when the request is no longer the pending one (confirmed,
 * replaced by a newer request, unsubscribed) or the store has no URL.
 */
export async function sendMarketingOptInEmail(
    db: Database,
    claim: { outboxId: string; customerId: string; data: Record<string, unknown> },
    runtime: MarketingMessageRuntime,
): Promise<OrderNotificationDispatchResult> {
    const base = {
        db,
        outboxId: claim.outboxId,
        notificationType: MARKETING_OPT_IN_NOTIFICATION,
        subjectType: "customer" as const,
        subjectId: claim.customerId,
    };
    const skip = async (reason: string) => buildDispatchResult([await recordSkippedDelivery({
        ...base,
        channel: "email",
        provider: "email",
        recipient: `${reason}:${claim.customerId}:${claim.outboxId}`,
        recipientMasked: reason,
        reason,
    })]);

    const nonce = typeof claim.data.nonce === "string" && /^[0-9a-f]{32}$/.test(claim.data.nonce) ? claim.data.nonce : null;
    if (!nonce) return skip("invalid_request");
    const row = await db.select({
        state: customerMarketingConsents.state,
        contact: customerMarketingConsents.contact,
        confirmationHash: customerMarketingConsents.confirmationHash,
    }).from(customerMarketingConsents)
        .where(and(eq(customerMarketingConsents.customerId, claim.customerId), eq(customerMarketingConsents.channel, "email")))
        .get();
    if (!row || row.state !== "pending" || !row.confirmationHash) return skip("nothing_to_send");
    const token = await deriveOptInToken(runtime.env, { customerId: claim.customerId, nonce });
    if (await hashOptInToken(token) !== row.confirmationHash) return skip("replaced_by_newer_request");
    const confirmUrl = marketingConfirmUrl(runtime.storefrontUrl, token);
    if (!confirmUrl) return skip("storefront_url_missing");

    const store = await readStoreIdentity(db);
    const copy = MESSAGE_COPY[store.language].marketing;
    const target = {
        ...base,
        channel: "email" as const,
        provider: "email",
        recipient: row.contact,
        recipientMasked: maskEmail(row.contact),
    };
    const blocked = await recordProviderBlockedDeliveryIfNeeded(target);
    if (blocked) return buildDispatchResult([blocked]);
    const context: EmailRuntimeContext = { db, env: runtime.env, encryptionKey: runtime.encryptionKey, appProviders: runtime.appProviders };
    return buildDispatchResult([await dispatchWithReceipt({
        ...target,
        // The link is a bearer of this request: never in a receipt or a log.
        redact: [token, confirmUrl],
        send: async (delivery) => {
            const rendered = renderMessageEmail({
                language: store.language,
                store,
                subject: copy.optInSubject(store.name),
                body: `${copy.optInBody(store.name)}\n\n${copy.optInIgnore}`,
                action: { label: copy.optInAction, href: confirmUrl },
            });
            return emailResultToDeliveryResult(await sendEmail({
                ...rendered,
                to: row.contact,
                fromName: store.name ?? undefined,
                idempotencyKey: delivery.receiptKey,
            }, context));
        },
    })]);
}

export interface MarketingSendPermission {
    /** The customer is subscribed on this channel for their current address. */
    allowed: boolean;
    /** Where the message goes (the subscribed address). */
    contact: string | null;
    unsubscribeUrl: string | null;
    /** `List-Unsubscribe` (+ one-click `List-Unsubscribe-Post`) for e-mail. */
    headers: Record<string, string>;
    /** Footer lines in the store's language. */
    footer: { text: string; unsubscribeLabel: string };
}

/**
 * Whether a marketing message may go to this customer on this channel now,
 * with the unsubscribe link and headers it must carry. Plugins and any later
 * campaign sender go through this; transactional messages do not.
 */
export async function marketingSendPermission(
    db: Database,
    input: { customerId: string; channel: MarketingChannel },
    runtime: Pick<MarketingMessageRuntime, "env" | "storefrontUrl">,
): Promise<MarketingSendPermission> {
    const row = await db.select({
        id: customers.id,
        accountClaimedAt: customers.accountClaimedAt,
        email: customers.email,
        phone: customers.phone,
        deletedAt: customers.deletedAt,
        state: customerMarketingConsents.state,
        consentContact: customerMarketingConsents.contact,
    }).from(customers)
        .leftJoin(customerMarketingConsents, and(
            eq(customerMarketingConsents.customerId, customers.id),
            eq(customerMarketingConsents.channel, input.channel),
        ))
        .where(eq(customers.id, input.customerId))
        .get();
    const store = await readStoreIdentity(db);
    const copy = MESSAGE_COPY[store.language].marketing;
    const footer = { text: copy.footer(store.name), unsubscribeLabel: copy.unsubscribe };
    const contact = row ? marketingConsentContact(input.channel, row) : null;
    const allowed = Boolean(row && !row.deletedAt && contact && row.state === "subscribed" && row.consentContact === contact);
    if (!allowed) return { allowed: false, contact: null, unsubscribeUrl: null, headers: {}, footer };
    const unsubscribeUrl = marketingUnsubscribeUrl(
        runtime.storefrontUrl,
        await signUnsubscribeToken(runtime.env, { customerId: input.customerId, channel: input.channel }),
    );
    // Without a store URL there is no way to unsubscribe: do not send.
    if (!unsubscribeUrl) return { allowed: false, contact: null, unsubscribeUrl: null, headers: {}, footer };
    return {
        allowed: true,
        contact,
        unsubscribeUrl,
        headers: input.channel === "email"
            ? { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
            : {},
        footer,
    };
}
