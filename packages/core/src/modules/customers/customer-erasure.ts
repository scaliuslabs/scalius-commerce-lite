// Customer erasure (final audit I10, migration 0179): the right to erasure
// for a buyer who ordered. One atomic batch scrubs the customer's personal
// data and keeps every order, payment, refund, invoice and stock record for
// the books. `customers.erased_at` is set in the same batch, and its trigger
// announces `customer.erased` (ids only) so apps and webhooks erase their own
// copies; an erased record announces nothing else afterwards.
//
// Eligibility before effects: an order that still owes the buyer something
// refuses erasure. The refusal is read first (a refused erasure reads, never
// writes) and asserted again by a guard inside the batch, so an order that
// commits between the read and the batch also refuses it. Nothing outside
// the database happens before that batch commits.
//
// Scrubbed (the customer, and every guest record merged into it):
// - the customer: name -> ERASED_TEXT, email and phone cleared, proofs and
//   sign-in times cleared, retired (deleted_at); history entries scrubbed;
// - its address book, sign-in identities, sessions, saved payment methods,
//   marketing consents and their log, push subscriptions, app customer
//   roles and customer custom-field values: deleted;
// - its orders (by `customer_id` or `account_owner_customer_id`): contact,
//   recipient, street lines, phones and notes; the region (country, admin
//   area, locality, postal code, Bangladesh place ids) stays for tax and
//   reporting; tracking signals (IP, user agent, click ids) are deleted and
//   delivery match signals cleared; abandoned checkouts of those orders, or
//   whose stored or typed phone or typed email is one of the buyer's own
//   contacts (never a recipient's phone),
//   are deleted;
// - reviews on those orders: the display name becomes the fallback name;
// - conversations of the customer and of those orders: the buyer's message
//   bodies become ERASED_TEXT (their search terms are deleted) and a store
//   thread's subject is cleared.
//
// Outside the database (migration 0186, `customer_erasure_tasks`): the batch
// also records one task a buyer image to delete from storage and one a saved
// payment method to detach at its provider (the method's row goes, its
// provider reference stays only in the task). `drainCustomerErasureTasks`
// runs them right after the response and from the minute cron, with backoff,
// and deletes each task once its effect is done; the result reports what is
// still pending. A repeat erasure runs the idempotent scrub again (it
// repairs a record that regained data and changes nothing on one that did
// not), enqueues the buyer's images again (deleting a gone object is a
// no-op) and makes failed tasks due now. The database refuses any write that
// gives an erased record personal data back (migration 0191).
//
// Kept: issued invoices and tax snapshots (legal records, as issued), order
// amendment snapshots and payment provider records (the provider's copy is
// the merchant's to remove at the provider), gift cards the buyer bought for
// someone else, and ids everywhere.

import {
  abandonedCheckouts,
  conversationAttachments,
  conversationMessages,
  conversationSearchTerms,
  conversations,
  customerAddresses,
  customerErasureTasks,
  customerHistory,
  customerIdentities,
  customerMarketingConsentEvents,
  customerMarketingConsents,
  customerPaymentMethods,
  customerSessions,
  customFieldValues,
  customers,
  orders,
  orderTrackingSignals,
  pluginCustomerRoles,
  productReviews,
  pushSubscriptions,
  trackingDeliveries,
} from "@scalius/database/schema";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import { and, eq, isNotNull, isNull, lte, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";
import { NO_PHONE } from "@scalius/shared/customer-auth-policy";
import { ERASED_TEXT, ERASURE_BLOCKING_ORDER_STATUSES } from "@scalius/shared/customer-erasure";
import { REVIEW_FALLBACK_DISPLAY_NAME } from "@scalius/shared/reviews";
import { NotFoundError, ValidationError } from "@scalius/core/errors";

type SQLiteBatchItem = BatchItem<"sqlite">;

/** Where the buyer's conversation images live (an R2 bucket or a stand-in). */
export interface ErasureFileStore {
  delete(keys: string | string[]): Promise<unknown>;
}

/** What erasure still has to remove outside the database. */
export interface ErasurePending {
  /** The buyer's conversation images not yet deleted from storage. */
  files: number;
  /** Saved payment methods not yet detached at their provider. */
  paymentMethods: number;
}

export interface EraseCustomerResult {
  customerId: string;
  /** False when the customer was already erased (the database changed nothing; pending work resumes). */
  erased: boolean;
  /** The guest records merged into it, erased with it. */
  mergedRecords: number;
  /** Orders whose contact was scrubbed. */
  orders: number;
  /** Work outside the database that is recorded and still to do (drained in the background). */
  pending: ErasurePending;
  /** True only when nothing is pending: every file is deleted and every method detached. */
  complete: boolean;
}

const BUYER_AUTHORS = ["customer", "guest_receipt"] as const;
const ORDER_OPEN_GUARD = "CUSTOMER_ERASURE_ORDER_OPEN";
const ALREADY_ERASED_GUARD = "CUSTOMER_ERASURE_ALREADY_ERASED";

/** The records erasure covers: the customer and every guest record merged into it. */
async function erasureScope(db: Database, subjectId: string) {
  const records = await db
    .select({ id: customers.id, phone: customers.phone })
    .from(customers)
    .where(or(eq(customers.id, subjectId), eq(customers.mergedIntoCustomerId, subjectId)))
    .all();
  const ids = JSON.stringify(records.map((record) => record.id));
  const inIds = (column: SQLWrapper): SQL => sql`${column} IN (SELECT CAST(value AS TEXT) FROM json_each(${ids}))`;
  const theirOrders = or(inIds(orders.customerId), inIds(orders.accountOwnerCustomerId))!;
  const orderIdSet = (column: SQLWrapper): SQL =>
    sql`${column} IN (SELECT ${orders.id} FROM ${orders} WHERE ${theirOrders})`;
  // The buyer's conversations: their store threads and the threads of their orders.
  const theirConversations = or(inIds(conversations.customerId), orderIdSet(conversations.orderId))!;
  const inTheirConversations = (column: SQLWrapper): SQL =>
    sql`${column} IN (SELECT ${conversations.id} FROM ${conversations} WHERE ${theirConversations})`;
  const blockingOrder = and(
    theirOrders,
    sql`${orders.status} IN (${sql.join(ERASURE_BLOCKING_ORDER_STATUSES.map((status) => sql`${status}`), sql`, `)})`,
    isNull(orders.deletedAt),
  )!;
  return { records, inIds, theirOrders, orderIdSet, inTheirConversations, blockingOrder };
}

type ErasureScope = Awaited<ReturnType<typeof erasureScope>>;

function refusal(open: { id: string; orderNumber: number | null }): ValidationError {
  return new ValidationError("This customer has an order in progress. Deliver, complete or cancel it before erasing their data.", {
    orderId: open.id,
    orderNumber: open.orderNumber,
  });
}

async function readBlockingOrder(db: Database, scope: ErasureScope) {
  return await db.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders)
    .where(scope.blockingOrder).limit(1).get();
}

/** One delete task a buyer image of the customer's conversations (a repeat is a no-op). */
function enqueueFileTasks(db: Database, subjectId: string, scope: ErasureScope): SQLiteBatchItem {
  return db.insert(customerErasureTasks).select(sql`
    SELECT 'file:' || ${conversationAttachments.id}, ${subjectId}, 'delete_file', NULL, ${conversationAttachments.r2Key},
      0, unixepoch(), NULL, unixepoch()
    FROM ${conversationAttachments}
    WHERE ${scope.inTheirConversations(conversationAttachments.conversationId)}
      AND ${conversationAttachments.uploaderType} IN (${sql.join(BUYER_AUTHORS.map((type) => sql`${type}`), sql`, `)})
  `).onConflictDoNothing() as unknown as SQLiteBatchItem;
}

/** One detach task an active saved method; written before the batch deletes the method rows. */
function enqueueDetachTasks(db: Database, subjectId: string, scope: ErasureScope): SQLiteBatchItem {
  return db.insert(customerErasureTasks).select(sql`
    SELECT 'method:' || ${customerPaymentMethods.id}, ${subjectId}, 'detach_payment_method', ${customerPaymentMethods.providerId},
      ${customerPaymentMethods.providerMethodRef}, 0, unixepoch(), NULL, unixepoch()
    FROM ${customerPaymentMethods}
    WHERE ${scope.inIds(customerPaymentMethods.customerId)} AND ${customerPaymentMethods.status} = 'active'
  `).onConflictDoNothing() as unknown as SQLiteBatchItem;
}

/** What is still to do outside the database for an erased customer. */
export async function readErasurePending(db: Database, customerId: string): Promise<ErasurePending> {
  const rows = await db
    .select({ kind: customerErasureTasks.kind, count: sql<number>`count(*)` })
    .from(customerErasureTasks)
    .where(eq(customerErasureTasks.customerId, customerId))
    .groupBy(customerErasureTasks.kind)
    .all();
  const count = (kind: string) => Number(rows.find((row) => row.kind === kind)?.count ?? 0);
  return { files: count("delete_file"), paymentMethods: count("detach_payment_method") };
}

function resultOf(base: Omit<EraseCustomerResult, "pending" | "complete">, pending: ErasurePending): EraseCustomerResult {
  return { ...base, pending, complete: pending.files === 0 && pending.paymentMethods === 0 };
}

/**
 * The checkout snapshots that name the buyer: those of their orders (an
 * archived hosted-payment order keeps its order id), and those whose stored
 * or typed phone or typed email is one of the buyer's own contacts: the
 * records', their marketing consents' and their orders' own contact phone,
 * WhatsApp and email. A recipient's phone (address book, an order's shipping
 * or billing phone) is someone else's: their own checkouts stay. Read inside
 * the statement, before the rest of the batch scrubs those contacts.
 * Snapshots live at most 30 days (abandoned/cleanup.ts), so the scan of
 * their JSON is bounded.
 */
function abandonedCheckoutsOfBuyer(scope: ErasureScope): SQL {
  const { inIds, theirOrders, orderIdSet } = scope;
  // Separate IN tests, not one UNION: D1 allows five terms in a compound SELECT.
  const phoneOnRecord = (phone: SQL): SQL => sql`(${phone} <> ${NO_PHONE} AND (
    ${phone} IN (SELECT ${customers.phone} FROM ${customers} WHERE ${inIds(customers.id)})
    OR ${phone} IN (SELECT ${customerMarketingConsents.contact} FROM ${customerMarketingConsents} WHERE ${inIds(customerMarketingConsents.customerId)} AND ${customerMarketingConsents.channel} IN ('sms', 'whatsapp'))
    OR EXISTS (SELECT 1 FROM ${orders} WHERE ${theirOrders} AND ${phone} IN (${orders.customerPhone}, ${orders.customerWhatsapp}))
  ))`;
  const emailOnRecord = (email: SQL): SQL => sql`(${email} <> '' AND (
    ${email} IN (SELECT lower(trim(${customers.email})) FROM ${customers} WHERE ${inIds(customers.id)})
    OR ${email} IN (SELECT lower(trim(${customerMarketingConsents.contact})) FROM ${customerMarketingConsents} WHERE ${inIds(customerMarketingConsents.customerId)} AND ${customerMarketingConsents.channel} = 'email')
    OR EXISTS (SELECT 1 FROM ${orders} WHERE ${theirOrders} AND lower(trim(${orders.customerEmail})) = ${email})
  ))`;
  const typed = (path: string): SQL =>
    sql`(CASE WHEN json_valid(${abandonedCheckouts.checkoutData}) THEN json_extract(${abandonedCheckouts.checkoutData}, ${path}) END)`;
  return or(
    orderIdSet(abandonedCheckouts.checkoutId),
    phoneOnRecord(sql`${abandonedCheckouts.customerPhone}`),
    phoneOnRecord(typed("$.customerPhone")),
    emailOnRecord(sql`lower(trim(${typed("$.customerEmail")}))`),
  )!;
}

/** An order of the buyer that still holds something erasure clears (none, after a complete erasure). */
function orderStillNamesBuyer(): SQL {
  const erased = ERASED_TEXT;
  const scrubbedText = (column: SQLWrapper): SQL => sql`(${column} IS NOT NULL AND ${column} <> ${erased})`;
  return sql`(${orders.customerName} <> ${erased} OR ${orders.customerPhone} <> ${NO_PHONE} OR ${orders.customerEmail} IS NOT NULL
    OR ${orders.customerWhatsapp} IS NOT NULL OR ${orders.shippingAddressLine2} IS NOT NULL OR ${orders.shippingCompany} IS NOT NULL
    OR ${orders.shippingName} IS NOT NULL OR ${orders.shippingPhone} IS NOT NULL OR ${orders.billingName} IS NOT NULL
    OR ${orders.billingCompany} IS NOT NULL OR ${orders.billingAddressLine2} IS NOT NULL OR ${orders.billingPhone} IS NOT NULL
    OR ${orders.notes} IS NOT NULL OR ${scrubbedText(orders.shippingAddress)} OR ${scrubbedText(orders.billingAddress)}
    OR ${scrubbedText(orders.shippingDependentLocality)} OR ${scrubbedText(orders.billingDependentLocality)})`;
}

/** A customer record that still holds something erasure clears, or is not yet erased. */
function recordNotErased(): SQL {
  return sql`(${customers.erasedAt} IS NULL OR ${customers.deletedAt} IS NULL OR ${customers.name} <> ${ERASED_TEXT}
    OR ${customers.email} IS NOT NULL OR ${customers.phone} <> ${NO_PHONE} OR ${customers.phoneVerifiedAt} IS NOT NULL
    OR ${customers.emailVerifiedAt} IS NOT NULL OR ${customers.lastAuthenticatedAt} IS NOT NULL OR ${customers.taxExemptionId} IS NOT NULL)`;
}

/**
 * The scrub: every statement is idempotent and changes only what still
 * holds personal data, so a repeat erasure runs it again and repairs a record
 * that regained data before the database refused it (migration 0191), and
 * changes nothing on one that did not.
 */
function scrubStatements(db: Database, subjectId: string, scope: ErasureScope): SQLiteBatchItem[] {
  const { inIds, theirOrders, orderIdSet, inTheirConversations } = scope;
  const buyerMessage = and(
    inTheirConversations(conversationMessages.conversationId),
    eq(conversationMessages.kind, "message"),
    sql`${conversationMessages.authorType} IN ('customer', 'guest_receipt')`,
  )!;
  const now = sql`unixepoch()`;
  const erased = ERASED_TEXT;
  const scrubbed = (column: SQLWrapper): SQL => sql`CASE WHEN ${column} IS NULL THEN NULL ELSE ${erased} END`;
  return [
    // The work outside the database, before the rows it reads go.
    enqueueDetachTasks(db, subjectId, scope),
    enqueueFileTasks(db, subjectId, scope),
    // First: it matches the contacts the statements below clear.
    db.delete(abandonedCheckouts).where(abandonedCheckoutsOfBuyer(scope)),
    // Erased first: the address-book delete below then announces no update.
    db.update(customers).set({
      name: erased,
      email: null,
      phone: NO_PHONE,
      phoneVerifiedAt: null,
      emailVerifiedAt: null,
      lastAuthenticatedAt: null,
      // A tax registration number names its holder; the order snapshots keep theirs as issued.
      taxExempt: false,
      taxExemptionId: null,
      erasedAt: sql`coalesce(${customers.erasedAt}, unixepoch())`,
      deletedAt: sql`coalesce(${customers.deletedAt}, unixepoch())`,
      updatedAt: now,
    }).where(and(inIds(customers.id), recordNotErased())),
    db.update(customerHistory).set({ name: erased, email: null, phone: NO_PHONE })
      .where(and(inIds(customerHistory.customerId), sql`(${customerHistory.name} <> ${erased} OR ${customerHistory.email} IS NOT NULL OR ${customerHistory.phone} <> ${NO_PHONE})`)),
    db.delete(customerAddresses).where(inIds(customerAddresses.customerId)),
    db.delete(customerIdentities).where(inIds(customerIdentities.customerId)),
    db.delete(customerSessions).where(inIds(customerSessions.customerId)),
    db.delete(customerPaymentMethods).where(inIds(customerPaymentMethods.customerId)),
    db.delete(customerMarketingConsents).where(inIds(customerMarketingConsents.customerId)),
    db.delete(customerMarketingConsentEvents).where(inIds(customerMarketingConsentEvents.customerId)),
    db.delete(pushSubscriptions).where(inIds(pushSubscriptions.customerId)),
    db.delete(pluginCustomerRoles).where(inIds(pluginCustomerRoles.customerId)),
    db.delete(customFieldValues).where(and(eq(customFieldValues.ownerType, "customer"), inIds(customFieldValues.ownerId))),
    // Orders keep their money, lines and region; the person leaves.
    db.update(orders).set({
      customerName: erased,
      customerPhone: NO_PHONE,
      customerEmail: null,
      customerWhatsapp: null,
      shippingAddress: scrubbed(orders.shippingAddress),
      shippingAddressLine2: null,
      shippingDependentLocality: scrubbed(orders.shippingDependentLocality),
      shippingCompany: null,
      shippingName: null,
      shippingPhone: null,
      billingName: null,
      billingCompany: null,
      billingAddress: scrubbed(orders.billingAddress),
      billingAddressLine2: null,
      billingDependentLocality: scrubbed(orders.billingDependentLocality),
      billingPhone: null,
      notes: null,
      version: sql`${orders.version} + 1`,
      updatedAt: now,
    }).where(and(theirOrders, orderStillNamesBuyer())),
    db.delete(orderTrackingSignals).where(orderIdSet(orderTrackingSignals.orderId)),
    db.update(trackingDeliveries).set({ matchSignals: null }).where(and(orderIdSet(trackingDeliveries.orderId), isNotNull(trackingDeliveries.matchSignals))),
    db.update(productReviews).set({ authorDisplayName: REVIEW_FALLBACK_DISPLAY_NAME })
      .where(and(
        or(inIds(productReviews.reviewerKey), inIds(productReviews.customerId), orderIdSet(productReviews.orderId)),
        sql`${productReviews.authorDisplayName} <> ${REVIEW_FALLBACK_DISPLAY_NAME}`,
      )),
    // Search terms first: they are derived from the bodies about to go.
    db.delete(conversationSearchTerms).where(sql`${conversationSearchTerms.messageId} IN (SELECT ${conversationMessages.id} FROM ${conversationMessages} WHERE ${buyerMessage})`),
    db.update(conversationMessages).set({ body: erased }).where(and(buyerMessage, sql`${conversationMessages.body} <> ${erased}`)),
    db.update(conversations).set({ subject: null }).where(and(inIds(conversations.customerId), eq(conversations.subjectType, "store"), isNotNull(conversations.subject))),
  ] as SQLiteBatchItem[];
}

/**
 * A repeat erasure. First the work outside the database resumes, whatever
 * else holds: the buyer's images are enqueued again and failed tasks become
 * due now. Then the scrub runs again (it repairs a record that regained data
 * and changes nothing on one that did not), unless an order of the record is
 * in progress: then the scrub is refused like a first erasure.
 */
async function resumeErasure(db: Database, subjectId: string): Promise<EraseCustomerResult> {
  const scope = await erasureScope(db, subjectId);
  await safeBatch(db, [
    enqueueFileTasks(db, subjectId, scope),
    db.update(customerErasureTasks)
      .set({ nextAttemptAt: sql`unixepoch()` })
      .where(and(eq(customerErasureTasks.customerId, subjectId), isNotNull(customerErasureTasks.lastError))) as unknown as SQLiteBatchItem,
  ]);
  const open = await readBlockingOrder(db, scope);
  if (open) throw refusal(open);
  try {
    await safeBatch(db, [
      buildBatchGuard(db, sql`NOT EXISTS (SELECT 1 FROM ${orders} WHERE ${scope.blockingOrder})`, ORDER_OPEN_GUARD),
      ...scrubStatements(db, subjectId, scope),
    ] as Parameters<typeof safeBatch>[1]);
  } catch (error) {
    if (!isBatchGuardError(error, ORDER_OPEN_GUARD)) throw error;
    const opened = await readBlockingOrder(db, scope);
    if (opened) throw refusal(opened);
    throw error;
  }
  return resultOf({ customerId: subjectId, erased: false, mergedRecords: 0, orders: 0 }, await readErasurePending(db, subjectId));
}

/**
 * Erases a customer's personal data (see the file comment). Refuses while
 * an order still owes the buyer something (ERASURE_BLOCKING_ORDER_STATUSES),
 * and then changes nothing anywhere. Idempotent: an erased customer answers
 * `{ erased: false }`; the scrub runs again and its storage and provider work
 * resumes.
 */
export async function eraseCustomer(
  db: Database,
  input: { customerId: string; actorId: string | null },
): Promise<EraseCustomerResult> {
  const subject = await db
    .select({ id: customers.id, erasedAt: customers.erasedAt })
    .from(customers)
    .where(eq(customers.id, input.customerId))
    .get();
  if (!subject) throw new NotFoundError("Customer not found");
  if (subject.erasedAt) return resumeErasure(db, subject.id);

  const scope = await erasureScope(db, subject.id);
  const [open, orderCount] = await Promise.all([
    readBlockingOrder(db, scope),
    db.select({ count: sql<number>`count(*)` }).from(orders).where(scope.theirOrders).get(),
  ]);
  if (open) throw refusal(open);

  try {
    await safeBatch(db, [
      // The read above, again inside the commit: an order placed since then refuses the erasure,
      // and a concurrent erasure of the same record commits once.
      buildBatchGuard(db, sql`NOT EXISTS (SELECT 1 FROM ${orders} WHERE ${scope.blockingOrder})`, ORDER_OPEN_GUARD),
      buildBatchGuard(db, sql`EXISTS (SELECT 1 FROM ${customers} WHERE ${customers.id} = ${subject.id} AND ${customers.erasedAt} IS NULL)`, ALREADY_ERASED_GUARD),
      ...scrubStatements(db, subject.id, scope),
      // After the record is erased: the database refuses a history entry with contact on an erased record.
      db.insert(customerHistory).values({
        id: `hist_${nanoid()}`,
        customerId: subject.id,
        name: ERASED_TEXT,
        email: null,
        phone: NO_PHONE,
        changeType: "erased",
        actor: "staff",
        actorId: input.actorId,
        createdAt: sql`unixepoch()`,
      }),
    ] as Parameters<typeof safeBatch>[1]);
  } catch (error) {
    if (!isBatchGuardError(error, ORDER_OPEN_GUARD) && !isBatchGuardError(error, ALREADY_ERASED_GUARD)) throw error;
    // Which guard stopped it: a concurrent erasure committed, or an order opened since the read.
    const current = await db.select({ erasedAt: customers.erasedAt }).from(customers).where(eq(customers.id, subject.id)).get();
    if (current?.erasedAt) return resumeErasure(db, subject.id);
    const opened = await readBlockingOrder(db, scope);
    if (opened) throw refusal(opened);
    throw error;
  }

  return resultOf({
    customerId: subject.id,
    erased: true,
    mergedRecords: scope.records.length - 1,
    orders: Number(orderCount?.count ?? 0),
  }, await readErasurePending(db, subject.id));
}

// ── The work outside the database ──

/** Image keys one storage call deletes (R2 deletes at most 1,000 keys a call). */
export const ERASURE_FILE_KEYS_PER_DRAIN = 1_000;
/** Saved methods one drain detaches (a provider round trip and its settings read each). */
export const ERASURE_DETACHES_PER_DRAIN = 2;
/** How long a claimed task is held before another drain may take it over. */
export const ERASURE_TASK_LEASE_SECONDS = 120;
const MAX_BACKOFF_SECONDS = 6 * 60 * 60;
const ERROR_CODE = /^[a-z][a-z0-9_.-]{0,63}$/;

/** The provider side of a saved method's detach, supplied by the caller (the payment providers live there). */
export interface ErasureProviderDetacher {
  /**
   * Detaches one saved method at its provider. Resolves when nothing is left
   * to detach there (deleted, unknown to the provider, or a gateway that no
   * longer exists or never kept methods); throws to retry later. The thrown
   * error's `code` (a short identifier) is recorded, never its message. It
   * sends the key every removal of the method sends (`delete:<method id>`).
   */
  detach(method: { methodId: string; providerId: string; ref: string }): Promise<void>;
}

export interface ErasureEffects {
  /** The bucket for the buyer's images; null leaves file tasks for a drain that has it. */
  files: ErasureFileStore | null;
  detacher: ErasureProviderDetacher;
}

export interface ErasureDrainResult {
  claimed: number;
  done: number;
  failed: number;
}

/** The due-work probe of the erasure drain (scheduled/due-work.ts). */
export function customerErasureDueProbes(db: Database) {
  return [
    db.select({ id: customerErasureTasks.id }).from(customerErasureTasks)
      .where(lte(customerErasureTasks.nextAttemptAt, sql`unixepoch()`)).limit(1),
  ];
}

function failureCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : fallback;
}

/** Claims due tasks of one kind: each claim moves `next_attempt_at` past the lease, so a crash retries after it. */
function claim(db: Database, kind: "delete_file" | "detach_payment_method", limit: number, customerId: string | undefined) {
  const due = sql`SELECT ${customerErasureTasks.id} FROM ${customerErasureTasks}
    WHERE ${customerErasureTasks.kind} = ${kind} AND ${customerErasureTasks.nextAttemptAt} <= unixepoch()
      ${customerId ? sql`AND ${customerErasureTasks.customerId} = ${customerId}` : sql``}
    ORDER BY ${customerErasureTasks.nextAttemptAt}, ${customerErasureTasks.id}
    LIMIT ${limit}`;
  return db.update(customerErasureTasks)
    .set({
      attempts: sql`${customerErasureTasks.attempts} + 1`,
      nextAttemptAt: sql`unixepoch() + ${ERASURE_TASK_LEASE_SECONDS}`,
      lastError: null,
    })
    .where(sql`${customerErasureTasks.id} IN (${due})`)
    .returning({
      id: customerErasureTasks.id,
      providerId: customerErasureTasks.providerId,
      ref: customerErasureTasks.ref,
      attempts: customerErasureTasks.attempts,
    });
}

async function finish(db: Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(customerErasureTasks)
    .where(sql`${customerErasureTasks.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))`);
}

/** The wait before a failed task's next attempt: 1 minute doubling per attempt, at most 6 hours. */
export function erasureRetryDelaySeconds(attempts: number): number {
  return Math.min(MAX_BACKOFF_SECONDS, 60 * 2 ** Math.max(0, Math.min(attempts - 1, 12)));
}

async function retryLater(db: Database, tasks: Array<{ id: string; attempts: number }>, code: string): Promise<void> {
  // Tasks that failed together usually share their attempt count: one statement per count.
  const byAttempts = new Map<number, string[]>();
  for (const task of tasks) byAttempts.set(task.attempts, [...(byAttempts.get(task.attempts) ?? []), task.id]);
  for (const [attempts, ids] of byAttempts) {
    await db.update(customerErasureTasks)
      .set({ nextAttemptAt: sql`unixepoch() + ${erasureRetryDelaySeconds(attempts)}`, lastError: code })
      .where(sql`${customerErasureTasks.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))`);
  }
}

/**
 * Runs due erasure tasks: one storage call for up to 1,000 image keys and a
 * few provider detaches. A done task is deleted; a failed one backs off
 * (`erasureRetryDelaySeconds`) with a short error code. With a
 * `customerId`, only that customer's due tasks run (a repeat erasure).
 * Never throws for a task's failure: the task row keeps it.
 */
export async function drainCustomerErasureTasks(
  db: Database,
  effects: ErasureEffects,
  options: { customerId?: string; fileLimit?: number; detachLimit?: number } = {},
): Promise<ErasureDrainResult> {
  const result: ErasureDrainResult = { claimed: 0, done: 0, failed: 0 };
  const fileLimit = effects.files ? Math.max(0, Math.min(options.fileLimit ?? ERASURE_FILE_KEYS_PER_DRAIN, ERASURE_FILE_KEYS_PER_DRAIN)) : 0;
  const detachLimit = Math.max(0, options.detachLimit ?? ERASURE_DETACHES_PER_DRAIN);
  const claims = [
    ...(fileLimit > 0 ? [claim(db, "delete_file", fileLimit, options.customerId)] : []),
    ...(detachLimit > 0 ? [claim(db, "detach_payment_method", detachLimit, options.customerId)] : []),
  ];
  if (claims.length === 0) return result;
  const claimed = await safeBatch(db, claims as unknown as SQLiteBatchItem[]) as unknown as Array<Array<{ id: string; providerId: string | null; ref: string; attempts: number }>>;
  const files = fileLimit > 0 ? claimed[0]! : [];
  const methods = detachLimit > 0 ? claimed[fileLimit > 0 ? 1 : 0]! : [];
  result.claimed = files.length + methods.length;

  if (files.length > 0 && effects.files) {
    try {
      await effects.files.delete(files.map((file) => file.ref));
      await finish(db, files.map((file) => file.id));
      result.done += files.length;
    } catch (error) {
      await retryLater(db, files, failureCode(error, "storage_failed"));
      result.failed += files.length;
    }
  }

  const detached: string[] = [];
  for (const method of methods) {
    try {
      await effects.detacher.detach({
        methodId: method.id.slice("method:".length),
        providerId: method.providerId!,
        ref: method.ref,
      });
      detached.push(method.id);
    } catch (error) {
      await retryLater(db, [method], failureCode(error, "provider_failed"));
      result.failed += 1;
    }
  }
  await finish(db, detached);
  result.done += detached.length;
  return result;
}
