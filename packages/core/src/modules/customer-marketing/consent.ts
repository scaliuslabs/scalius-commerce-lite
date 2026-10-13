// Marketing consent (Customers & marketing): one row per customer and
// channel, changed only through the conditional statements below.
//
// The state machine, per channel:
//   (none) | unsubscribed | pending ──subscribe──▶ subscribed
//   (none) | unsubscribed | subscribed(other address) ──request──▶ pending (e-mail double opt-in)
//   pending ──confirm link (7 days, single use)──▶ subscribed
//   anything ──unsubscribe──▶ unsubscribed
// A subscribe never moves `subscribed` (same address) back to `pending`, and a
// repeat request inside 10 minutes keeps the earlier link (no mail flood).
// Buyer surfaces only ever subscribe; nothing a buyer types can unsubscribe
// someone else (unsubscribing needs a signed link, the account or staff).
//
// A consent covers one address. A buyer may subscribe a channel only for the
// address the customer record already has (or, on a guest record with no
// e-mail, the e-mail they give, which the record takes when it is confirmed),
// so typing someone's phone never re-addresses their record. Each write is one
// INSERT … SELECT … ON CONFLICT DO UPDATE … WHERE: race-free, and a no-op
// when nothing changes. The 0108 triggers write the audit row and the
// `customer.consent_changed` event in the same transaction.

import type { Database } from "@scalius/database/client";
import { NO_PHONE } from "@scalius/shared/customer-auth-policy";
import { safeBatch } from "@scalius/database/client";
import {
    customerHistory,
    customerMarketingConsentEvents,
    customerMarketingConsents,
    notificationOutbox,
    customers,
} from "@scalius/database/schema";
import {
    MARKETING_CHANNELS,
    MARKETING_CONSENT_NOTE_MAX,
    MARKETING_CONSENT_TEXT_MAX,
    MARKETING_OPT_IN_RESEND_SECONDS,
    MARKETING_OPT_IN_TTL_SECONDS,
    marketingConsentContact,
    marketingConsentStatus,
    maskMarketingContact,
    type MarketingChannel,
    type MarketingConsentActor,
    type MarketingConsentSource,
    type MarketingConsentState,
    type MarketingConsentStatus,
} from "@scalius/shared/customer-marketing";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { NotFoundError, ValidationError } from "@scalius/core/errors";
import {
  createNotificationOutboxInsertValues,
  type NotificationSender,
} from "../notifications";
import { deriveOptInToken, hashOptInToken, newOptInNonce, type MarketingLinkEnv } from "./links";

export const MARKETING_OPT_IN_NOTIFICATION = "marketing_opt_in" as const;

export interface ConsentAuthor {
    source: MarketingConsentSource;
    actor: MarketingConsentActor;
    /** Staff user id or plugin id. */
    actorId?: string | null;
    /** Staff audit note (required for a staff subscribe). */
    note?: string | null;
}

export interface ConsentText {
    /** Exact wording the buyer agreed to. */
    text: string;
    /** `<surface>:<hash>` (`marketingConsentTextVersion`). */
    version: string;
}

export type ConsentChange =
    | (ConsentAuthor & {
        channel: MarketingChannel;
        action: "subscribe";
        /** The address the buyer gave (normalised); defaults to the record's. */
        contact?: string | null;
        consentText?: ConsentText | null;
        /** E-mail only: wait for the confirmation link. */
        doubleOptIn?: boolean;
        /** A guest record without e-mail takes this e-mail (now, or on confirmation). */
        allowBlankGuestEmail?: boolean;
    })
    | (ConsentAuthor & { channel: MarketingChannel; action: "unsubscribe" });

export interface ConsentChangeResult {
    channel: MarketingChannel;
    /** The row changed (an audit row and an event were written). */
    changed: boolean;
    /** A confirmation e-mail was queued (pending). */
    confirmationRequested: boolean;
}

const consents = customerMarketingConsents;
const nowSeconds = () => Math.floor(Date.now() / 1000);

function cleanNote(note: string | null | undefined): string | null {
    const value = note?.trim();
    if (!value) return null;
    if (value.length > MARKETING_CONSENT_NOTE_MAX) throw new ValidationError(`A note is at most ${MARKETING_CONSENT_NOTE_MAX} characters.`);
    return value;
}

function cleanText(text: ConsentText | null | undefined): { text: string | null; version: string | null } {
    if (!text) return { text: null, version: null };
    const value = text.text.trim().slice(0, MARKETING_CONSENT_TEXT_MAX);
    return { text: value || null, version: text.version };
}

/** The customer's current address for a channel, as stored on consent rows. */
export function currentContactSql(channel: MarketingChannel): SQL {
    if (channel === "push") return sql`CASE WHEN ${customers.accountClaimedAt} IS NOT NULL THEN ${customers.id} END`;
    return channel === "email" ? sql`nullif(lower(trim(${customers.email})), '')` : sql`nullif(${customers.phone}, ${NO_PHONE})`;
}

function contactCondition(channel: MarketingChannel, contact: SQL | string, allowBlankGuestEmail: boolean): SQL {
    const matches = sql`${currentContactSql(channel)} = ${contact}`;
    if (channel !== "email" || !allowBlankGuestEmail) return matches;
    return sql`(${matches} OR (${customers.email} IS NULL AND ${customers.accountClaimedAt} IS NULL))`;
}

const text = (value: string | null) => sql<string | null>`${value}`;
const int = (value: number | null) => sql<number | null>`${value}`;
const excluded = (column: string) => sql.raw(`excluded.${column}`);

/** One consent row from the customer row (columns in table order: an INSERT … SELECT lists them all). */
function consentRowSelect(db: Database, row: {
    channel: MarketingChannel;
    state: MarketingConsentState;
    contact: SQL | string;
    author: ConsentAuthor;
    note: string | null;
    version: string | null;
    text: string | null;
    subscribedAt: number | null;
    unsubscribedAt: number | null;
    requestedAt: number | null;
    confirmationHash: string | null;
    at: number;
}, where: SQL | undefined) {
    return db.select({
        customerId: customers.id,
        channel: text(row.channel).as("channel"),
        state: text(row.state).as("state"),
        contact: (typeof row.contact === "string" ? text(row.contact) : sql<string>`${row.contact}`).as("contact"),
        source: text(row.author.source).as("source"),
        actor: text(row.author.actor).as("actor"),
        actorId: text(row.author.actorId ?? null).as("actor_id"),
        note: text(row.note).as("note"),
        consentTextVersion: text(row.version).as("consent_text_version"),
        consentText: text(row.text).as("consent_text"),
        subscribedAt: int(row.subscribedAt).as("subscribed_at"),
        unsubscribedAt: int(row.unsubscribedAt).as("unsubscribed_at"),
        requestedAt: int(row.requestedAt).as("requested_at"),
        confirmationHash: text(row.confirmationHash).as("confirmation_hash"),
        createdAt: int(row.at).as("created_at"),
        updatedAt: int(row.at).as("updated_at"),
    }).from(customers).where(where);
}

const authorFromExcluded = {
    source: excluded("source"),
    actor: excluded("actor"),
    actorId: excluded("actor_id"),
    note: excluded("note"),
    updatedAt: excluded("updated_at"),
};

function subscribeStatement(db: Database, customerId: string, change: Extract<ConsentChange, { action: "subscribe" }>, at: number, confirmationHash: string | null) {
    const contact = change.contact ?? null;
    const { text: consentText, version } = cleanText(change.consentText);
    const where = and(
        eq(customers.id, customerId),
        sql`${customers.deletedAt} IS NULL`,
        contact ? contactCondition(change.channel, contact, change.allowBlankGuestEmail === true) : sql`${currentContactSql(change.channel)} IS NOT NULL`,
    );
    const pending = confirmationHash !== null;
    const select = consentRowSelect(db, {
        channel: change.channel,
        state: pending ? "pending" : "subscribed",
        contact: contact ?? currentContactSql(change.channel),
        author: change,
        note: cleanNote(change.note),
        version,
        text: consentText,
        subscribedAt: pending ? null : at,
        unsubscribedAt: null,
        requestedAt: pending ? at : null,
        confirmationHash,
        at,
    }, where);
    const shared = {
        ...authorFromExcluded,
        contact: excluded("contact"),
        consentTextVersion: excluded("consent_text_version"),
        consentText: excluded("consent_text"),
        requestedAt: excluded("requested_at"),
        confirmationHash: excluded("confirmation_hash"),
    };
    return db.insert(consents).select(select).onConflictDoUpdate({
        target: [consents.customerId, consents.channel],
        set: pending
            ? { ...shared, state: "pending" }
            : { ...shared, state: "subscribed", subscribedAt: excluded("subscribed_at") },
        setWhere: pending
            // Never back to pending from a subscription of this address; a
            // repeat request inside the resend window keeps the earlier link.
            ? sql`NOT (${consents.state} = 'subscribed' AND ${consents.contact} = excluded.contact)
                AND NOT (${consents.state} = 'pending' AND ${consents.contact} = excluded.contact AND ${consents.requestedAt} > ${at - MARKETING_OPT_IN_RESEND_SECONDS})`
            : sql`${consents.state} <> 'subscribed' OR ${consents.contact} <> excluded.contact`,
    }).returning({ state: consents.state });
}

function unsubscribeStatement(db: Database, customerId: string, change: Extract<ConsentChange, { action: "unsubscribe" }>, at: number) {
    // Revocation covers the stored consent even after its address was removed or changed.
    const current = sql`coalesce((SELECT previous_consent.contact FROM customer_marketing_consents AS previous_consent
        WHERE previous_consent.customer_id = ${customers.id} AND previous_consent.channel = ${change.channel}), ${currentContactSql(change.channel)})`;
    const select = consentRowSelect(db, {
        channel: change.channel,
        state: "unsubscribed",
        contact: current,
        author: change,
        note: cleanNote(change.note),
        version: null,
        text: null,
        subscribedAt: null,
        unsubscribedAt: at,
        requestedAt: null,
        confirmationHash: null,
        at,
    }, and(eq(customers.id, customerId), sql`${current} IS NOT NULL`));
    return db.insert(consents).select(select).onConflictDoUpdate({
        target: [consents.customerId, consents.channel],
        set: {
            ...authorFromExcluded,
            state: "unsubscribed",
            consentTextVersion: null,
            consentText: null,
            unsubscribedAt: excluded("unsubscribed_at"),
            requestedAt: null,
            confirmationHash: null,
        },
        setWhere: sql`${consents.state} <> 'unsubscribed'`,
    }).returning({ state: consents.state });
}

/**
 * A guest record without an e-mail takes `email` (newsletter, or a confirmed
 * opt-in), with its change-log row. `guard` must hold for either to happen.
 */
function blankGuestEmailStatements(db: Database, customerId: string, email: string, guard?: SQL) {
    const blank = and(
        eq(customers.id, customerId),
        sql`${customers.email} IS NULL`,
        sql`${customers.accountClaimedAt} IS NULL`,
        sql`${customers.deletedAt} IS NULL`,
        guard,
    );
    return [
        db.insert(customerHistory).select(db.select({
            id: text(`hist_${nanoid()}`).as("id"),
            customerId: customers.id,
            name: customers.name,
            email: text(email).as("email"),
            phone: customers.phone,
            changeType: sql<string>`'updated'`.as("change_type"),
            orderId: text(null).as("order_id"),
            relatedCustomerId: text(null).as("related_customer_id"),
            verifiedContact: text(null).as("verified_contact"),
            actor: sql<string>`'buyer'`.as("actor"),
            actorId: text(null).as("actor_id"),
            createdAt: sql<number>`unixepoch()`.as("created_at"),
        }).from(customers).where(blank)),
        db.update(customers).set({ email, updatedAt: sql`unixepoch()` }).where(blank),
    ];
}

/** The opt-in outbox row, written only when the pending row carries this request's hash. */
function optInOutboxStatement(db: Database, customerId: string, nonce: string, confirmationHash: string, source: string) {
    const values = createNotificationOutboxInsertValues({
        subjectType: "customer",
        subjectId: customerId,
        audience: "customer",
        notificationType: MARKETING_OPT_IN_NOTIFICATION,
        dedupeKey: `marketing_opt_in:${customerId}:${nonce}`,
        source,
        data: { nonce },
    });
    const select = db.select({
        id: text(String(values.id)).as("id"),
        dedupeKey: text(values.dedupeKey).as("dedupe_key"),
        subjectType: text("customer").as("subject_type"),
        subjectId: text(customerId).as("subject_id"),
        orderId: text(null).as("order_id"),
        conversationId: text(null).as("conversation_id"),
        audience: text("customer").as("audience"),
        notificationType: text(MARKETING_OPT_IN_NOTIFICATION).as("notification_type"),
        source: text(source).as("source"),
        payload: text(values.payload).as("payload"),
        status: text("pending").as("status"),
        attempts: int(0).as("attempts"),
        nextAttemptAt: int(Number(values.nextAttemptAt)).as("next_attempt_at"),
        claimId: text(null).as("claim_id"),
        claimExpiresAt: int(null).as("claim_expires_at"),
        lastError: text(null).as("last_error"),
        queuedAt: int(null).as("queued_at"),
        sentAt: int(null).as("sent_at"),
        createdAt: int(Number(values.createdAt)).as("created_at"),
        updatedAt: int(Number(values.updatedAt)).as("updated_at"),
    }).from(consents).where(and(
        eq(consents.customerId, customerId),
        eq(consents.channel, "email"),
        eq(consents.confirmationHash, confirmationHash),
    ));
    return {
        outboxId: String(values.id),
        statement: db.insert(notificationOutbox).select(select).onConflictDoNothing({ target: notificationOutbox.dedupeKey }),
    };
}

export interface PreparedConsentChanges {
    statements: unknown[];
    /** Outbox rows to send after commit (written only if their request was). */
    outboxIds: string[];
    /** Read each change's result from the batch results (index into the batch). */
    resultIndexes: Array<{ channel: MarketingChannel; index: number; pending: boolean }>;
}

/**
 * The statements for these changes, for the caller's batch (checkout puts
 * them in its commit batch after the customer row exists). `env` derives
 * confirmation tokens; without SCALIUS_SECRET a double opt-in fails closed.
 */
export async function prepareConsentChanges(
    db: Database,
    input: { customerId: string; changes: readonly ConsentChange[]; env: MarketingLinkEnv; at?: number; offset?: number },
): Promise<PreparedConsentChanges> {
    const at = input.at ?? nowSeconds();
    const offset = input.offset ?? 0;
    const statements: unknown[] = [];
    const outboxIds: string[] = [];
    const resultIndexes: PreparedConsentChanges["resultIndexes"] = [];
    const seen = new Set<MarketingChannel>();
    for (const change of input.changes) {
        if (seen.has(change.channel)) throw new ValidationError("Change each channel once.");
        seen.add(change.channel);
        if (change.action === "unsubscribe") {
            resultIndexes.push({ channel: change.channel, index: offset + statements.length, pending: false });
            statements.push(unsubscribeStatement(db, input.customerId, change, at));
            continue;
        }
        const pending = change.channel === "email" && change.doubleOptIn === true;
        if (!pending && change.channel === "email" && change.allowBlankGuestEmail && change.contact) {
            statements.push(...blankGuestEmailStatements(db, input.customerId, change.contact));
        }
        if (!pending) {
            resultIndexes.push({ channel: change.channel, index: offset + statements.length, pending: false });
            statements.push(subscribeStatement(db, input.customerId, change, at, null));
            continue;
        }
        const nonce = newOptInNonce();
        const confirmationHash = await hashOptInToken(await deriveOptInToken(input.env, { customerId: input.customerId, nonce }));
        resultIndexes.push({ channel: change.channel, index: offset + statements.length, pending: true });
        statements.push(subscribeStatement(db, input.customerId, change, at, confirmationHash));
        const outbox = optInOutboxStatement(db, input.customerId, nonce, confirmationHash, change.source);
        statements.push(outbox.statement);
        outboxIds.push(outbox.outboxId);
    }
    return { statements, outboxIds, resultIndexes };
}

/** What each change did, from the batch results. */
export function readConsentChangeResults(prepared: PreparedConsentChanges, results: readonly unknown[]): ConsentChangeResult[] {
    return prepared.resultIndexes.map(({ channel, index, pending }) => {
        const rows = results[index];
        const changed = Array.isArray(rows) && rows.length > 0;
        return { channel, changed, confirmationRequested: pending && changed };
    });
}

/** Applies consent changes for one customer in one batch and sends any confirmation e-mail. */
export async function applyConsentChanges(
    db: Database,
    input: { customerId: string; changes: readonly ConsentChange[]; env: MarketingLinkEnv; send?: NotificationSender; at?: number },
): Promise<ConsentChangeResult[]> {
    if (input.changes.length === 0) return [];
    const prepared = await prepareConsentChanges(db, input);
    const results = await safeBatch(db, prepared.statements as unknown as Parameters<typeof safeBatch>[1]) as unknown as unknown[];
    const outcome = readConsentChangeResults(prepared, results);
    if (input.send && prepared.outboxIds.length > 0) await input.send(prepared.outboxIds);
    return outcome;
}

// ── Links ─────────────────────────────────────────────────────────────────

/**
 * Confirms a double opt-in. Unknown, used, replaced and expired tokens all
 * read `invalid` (no detail for a guesser). A guest record without an
 * e-mail takes the confirmed address.
 */
export async function confirmMarketingOptIn(
    db: Database,
    token: string,
    at = nowSeconds(),
): Promise<{ status: "confirmed" | "invalid"; channel?: MarketingChannel }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { status: "invalid" };
    const hash = await hashOptInToken(token);
    const live = and(
        eq(consents.confirmationHash, hash),
        eq(consents.state, "pending"),
        sql`${consents.requestedAt} >= ${at - MARKETING_OPT_IN_TTL_SECONDS}`,
    );
    const row = await db.select({ customerId: consents.customerId, contact: consents.contact })
        .from(consents).where(live).get();
    if (!row) return { status: "invalid" };
    const stillPending = sql`EXISTS (SELECT 1 FROM ${consents} WHERE ${consents.customerId} = ${row.customerId} AND ${consents.channel} = 'email' AND ${consents.confirmationHash} = ${hash} AND ${consents.state} = 'pending')`;
    const results = await safeBatch(db, [
        ...blankGuestEmailStatements(db, row.customerId, row.contact, stillPending),
        db.update(consents)
            .set({
                state: "subscribed",
                subscribedAt: at,
                requestedAt: null,
                confirmationHash: null,
                actor: "buyer",
                actorId: null,
                note: null,
                updatedAt: at,
            })
            .where(live)
            .returning({ customerId: consents.customerId }),
    ] as unknown as Parameters<typeof safeBatch>[1]) as unknown as unknown[];
    const updated = results.at(-1);
    return Array.isArray(updated) && updated.length > 0 ? { status: "confirmed", channel: "email" } : { status: "invalid" };
}

/** A signed opt-out suppresses this normalized channel/contact across customer
 * records. Canonical row updates preserve each affected row's audit and event. */
export async function unsubscribeWithLink(
    db: Database,
    link: { customerId: string; channel: MarketingChannel },
    at = nowSeconds(),
): Promise<{ status: "unsubscribed" }> {
    const linkedContact = db.select({ contact: consents.contact }).from(consents)
        .where(and(eq(consents.customerId, link.customerId), eq(consents.channel, link.channel))).limit(1);
    await db.update(consents)
        .set({
            state: "unsubscribed",
            unsubscribedAt: at,
            requestedAt: null,
            confirmationHash: null,
            source: "link",
            actor: "buyer",
            actorId: null,
            note: null,
            consentText: null,
            consentTextVersion: null,
            updatedAt: at,
        })
        .where(and(eq(consents.channel, link.channel), sql`${consents.contact} = (${linkedContact})`, sql`${consents.state} <> 'unsubscribed'`));
    return { status: "unsubscribed" };
}

/** What an unsubscribe page may show for a valid link: the channel and a masked address. */
export async function describeUnsubscribeLink(
    db: Database,
    link: { customerId: string; channel: MarketingChannel },
): Promise<{ channel: MarketingChannel; status: MarketingConsentStatus; contactMasked: string | null }> {
    const view = (await getCustomerMarketingConsents(db, link.customerId).catch(() => null))?.find((row) => row.channel === link.channel);
    return {
        channel: link.channel,
        // A link revokes the stored row, not eligibility at the replacement address.
        status: view?.state ?? "not_subscribed",
        contactMasked: view?.consentContact ? maskMarketingContact(link.channel, view.consentContact) : null,
    };
}

// ── Reads ─────────────────────────────────────────────────────────────────

export interface MarketingConsentView {
    channel: MarketingChannel;
    /** What applies to the customer's current address. */
    status: MarketingConsentStatus;
    /** The stored row's state (it may cover an older address). */
    state: MarketingConsentState | null;
    /** The customer's current address for this channel. */
    contact: string | null;
    /** The address the stored row covers. */
    consentContact: string | null;
    source: MarketingConsentSource | null;
    consentTextVersion: string | null;
    subscribedAt: string | null;
    unsubscribedAt: string | null;
    requestedAt: string | null;
    updatedAt: string | null;
}

const iso = (seconds: number | null | undefined) => (seconds ? new Date(Number(seconds) * 1000).toISOString() : null);

/** Every channel's consent for one customer (rows that do not exist read `not_subscribed`). */
export async function getCustomerMarketingConsents(db: Database, customerId: string): Promise<MarketingConsentView[]> {
    const [customer, rows] = await Promise.all([
        db.select({ id: customers.id, accountClaimedAt: customers.accountClaimedAt, email: customers.email, phone: customers.phone }).from(customers).where(eq(customers.id, customerId)).get(),
        db.select().from(consents).where(eq(consents.customerId, customerId)),
    ]);
    if (!customer) throw new NotFoundError("Customer not found");
    return MARKETING_CHANNELS.map((channel) => {
        const row = rows.find((candidate) => candidate.channel === channel) ?? null;
        const contact = marketingConsentContact(channel, customer);
        return {
            channel,
            status: marketingConsentStatus(row, contact),
            state: row?.state ?? null,
            contact,
            consentContact: row?.contact ?? null,
            source: row?.source ?? null,
            consentTextVersion: row?.consentTextVersion ?? null,
            subscribedAt: iso(row?.subscribedAt),
            unsubscribedAt: iso(row?.unsubscribedAt),
            requestedAt: iso(row?.requestedAt),
            updatedAt: iso(row?.updatedAt),
        };
    });
}

export interface MarketingConsentEventView {
    id: string;
    channel: MarketingChannel;
    previousState: MarketingConsentState | null;
    state: MarketingConsentState;
    source: MarketingConsentSource;
    actor: MarketingConsentActor;
    actorId: string | null;
    note: string | null;
    contact: string;
    consentTextVersion: string | null;
    consentText: string | null;
    createdAt: string;
}

/** The consent audit log of one customer, newest first (at most 100). */
export async function listCustomerConsentEvents(db: Database, customerId: string, limit = 50): Promise<MarketingConsentEventView[]> {
    const rows = await db.select().from(customerMarketingConsentEvents)
        .where(eq(customerMarketingConsentEvents.customerId, customerId))
        .orderBy(desc(customerMarketingConsentEvents.createdAt), desc(customerMarketingConsentEvents.id))
        .limit(Math.min(Math.max(limit, 1), 100));
    return rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        previousState: row.previousState,
        state: row.state,
        source: row.source,
        actor: row.actor,
        actorId: row.actorId,
        note: row.note,
        contact: row.contact,
        consentTextVersion: row.consentTextVersion,
        consentText: row.consentText,
        createdAt: new Date(Number(row.createdAt) * 1000).toISOString(),
    }));
}
