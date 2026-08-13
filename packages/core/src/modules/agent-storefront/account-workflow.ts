import { buildBatchGuard, safeBatch, type Database } from "@scalius/database/client";
import {
  agentStorefrontContexts,
  agentStorefrontContinuations,
  agentStorefrontOrderGrants,
  customerSessions,
  customers,
  media,
  orderItems,
  orders,
  paymentSessionAttempts,
  PaymentStatus,
} from "@scalius/database/schema";
import { getCurrentPublicMediaUrl } from "@scalius/core/integrations/storage";
import {
  updateCustomerProfile,
  type CustomerSession,
} from "@scalius/core/modules/customers/customer-auth.service";
import {
  getCustomerOrderDetailForOrder,
  getCustomerOrders,
  getCustomerOwnedOrderForDetail,
} from "@scalius/core/modules/customers/customers.service";
import {
  createCustomerOrderSupportRequest,
  createReceiptOrderSupportRequest,
  getReceiptOrderSupportRequestStateForOrder,
} from "@scalius/core/modules/orders/order-support-requests";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../../errors";
import {
  getAgentStorefrontBootstrapContinuationId,
  hashAgentStorefrontBootstrapCode,
} from "./bootstrap";

type ContextRow = typeof agentStorefrontContexts.$inferSelect;
type ContinuationRow = typeof agentStorefrontContinuations.$inferSelect;
type SQLiteBatchItem = BatchItem<"sqlite">;

function nowSeconds(now = new Date()): number {
  return Math.floor(now.getTime() / 1_000);
}

async function loadContext(db: Database, contextId: string): Promise<ContextRow> {
  const row = await db.select().from(agentStorefrontContexts)
    .where(eq(agentStorefrontContexts.id, contextId))
    .get();
  if (!row) throw new NotFoundError("Storefront context not found.");
  return row;
}

async function loadOwnedActiveContext(
  db: Database,
  grantId: string,
  contextId: string,
  now = new Date(),
): Promise<ContextRow> {
  const row = await loadContext(db, contextId);
  if (row.grantId !== grantId) throw new ForbiddenError("This connection does not own the storefront context.");
  if (row.status !== "active" || row.closedAt) throw new ConflictError("This storefront context is closed.");
  if (row.expiresAt <= now) throw new ConflictError("This storefront context expired.");
  return row;
}

async function loadHostedContinuation(
  db: Database,
  continuationId: string,
  now = new Date(),
): Promise<{ context: ContextRow; continuation: ContinuationRow }> {
  const continuation = await db.select().from(agentStorefrontContinuations)
    .where(eq(agentStorefrontContinuations.id, continuationId))
    .get();
  if (!continuation) throw new NotFoundError("Secure storefront step not found.");
  const context = await loadContext(db, continuation.contextId);
  if (
    context.status !== "active"
    || context.closedAt
    || context.expiresAt <= now
    || continuation.status !== "pending"
    || continuation.expiresAt <= now
    || continuation.bootstrapCodeHash !== null
    || continuation.bootstrapClaimedAt === null
  ) {
    throw new ConflictError("This secure storefront step is no longer active.");
  }
  return { context, continuation };
}

export async function claimAgentStorefrontContinuationBootstrap(
  db: Database,
  continuationCode: string,
  now = new Date(),
): Promise<{
  id: string;
  kind: ContinuationRow["kind"];
  expiresAt: string;
}> {
  const continuationId = getAgentStorefrontBootstrapContinuationId(continuationCode);
  if (!continuationId) throw new UnauthorizedError("Secure storefront bootstrap is invalid or expired.");
  const codeHash = await hashAgentStorefrontBootstrapCode(continuationCode);
  const claimed = await db.update(agentStorefrontContinuations).set({
    bootstrapCodeHash: null,
    bootstrapClaimedAt: now,
    updatedAt: now,
  }).where(and(
    eq(agentStorefrontContinuations.id, continuationId),
    eq(agentStorefrontContinuations.status, "pending"),
    eq(agentStorefrontContinuations.bootstrapCodeHash, codeHash),
    isNull(agentStorefrontContinuations.bootstrapClaimedAt),
    gt(agentStorefrontContinuations.expiresAt, now),
    sql`EXISTS (
      SELECT 1 FROM ${agentStorefrontContexts}
      WHERE ${agentStorefrontContexts.id} = ${agentStorefrontContinuations.contextId}
        AND ${agentStorefrontContexts.status} = 'active'
        AND ${agentStorefrontContexts.closedAt} IS NULL
        AND ${agentStorefrontContexts.expiresAt} > unixepoch()
    )`,
  )).returning({
    id: agentStorefrontContinuations.id,
    kind: agentStorefrontContinuations.kind,
    expiresAt: agentStorefrontContinuations.expiresAt,
  }).get();
  if (!claimed) throw new UnauthorizedError("Secure storefront bootstrap is invalid or expired.");
  return {
    id: claimed.id,
    kind: claimed.kind,
    expiresAt: claimed.expiresAt.toISOString(),
  };
}

function customerProfile(row: typeof customers.$inferSelect) {
  const profileComplete = Boolean(row.name && row.phone && row.address && row.city && row.zone);
  return {
    customerId: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    city: row.city,
    zone: row.zone,
    area: row.area,
    cityName: row.cityName,
    zoneName: row.zoneName,
    areaName: row.areaName,
    profileComplete,
    needsProfileCompletion: !profileComplete,
  };
}

async function liveContextCustomer(
  db: Database,
  context: ContextRow,
): Promise<{ profile: ReturnType<typeof customerProfile>; session: CustomerSession } | null> {
  if (!context.customerSessionTokenHash) return null;
  const row = await db.select({ session: customerSessions, customer: customers })
    .from(customerSessions)
    .innerJoin(customers, eq(customerSessions.customerId, customers.id))
    .where(and(
      eq(customerSessions.tokenHash, context.customerSessionTokenHash),
      isNull(customerSessions.revokedAt),
      gt(customerSessions.expiresAt, nowSeconds()),
      isNull(customers.deletedAt),
    ))
    .get();
  if (!row) return null;
  const profile = customerProfile(row.customer);
  return {
    profile,
    session: {
      token: "",
      email: profile.email ?? "",
      name: profile.name,
      ...(profile.phone ? { phone: profile.phone } : {}),
      customerId: profile.customerId,
      address: profile.address,
      city: profile.city,
      zone: profile.zone,
      area: profile.area,
      cityName: profile.cityName,
      zoneName: profile.zoneName,
      areaName: profile.areaName,
      profileComplete: profile.profileComplete,
      needsProfileCompletion: profile.needsProfileCompletion,
      createdAt: row.session.createdAt * 1_000,
      expiresAt: row.session.expiresAt * 1_000,
    },
  };
}

async function requireLiveContextCustomer(
  db: Database,
  context: ContextRow,
): Promise<NonNullable<Awaited<ReturnType<typeof liveContextCustomer>>>> {
  const customer = await liveContextCustomer(db, context);
  if (!customer) throw new UnauthorizedError("Authorize a customer in the secure storefront tab first.");
  return customer;
}

export async function getHostedAgentStorefrontContinuation(
  db: Database,
  continuationId: string,
): Promise<{
  id: string;
  kind: ContinuationRow["kind"];
  status: "pending";
  orderId: string | null;
  expiresAt: string;
}> {
  const { continuation } = await loadHostedContinuation(db, continuationId);
  return {
    id: continuation.id,
    kind: continuation.kind,
    status: "pending",
    orderId: continuation.orderId,
    expiresAt: continuation.expiresAt.toISOString(),
  };
}

export async function getHostedAgentStorefrontContinuationStatus(
  db: Database,
  continuationId: string,
  now = new Date(),
): Promise<{
  id: string;
  kind: ContinuationRow["kind"];
  status: ContinuationRow["status"];
  orderId: string | null;
  expiresAt: string;
}> {
  let continuation = await db.select().from(agentStorefrontContinuations)
    .where(eq(agentStorefrontContinuations.id, continuationId))
    .get();
  if (!continuation) throw new NotFoundError("Secure storefront step not found.");
  if (continuation.bootstrapCodeHash !== null || continuation.bootstrapClaimedAt === null) {
    throw new UnauthorizedError("Secure storefront bootstrap is required.");
  }
  const context = await loadContext(db, continuation.contextId);
  if (
    continuation.status === "pending"
    && (
      continuation.expiresAt <= now
      || context.expiresAt <= now
      || context.status !== "active"
      || Boolean(context.closedAt)
    )
  ) {
    const expired = await db.update(agentStorefrontContinuations).set({
      status: "expired",
      bootstrapCodeHash: null,
      completedAt: now,
      updatedAt: now,
    }).where(and(
      eq(agentStorefrontContinuations.id, continuationId),
      eq(agentStorefrontContinuations.status, "pending"),
    )).returning().get();
    if (expired) continuation = expired;
  }
  return {
    id: continuation.id,
    kind: continuation.kind,
    status: continuation.status,
    orderId: continuation.orderId,
    expiresAt: continuation.expiresAt.toISOString(),
  };
}

export async function bindAgentStorefrontCustomerSession(
  db: Database,
  continuationId: string,
  customerSessionTokenHash: string,
  now = new Date(),
): Promise<{ contextId: string; customerId: string }> {
  const { context, continuation } = await loadHostedContinuation(db, continuationId, now);
  if (continuation.kind !== "customer_auth") {
    throw new ConflictError("This secure step is not a customer authorization.");
  }
  const customerSession = await db.select({ customerId: customerSessions.customerId })
    .from(customerSessions)
    .where(and(
      eq(customerSessions.tokenHash, customerSessionTokenHash),
      isNull(customerSessions.revokedAt),
      gt(customerSessions.expiresAt, nowSeconds(now)),
    ))
    .get();
  if (!customerSession) throw new UnauthorizedError("The verified customer session is unavailable.");
  const continuationGuard = buildBatchGuard(db, sql`EXISTS (
    SELECT 1 FROM ${agentStorefrontContinuations}
    WHERE ${agentStorefrontContinuations.id} = ${continuation.id}
      AND ${agentStorefrontContinuations.contextId} = ${context.id}
      AND ${agentStorefrontContinuations.kind} = 'customer_auth'
      AND ${agentStorefrontContinuations.status} = 'pending'
      AND ${agentStorefrontContinuations.expiresAt} > unixepoch()
  )`, "AGENT_STOREFRONT_CUSTOMER_CONTINUATION_CONFLICT") as SQLiteBatchItem;
  const contextGuard = buildBatchGuard(db, sql`EXISTS (
    SELECT 1 FROM ${agentStorefrontContexts}
    WHERE ${agentStorefrontContexts.id} = ${context.id}
      AND ${agentStorefrontContexts.status} = 'active'
      AND ${agentStorefrontContexts.closedAt} IS NULL
      AND ${agentStorefrontContexts.expiresAt} > unixepoch()
      AND ${agentStorefrontContexts.revision} = ${context.revision}
  )`, "AGENT_STOREFRONT_CUSTOMER_CONTEXT_CONFLICT") as SQLiteBatchItem;
  await safeBatch(db, [
    continuationGuard,
    contextGuard,
    db.update(agentStorefrontContexts).set({
      customerSessionTokenHash,
      revision: sql`${agentStorefrontContexts.revision} + 1`,
      lastUsedAt: now,
      updatedAt: now,
    }).where(and(
      eq(agentStorefrontContexts.id, context.id),
      eq(agentStorefrontContexts.revision, context.revision),
    )),
    db.update(agentStorefrontContinuations).set({
      status: "complete",
      bootstrapCodeHash: null,
      safeResultJson: JSON.stringify({ authenticated: true }),
      completedAt: now,
      updatedAt: now,
    }).where(and(
      eq(agentStorefrontContinuations.id, continuation.id),
      eq(agentStorefrontContinuations.status, "pending"),
    )),
  ] as SQLiteBatchItem[]);
  return { contextId: context.id, customerId: customerSession.customerId };
}

export async function bindAgentStorefrontRecoveredOrder(
  db: Database,
  continuationId: string,
  input: {
    orderId: string;
    authorityExpiresAt: Date;
    gateway: string;
    paymentType: string | null;
  },
  now = new Date(),
): Promise<{ contextId: string; orderId: string }> {
  const { context, continuation } = await loadHostedContinuation(db, continuationId, now);
  if (continuation.kind !== "payment_recovery" || continuation.orderId !== input.orderId) {
    throw new ConflictError("This secure step does not match the recovered order.");
  }
  const expiresAt = new Date(Math.min(context.expiresAt.getTime(), input.authorityExpiresAt.getTime()));
  if (expiresAt <= now) throw new ConflictError("Recovered order authority already expired.");
  await safeBatch(db, [
    buildBatchGuard(db, sql`EXISTS (
      SELECT 1 FROM ${agentStorefrontContinuations}
      WHERE ${agentStorefrontContinuations.id} = ${continuation.id}
        AND ${agentStorefrontContinuations.contextId} = ${context.id}
        AND ${agentStorefrontContinuations.kind} = 'payment_recovery'
        AND ${agentStorefrontContinuations.status} = 'pending'
        AND ${agentStorefrontContinuations.expiresAt} > unixepoch()
    )`, "AGENT_STOREFRONT_RECOVERY_CONTINUATION_CONFLICT") as SQLiteBatchItem,
    db.insert(agentStorefrontOrderGrants).values({
      contextId: context.id,
      orderId: input.orderId,
      authorityKind: "recovered",
      expiresAt,
      createdAt: now,
    }).onConflictDoUpdate({
      target: [agentStorefrontOrderGrants.contextId, agentStorefrontOrderGrants.orderId],
      set: { authorityKind: "recovered", expiresAt },
    }),
    db.update(agentStorefrontContinuations).set({
      status: "complete",
      bootstrapCodeHash: null,
      safeResultJson: JSON.stringify({
        recovered: true,
        orderId: input.orderId,
        gateway: input.gateway,
        paymentType: input.paymentType,
      }),
      completedAt: now,
      updatedAt: now,
    }).where(and(
      eq(agentStorefrontContinuations.id, continuation.id),
      eq(agentStorefrontContinuations.status, "pending"),
    )),
  ] as SQLiteBatchItem[]);
  return { contextId: context.id, orderId: input.orderId };
}

export async function markAgentStorefrontPaymentContinuationStarted(
  db: Database,
  continuationId: string,
  paymentAttemptId: string | null,
  now = new Date(),
): Promise<void> {
  const { continuation } = await loadHostedContinuation(db, continuationId, now);
  if (continuation.kind !== "payment") throw new ConflictError("This secure step is not a payment.");
  await db.update(agentStorefrontContinuations).set({
    paymentAttemptId,
    updatedAt: now,
  }).where(and(
    eq(agentStorefrontContinuations.id, continuation.id),
    eq(agentStorefrontContinuations.status, "pending"),
  ));
}

export async function failAgentStorefrontContinuation(
  db: Database,
  continuationId: string,
  now = new Date(),
): Promise<void> {
  await db.update(agentStorefrontContinuations).set({
    status: "failed",
    bootstrapCodeHash: null,
    safeResultJson: JSON.stringify({ retryable: true }),
    completedAt: now,
    updatedAt: now,
  }).where(and(
    eq(agentStorefrontContinuations.id, continuationId),
    eq(agentStorefrontContinuations.status, "pending"),
  ));
}

export async function refreshAgentStorefrontPaymentContinuation(
  db: Database,
  continuationId: string,
  now = new Date(),
): Promise<void> {
  const row = await db.select({
    continuation: agentStorefrontContinuations,
    paymentStatus: orders.paymentStatus,
  }).from(agentStorefrontContinuations)
    .leftJoin(orders, eq(agentStorefrontContinuations.orderId, orders.id))
    .where(eq(agentStorefrontContinuations.id, continuationId))
    .get();
  if (!row || row.continuation.kind !== "payment" || row.continuation.status !== "pending") return;
  if (row.continuation.expiresAt <= now) {
    await db.update(agentStorefrontContinuations).set({
      status: "expired", bootstrapCodeHash: null, completedAt: now, updatedAt: now,
    }).where(eq(agentStorefrontContinuations.id, continuationId));
    return;
  }
  const complete = row.paymentStatus === PaymentStatus.PAID || row.paymentStatus === PaymentStatus.PARTIAL;
  if (complete) {
    await db.update(agentStorefrontContinuations).set({
      status: "complete",
      bootstrapCodeHash: null,
      safeResultJson: JSON.stringify({ paid: true, orderId: row.continuation.orderId }),
      completedAt: now,
      updatedAt: now,
    }).where(and(
      eq(agentStorefrontContinuations.id, continuationId),
      eq(agentStorefrontContinuations.status, "pending"),
    ));
  }
}

export async function getLatestPaymentAttemptId(
  db: Database,
  orderId: string,
): Promise<string | null> {
  const row = await db.select({ id: paymentSessionAttempts.id })
    .from(paymentSessionAttempts)
    .where(eq(paymentSessionAttempts.orderId, orderId))
    .orderBy(desc(paymentSessionAttempts.updatedAt))
    .get();
  return row?.id ?? null;
}

export async function logoutAgentStorefrontCustomer(
  db: Database,
  grantId: string,
  contextId: string,
  expectedRevision: number,
  now = new Date(),
): Promise<{ revision: number; authenticated: false }> {
  const context = await loadOwnedActiveContext(db, grantId, contextId, now);
  if (context.revision !== expectedRevision) throw new ConflictError("Storefront context revision changed.");
  const activeGuard = and(
    eq(agentStorefrontContexts.id, contextId),
    eq(agentStorefrontContexts.grantId, grantId),
    eq(agentStorefrontContexts.status, "active"),
    eq(agentStorefrontContexts.revision, expectedRevision),
    gt(agentStorefrontContexts.expiresAt, now),
  );
  await safeBatch(db, [
    buildBatchGuard(db, sql`EXISTS (
      SELECT 1 FROM ${agentStorefrontContexts} WHERE ${activeGuard}
    )`, "AGENT_STOREFRONT_LOGOUT_CONFLICT"),
    ...(context.customerSessionTokenHash ? [
      db.update(customerSessions).set({
        revokedAt: nowSeconds(now),
        updatedAt: nowSeconds(now),
      }).where(and(
        eq(customerSessions.tokenHash, context.customerSessionTokenHash),
        isNull(customerSessions.revokedAt),
      )),
    ] : []),
    db.update(agentStorefrontContexts).set({
      customerSessionTokenHash: null,
      revision: sql`${agentStorefrontContexts.revision} + 1`,
      lastUsedAt: now,
      updatedAt: now,
    }).where(activeGuard),
  ] as SQLiteBatchItem[]);
  return { revision: expectedRevision + 1, authenticated: false };
}

export async function getAgentStorefrontCustomerProfile(
  db: Database,
  grantId: string,
  contextId: string,
) {
  const context = await loadOwnedActiveContext(db, grantId, contextId);
  return (await requireLiveContextCustomer(db, context)).profile;
}

export async function updateAgentStorefrontCustomerProfile(
  db: Database,
  grantId: string,
  contextId: string,
  updates: Record<string, string | undefined>,
) {
  const context = await loadOwnedActiveContext(db, grantId, contextId);
  const customer = await requireLiveContextCustomer(db, context);
  const result = await updateCustomerProfile(db, customer.session, updates);
  return result.customer;
}

export async function listAgentStorefrontCustomerOrders(
  db: Database,
  grantId: string,
  contextId: string,
  options: { cursor?: string; limit?: number },
) {
  const context = await loadOwnedActiveContext(db, grantId, contextId);
  const customer = await requireLiveContextCustomer(db, context);
  return getCustomerOrders(db, customer.profile.customerId, options);
}

export async function getAgentStorefrontCustomerOrder(
  db: Database,
  grantId: string,
  contextId: string,
  orderId: string,
) {
  const context = await loadOwnedActiveContext(db, grantId, contextId);
  const customer = await requireLiveContextCustomer(db, context);
  const order = await getCustomerOwnedOrderForDetail(db, customer.profile.customerId, orderId);
  return getCustomerOrderDetailForOrder(db, order);
}

export async function getAgentStorefrontOrderAccess(
  db: Database,
  grantId: string,
  contextId: string,
  orderId: string,
): Promise<{ kind: "customer"; customerId: string } | { kind: "grant" }> {
  const context = await loadOwnedActiveContext(db, grantId, contextId);
  const customer = await liveContextCustomer(db, context);
  if (customer) {
    const owned = await db.select({ id: orders.id }).from(orders)
      .where(and(
        eq(orders.id, orderId),
        eq(orders.accountOwnerCustomerId, customer.profile.customerId),
        isNull(orders.deletedAt),
      ))
      .get();
    if (owned) return { kind: "customer", customerId: customer.profile.customerId };
  }
  const grant = await db.select({ orderId: agentStorefrontOrderGrants.orderId })
    .from(agentStorefrontOrderGrants)
    .where(and(
      eq(agentStorefrontOrderGrants.contextId, contextId),
      eq(agentStorefrontOrderGrants.orderId, orderId),
      gt(agentStorefrontOrderGrants.expiresAt, new Date()),
    ))
    .get();
  if (!grant) throw new UnauthorizedError("This context is not authorized for that order.");
  return { kind: "grant" };
}

export async function getAgentStorefrontReceipt(
  db: Database,
  grantId: string,
  contextId: string,
  orderId: string,
) {
  await getAgentStorefrontOrderAccess(db, grantId, contextId, orderId);
  const order = await db.select({
    id: orders.id,
    customerId: orders.customerId,
    customerName: orders.customerName,
    shippingAddress: orders.shippingAddress,
    totalAmount: orders.totalAmount,
    shippingCharge: orders.shippingCharge,
    discountAmount: orders.discountAmount,
    currencyCode: orders.currencyCode,
    currencyDecimalPlaces: orders.currencyDecimalPlaces,
    subtotalAmountMinor: orders.subtotalAmountMinor,
    shippingAmountMinor: orders.shippingAmountMinor,
    discountAmountMinor: orders.discountAmountMinor,
    taxAmountMinor: orders.taxAmountMinor,
    totalAmountMinor: orders.totalAmountMinor,
    taxLabel: orders.taxLabel,
    pricesIncludeTax: orders.pricesIncludeTax,
    city: orders.city,
    zone: orders.zone,
    area: orders.area,
    cityName: orders.cityName,
    zoneName: orders.zoneName,
    areaName: orders.areaName,
    status: orders.status,
    paymentMethod: orders.paymentMethod,
    paymentStatus: orders.paymentStatus,
    paidAmount: orders.paidAmount,
    balanceDue: orders.balanceDue,
    fulfillmentStatus: orders.fulfillmentStatus,
    createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
    updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`,
  }).from(orders)
    .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
    .get();
  if (!order) throw new NotFoundError("Order receipt not found.");
  const [items, support] = await Promise.all([
    db.select({
      id: orderItems.id,
      productId: orderItems.productId,
      variantId: orderItems.variantId,
      quantity: orderItems.quantity,
      price: orderItems.price,
      productName: orderItems.productName,
      productImageObjectKey: media.objectKey,
      productImageStatus: media.status,
      variantLabel: orderItems.variantLabel,
      unitPriceMinor: orderItems.unitPriceMinor,
      lineSubtotalMinor: orderItems.lineSubtotalMinor,
      discountAmountMinor: orderItems.discountAmountMinor,
      taxableAmountMinor: orderItems.taxableAmountMinor,
      taxAmountMinor: orderItems.taxAmountMinor,
    }).from(orderItems)
      .leftJoin(media, eq(media.id, orderItems.productImageMediaId))
      .where(eq(orderItems.orderId, orderId)),
    getReceiptOrderSupportRequestStateForOrder(db, order),
  ]);
  return {
    ...order,
    createdAt: order.createdAt ? new Date(order.createdAt * 1_000).toISOString() : null,
    updatedAt: order.updatedAt ? new Date(order.updatedAt * 1_000).toISOString() : null,
    items: items.map(({ productImageObjectKey, productImageStatus, ...item }) => ({
      ...item,
      productImage: productImageObjectKey
        && (productImageStatus === "ready" || productImageStatus === "trashed")
        ? getCurrentPublicMediaUrl(productImageObjectKey)
        : null,
    })),
    supportRequests: support.supportRequests,
    supportRequestActions: support.supportRequestActions,
    supportRequestIntro: support.supportRequestIntro,
  };
}

export async function createAgentStorefrontOrderSupportRequest(
  db: Database,
  grantId: string,
  contextId: string,
  orderId: string,
  input: { type: "cancel_pre_shipment" | "return" | "refund"; reason: string; message?: string | null },
) {
  const access = await getAgentStorefrontOrderAccess(db, grantId, contextId, orderId);
  const order = await db.select({
    id: orders.id,
    customerId: orders.customerId,
    status: orders.status,
    paymentStatus: orders.paymentStatus,
    fulfillmentStatus: orders.fulfillmentStatus,
    paidAmount: orders.paidAmount,
  }).from(orders).where(and(eq(orders.id, orderId), isNull(orders.deletedAt))).get();
  if (!order) throw new NotFoundError("Order not found.");
  const state = await getReceiptOrderSupportRequestStateForOrder(db, order);
  const normalizedReason = input.reason.trim();
  const normalizedMessage = input.message?.trim() || null;
  const replay = state.supportRequests.find((request) => (
    request.active
    && request.type === input.type
    && request.reason === normalizedReason
    && (request.message?.trim() || null) === normalizedMessage
  ));
  if (replay) {
    return {
      request: replay,
      supportRequests: state.supportRequests,
      supportRequestActions: state.supportRequestActions,
      supportRequestIntro: state.supportRequestIntro,
    };
  }
  return access.kind === "customer"
    ? createCustomerOrderSupportRequest(db, access.customerId, orderId, {
        ...input,
        reason: normalizedReason,
        message: normalizedMessage,
      })
    : createReceiptOrderSupportRequest(db, orderId, {
        ...input,
        reason: normalizedReason,
        message: normalizedMessage,
      });
}

export async function assertHostedContinuationOrderAccess(
  db: Database,
  continuationId: string,
): Promise<{ contextId: string; orderId: string; customerId: string | null }> {
  const { context, continuation } = await loadHostedContinuation(db, continuationId);
  if (continuation.kind !== "payment" || !continuation.orderId) {
    throw new ConflictError("This secure step is not an order payment.");
  }
  const customer = await liveContextCustomer(db, context);
  if (customer) {
    const owned = await db.select({ id: orders.id }).from(orders).where(and(
      eq(orders.id, continuation.orderId),
      eq(orders.accountOwnerCustomerId, customer.profile.customerId),
      isNull(orders.deletedAt),
    )).get();
    if (owned) return {
      contextId: context.id,
      orderId: continuation.orderId,
      customerId: customer.profile.customerId,
    };
  }
  const grant = await db.select({ orderId: agentStorefrontOrderGrants.orderId })
    .from(agentStorefrontOrderGrants).where(and(
      eq(agentStorefrontOrderGrants.contextId, context.id),
      eq(agentStorefrontOrderGrants.orderId, continuation.orderId),
      gt(agentStorefrontOrderGrants.expiresAt, new Date()),
    )).get();
  if (!grant) throw new UnauthorizedError("This secure step no longer owns the order.");
  return { contextId: context.id, orderId: continuation.orderId, customerId: null };
}

export async function getContinuationContextId(
  db: Database,
  continuationId: string,
): Promise<string> {
  return (await loadHostedContinuation(db, continuationId)).context.id;
}
