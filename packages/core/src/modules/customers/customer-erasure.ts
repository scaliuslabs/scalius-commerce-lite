// Customer erasure (final audit I10, migration 0179): the right to erasure
// for a buyer who ordered. One atomic batch scrubs the customer's personal
// data and keeps every order, payment, refund, invoice and stock record for
// the books. `customers.erased_at` is set in the same batch, and its trigger
// announces `customer.erased` (ids only) so apps and webhooks erase their own
// copies; an erased record announces nothing else afterwards.
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
//   delivery match signals cleared; abandoned checkouts of those orders or
//   that phone are deleted;
// - reviews on those orders: the display name becomes the fallback name;
// - conversations of the customer and of those orders: the buyer's message
//   bodies become ERASED_TEXT (their search terms are deleted), a store
//   thread's subject is cleared, and the buyer's image files are deleted
//   from storage after the commit.
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
import { safeBatch, type Database } from "@scalius/database/client";
import { and, eq, isNotNull, isNull, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { nanoid } from "nanoid";
import { NO_PHONE } from "@scalius/shared/customer-auth-policy";
import { ERASED_TEXT, ERASURE_BLOCKING_ORDER_STATUSES } from "@scalius/shared/customer-erasure";
import { REVIEW_FALLBACK_DISPLAY_NAME } from "@scalius/shared/reviews";
import { NotFoundError, ValidationError } from "@scalius/core/errors";

/** Where the buyer's conversation images live (an R2 bucket or a stand-in). */
export interface ErasureFileStore {
  delete(keys: string | string[]): Promise<unknown>;
}

export interface EraseCustomerResult {
  customerId: string;
  /** False when the customer was already erased (nothing changed). */
  erased: boolean;
  /** The guest records merged into it, erased with it. */
  mergedRecords: number;
  /** Orders whose contact was scrubbed. */
  orders: number;
  /** The buyer's image files deleted from storage (after the commit). */
  files: number;
}

const BUYER_AUTHORS = ["customer", "guest_receipt"] as const;
/** At most this many image files are deleted per call; the rest stay referenced by erased messages. */
const FILE_DELETE_CHUNK = 1_000;

/**
 * Erases a customer's personal data (see the file comment). Refuses while
 * an order still owes the buyer something (ERASURE_BLOCKING_ORDER_STATUSES).
 * Idempotent: an erased customer answers `{ erased: false }`.
 */
export async function eraseCustomer(
  db: Database,
  input: { customerId: string; actorId: string | null; files?: ErasureFileStore | null },
): Promise<EraseCustomerResult> {
  const subject = await db
    .select({ id: customers.id, erasedAt: customers.erasedAt, mergedIntoCustomerId: customers.mergedIntoCustomerId })
    .from(customers)
    .where(eq(customers.id, input.customerId))
    .get();
  if (!subject) throw new NotFoundError("Customer not found");
  if (subject.erasedAt) return { customerId: subject.id, erased: false, mergedRecords: 0, orders: 0, files: 0 };

  // The record and every guest record merged into it (they hold the same person's old contact).
  const records = await db
    .select({ id: customers.id, phone: customers.phone })
    .from(customers)
    .where(or(eq(customers.id, subject.id), eq(customers.mergedIntoCustomerId, subject.id)))
    .all();
  const ids = JSON.stringify(records.map((record) => record.id));
  const phones = JSON.stringify([...new Set(records.map((record) => record.phone).filter((phone) => phone && phone !== NO_PHONE))]);
  const inIds = (column: SQLWrapper): SQL => sql`${column} IN (SELECT CAST(value AS TEXT) FROM json_each(${ids}))`;
  const theirOrders = or(inIds(orders.customerId), inIds(orders.accountOwnerCustomerId))!;
  const orderIdSet = (column: SQLWrapper): SQL =>
    sql`${column} IN (SELECT ${orders.id} FROM ${orders} WHERE ${theirOrders})`;

  const [open, orderCount] = await Promise.all([
    db.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders)
      .where(and(theirOrders, sql`${orders.status} IN (${sql.join(ERASURE_BLOCKING_ORDER_STATUSES.map((status) => sql`${status}`), sql`, `)})`, isNull(orders.deletedAt)))
      .limit(1).get(),
    db.select({ count: sql<number>`count(*)` }).from(orders).where(theirOrders).get(),
  ]);
  if (open) {
    throw new ValidationError("This customer has an order in progress. Deliver, complete or cancel it before erasing their data.", {
      orderId: open.id,
      orderNumber: open.orderNumber,
    });
  }

  // The buyer's conversations: their store threads and the threads of their orders.
  const theirConversations = or(inIds(conversations.customerId), orderIdSet(conversations.orderId))!;
  const inTheirConversations = (column: SQLWrapper): SQL =>
    sql`${column} IN (SELECT ${conversations.id} FROM ${conversations} WHERE ${theirConversations})`;
  const buyerMessage = and(
    inTheirConversations(conversationMessages.conversationId),
    eq(conversationMessages.kind, "message"),
    sql`${conversationMessages.authorType} IN ('customer', 'guest_receipt')`,
  )!;
  const files = await db
    .select({ r2Key: conversationAttachments.r2Key })
    .from(conversationAttachments)
    .where(and(
      inTheirConversations(conversationAttachments.conversationId),
      sql`${conversationAttachments.uploaderType} IN (${sql.join(BUYER_AUTHORS.map((type) => sql`${type}`), sql`, `)})`,
    ))
    .limit(FILE_DELETE_CHUNK)
    .all();

  const now = sql`unixepoch()`;
  const erased = ERASED_TEXT;
  const scrubbed = (column: SQLWrapper): SQL => sql`CASE WHEN ${column} IS NULL THEN NULL ELSE ${erased} END`;

  await safeBatch(db, [
    // Erased first: the address-book delete below then announces no update.
    db.update(customers).set({
      name: erased,
      email: null,
      phone: NO_PHONE,
      phoneVerifiedAt: null,
      emailVerifiedAt: null,
      lastAuthenticatedAt: null,
      erasedAt: now,
      deletedAt: sql`coalesce(${customers.deletedAt}, unixepoch())`,
      updatedAt: now,
    }).where(and(inIds(customers.id), isNull(customers.erasedAt))),
    db.update(customerHistory).set({ name: erased, email: null, phone: NO_PHONE }).where(inIds(customerHistory.customerId)),
    db.insert(customerHistory).values({
      id: `hist_${nanoid()}`,
      customerId: subject.id,
      name: erased,
      email: null,
      phone: NO_PHONE,
      changeType: "erased",
      actor: "staff",
      actorId: input.actorId,
      createdAt: now,
    }),
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
    }).where(theirOrders),
    db.delete(orderTrackingSignals).where(orderIdSet(orderTrackingSignals.orderId)),
    db.update(trackingDeliveries).set({ matchSignals: null }).where(and(orderIdSet(trackingDeliveries.orderId), isNotNull(trackingDeliveries.matchSignals))),
    db.delete(abandonedCheckouts).where(or(
      orderIdSet(abandonedCheckouts.checkoutId),
      sql`${abandonedCheckouts.customerPhone} IN (SELECT CAST(value AS TEXT) FROM json_each(${phones}))`,
    )),
    db.update(productReviews).set({ authorDisplayName: REVIEW_FALLBACK_DISPLAY_NAME })
      .where(and(
        or(inIds(productReviews.reviewerKey), inIds(productReviews.customerId), orderIdSet(productReviews.orderId)),
        sql`${productReviews.authorDisplayName} <> ${REVIEW_FALLBACK_DISPLAY_NAME}`,
      )),
    // Search terms first: they are derived from the bodies about to go.
    db.delete(conversationSearchTerms).where(sql`${conversationSearchTerms.messageId} IN (SELECT ${conversationMessages.id} FROM ${conversationMessages} WHERE ${buyerMessage})`),
    db.update(conversationMessages).set({ body: erased }).where(and(buyerMessage, sql`${conversationMessages.body} <> ${erased}`)),
    db.update(conversations).set({ subject: null }).where(and(inIds(conversations.customerId), eq(conversations.subjectType, "store"), isNotNull(conversations.subject))),
  ] as Parameters<typeof safeBatch>[1]);

  // Files go after the commit: a failed delete leaves an unreachable private object, never a half-erased record.
  let deletedFiles = 0;
  if (input.files && files.length > 0) {
    try {
      await input.files.delete(files.map((file) => file.r2Key));
      deletedFiles = files.length;
    } catch {
      deletedFiles = 0;
    }
  }
  return {
    customerId: subject.id,
    erased: true,
    mergedRecords: records.length - 1,
    orders: Number(orderCount?.count ?? 0),
    files: deletedFiles,
  };
}
