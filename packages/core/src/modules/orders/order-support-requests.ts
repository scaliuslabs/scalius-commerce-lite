import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import {
  deliveryShipments,
  FulfillmentStatus,
  OrderStatus,
  orderSupportRequestEvents,
  orderSupportRequests,
  orders,
  PaymentStatus,
} from "@scalius/database/schema";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import {
  listOrderRefundAttempts,
  summarizeActiveRefundOperation,
} from "../payments/refund-attempt-visibility";
import {
  CUSTOMER_REQUEST_ACTION_COPY,
  CUSTOMER_REQUEST_STATE_REASONS,
  CUSTOMER_REQUEST_TYPES,
  getCustomerRequestIntro,
  getCustomerRequestPolicy,
  projectCustomerRequestActions,
  type CustomerRequestPolicy,
  type CustomerRequestType,
} from "../settings/customer-request-policy";

export const CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES = CUSTOMER_REQUEST_TYPES;

export type CustomerOrderSupportRequestType = CustomerRequestType;

export const ORDER_SUPPORT_REQUEST_STATUSES = [
  "submitted",
  "under_review",
  "approved",
  "rejected",
  "withdrawn",
  "completed",
] as const;

export type OrderSupportRequestStatus =
  typeof ORDER_SUPPORT_REQUEST_STATUSES[number];

export const ADMIN_ORDER_SUPPORT_REQUEST_STATUSES = [
  "under_review",
  "approved",
  "rejected",
  "completed",
] as const;

export type AdminOrderSupportRequestStatus =
  typeof ADMIN_ORDER_SUPPORT_REQUEST_STATUSES[number];

type SupportRequestSeverity = "info" | "success" | "warning" | "danger";

export interface OrderSupportRequestView {
  id: string;
  orderId: string;
  customerId: string | null;
  type: CustomerOrderSupportRequestType;
  status: string;
  active: boolean;
  severity: SupportRequestSeverity;
  label: string;
  actionLabel: string;
  reason: string;
  message: string | null;
  returnId: string | null;
  submittedAt: string | null;
  resolvedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CustomerOrderSupportRequestAction {
  type: CustomerOrderSupportRequestType;
  label: string;
  description: string;
  eligible: boolean;
  disabledReason: string | null;
}

export interface CreateCustomerOrderSupportRequestInput {
  type: CustomerOrderSupportRequestType;
  reason: string;
  message?: string | null;
}

export interface UpdateAdminOrderSupportRequestStatusInput {
  status: AdminOrderSupportRequestStatus;
  note?: string | null;
  actorId?: string | null;
  returnId?: string | null;
}

export interface AdminOrderSupportRequestTransition {
  changed: boolean;
  active: boolean;
  terminal: boolean;
}

interface SupportRequestRow {
  id: string;
  orderId: string;
  customerId: string | null;
  type: string;
  status: string;
  reason: string;
  message: string | null;
  activeKey: string | null;
  returnId: string | null;
  submittedAt: number | null;
  resolvedAt: number | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export type SupportRequestActionOrderState = {
  id: string;
  customerId?: string | null;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  paidAmount: number | null | undefined;
};

type SupportRequestActionContext = {
  hasShipment: boolean;
  hasActiveRefundOperation: boolean;
  activeRequestTypes: ReadonlySet<string>;
};

const ACTIVE_SUPPORT_REQUEST_STATUSES = new Set<string>([
  "submitted",
  "under_review",
  "approved",
]);

const TERMINAL_SUPPORT_REQUEST_STATUSES = new Set<string>([
  "rejected",
  "withdrawn",
  "completed",
]);

const SUPPORT_REQUEST_TYPE_SET = new Set<string>(CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES);
const ORDER_SUPPORT_REQUEST_STATUS_SET = new Set<string>(ORDER_SUPPORT_REQUEST_STATUSES);
const ADMIN_ORDER_SUPPORT_REQUEST_STATUS_SET = new Set<string>(ADMIN_ORDER_SUPPORT_REQUEST_STATUSES);

const ADMIN_SUPPORT_REQUEST_TRANSITIONS: Record<string, readonly AdminOrderSupportRequestStatus[]> = {
  submitted: ["under_review", "approved", "rejected", "completed"],
  under_review: ["approved", "rejected", "completed"],
  approved: ["completed"],
};

const supportRequestSelectFields = {
  id: orderSupportRequests.id,
  orderId: orderSupportRequests.orderId,
  customerId: orderSupportRequests.customerId,
  type: orderSupportRequests.type,
  status: orderSupportRequests.status,
  reason: orderSupportRequests.reason,
  message: orderSupportRequests.message,
  activeKey: orderSupportRequests.activeKey,
  returnId: orderSupportRequests.returnId,
  submittedAt: sql<number | null>`CAST(${orderSupportRequests.submittedAt} AS INTEGER)`,
  resolvedAt: sql<number | null>`CAST(${orderSupportRequests.resolvedAt} AS INTEGER)`,
  createdAt: sql<number | null>`CAST(${orderSupportRequests.createdAt} AS INTEGER)`,
  updatedAt: sql<number | null>`CAST(${orderSupportRequests.updatedAt} AS INTEGER)`,
};

const STATUS_COPY: Record<string, { label: string; severity: SupportRequestSeverity }> = {
  submitted: { label: "Submitted", severity: "info" },
  under_review: { label: "Under review", severity: "warning" },
  approved: { label: "Approved", severity: "success" },
  rejected: { label: "Rejected", severity: "danger" },
  withdrawn: { label: "Withdrawn", severity: "info" },
  completed: { label: "Completed", severity: "success" },
};

const PRE_SHIPMENT_CANCEL_STATUSES = new Set<string>([
  OrderStatus.PENDING,
  OrderStatus.PROCESSING,
  OrderStatus.CONFIRMED,
]);

const RETURN_REQUEST_STATUSES = new Set<string>([
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
]);

const REFUND_REQUEST_STATUSES = new Set<string>([
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
  OrderStatus.RETURNED,
  OrderStatus.PARTIALLY_REFUNDED,
]);
const REFUNDABLE_PAYMENT_STATUSES = new Set<string>([
  PaymentStatus.PAID,
  PaymentStatus.PARTIAL,
]);

function timestampToIso(timestamp: number | null | undefined): string | null {
  if (!timestamp) return null;
  return new Date(timestamp * 1000).toISOString();
}

function normalizeSupportRequestType(type: string): CustomerOrderSupportRequestType {
  if (SUPPORT_REQUEST_TYPE_SET.has(type)) return type as CustomerOrderSupportRequestType;
  return "refund";
}

function isSupportRequestType(type: string): type is CustomerOrderSupportRequestType {
  return SUPPORT_REQUEST_TYPE_SET.has(type);
}

function normalizeAdminSupportRequestStatus(
  status: string,
): AdminOrderSupportRequestStatus {
  if (ADMIN_ORDER_SUPPORT_REQUEST_STATUS_SET.has(status)) {
    return status as AdminOrderSupportRequestStatus;
  }
  throw new ValidationError("Unsupported support request status.");
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique|SQLITE_CONSTRAINT/i.test(error.message);
}

export function getOrderSupportRequestTypeLabel(type: string): string {
  return isSupportRequestType(type)
    ? CUSTOMER_REQUEST_ACTION_COPY[type].label
    : "Support request";
}

export function getOrderSupportRequestStatusLabel(status: string): string {
  return STATUS_COPY[status]?.label ?? status;
}

function openRequestReason(activeRequestTypes: ReadonlySet<string>): string {
  const [type] = [...activeRequestTypes];
  const copy = type && isSupportRequestType(type)
    ? CUSTOMER_REQUEST_ACTION_COPY[type]
    : null;
  return copy
    ? `${copy.label} is already open for this order.`
    : "A support request is already open for this order.";
}

function createAction(
  type: CustomerOrderSupportRequestType,
  eligible: boolean,
  disabledReason: string | null = null,
): CustomerOrderSupportRequestAction {
  const copy = CUSTOMER_REQUEST_ACTION_COPY[type];
  return {
    type,
    label: copy.requestLabel,
    description: copy.description,
    eligible,
    disabledReason,
  };
}

export function formatOrderSupportRequest(row: SupportRequestRow): OrderSupportRequestView {
  const type = normalizeSupportRequestType(row.type);
  const status = STATUS_COPY[row.status] ?? { label: row.status, severity: "info" as const };
  return {
    id: row.id,
    orderId: row.orderId,
    customerId: row.customerId,
    type,
    status: row.status,
    active: Boolean(row.activeKey) && ACTIVE_SUPPORT_REQUEST_STATUSES.has(row.status),
    severity: status.severity,
    label: `${CUSTOMER_REQUEST_ACTION_COPY[type].label} ${status.label.toLowerCase()}`,
    actionLabel: CUSTOMER_REQUEST_ACTION_COPY[type].requestLabel,
    reason: row.reason,
    message: row.message,
    returnId: row.returnId,
    submittedAt: timestampToIso(row.submittedAt),
    resolvedAt: timestampToIso(row.resolvedAt),
    createdAt: timestampToIso(row.createdAt),
    updatedAt: timestampToIso(row.updatedAt),
  };
}

export function getActiveSupportRequestTypes(
  requests: OrderSupportRequestView[],
): ReadonlySet<CustomerOrderSupportRequestType> {
  return new Set(requests.filter((request) => request.active).map((request) => request.type));
}

export function getAdminOrderSupportRequestTransition(
  currentStatus: string,
  targetStatus: string,
): AdminOrderSupportRequestTransition {
  const target = normalizeAdminSupportRequestStatus(targetStatus);
  if (!ORDER_SUPPORT_REQUEST_STATUS_SET.has(currentStatus)) {
    throw new ConflictError("This support request is in an unknown state. Please refresh.");
  }

  if (currentStatus === target) {
    return {
      changed: false,
      active: ACTIVE_SUPPORT_REQUEST_STATUSES.has(currentStatus),
      terminal: TERMINAL_SUPPORT_REQUEST_STATUSES.has(currentStatus),
    };
  }

  if (TERMINAL_SUPPORT_REQUEST_STATUSES.has(currentStatus)) {
    throw new ConflictError("This support request has already been settled.");
  }

  const allowedTargets = ADMIN_SUPPORT_REQUEST_TRANSITIONS[currentStatus] ?? [];
  if (!allowedTargets.includes(target)) {
    throw new ValidationError("This support request cannot move to that status.");
  }

  return {
    changed: true,
    active: ACTIVE_SUPPORT_REQUEST_STATUSES.has(target),
    terminal: TERMINAL_SUPPORT_REQUEST_STATUSES.has(target),
  };
}

export function getCustomerOrderSupportRequestActions(
  order: SupportRequestActionOrderState,
  context: SupportRequestActionContext,
): CustomerOrderSupportRequestAction[] {
  const openRequestCount = context.activeRequestTypes.size;
  if (openRequestCount > 0) {
    const reason = openRequestReason(context.activeRequestTypes);
    return CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES.map((type) => createAction(type, false, reason));
  }

  if (context.hasActiveRefundOperation) {
    const reason = "A refund is already being processed for this order.";
    return CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES.map((type) => createAction(type, false, reason));
  }

  const canCancel =
    PRE_SHIPMENT_CANCEL_STATUSES.has(order.status) &&
    order.fulfillmentStatus === FulfillmentStatus.PENDING &&
    !context.hasShipment;
  const paidAmount = Number(order.paidAmount ?? 0);
  const canRequestRefund =
    paidAmount > 0 &&
    REFUNDABLE_PAYMENT_STATUSES.has(order.paymentStatus) &&
    REFUND_REQUEST_STATUSES.has(order.status);

  return [
    createAction(
      "cancel_pre_shipment",
      canCancel,
      canCancel ? null : CUSTOMER_REQUEST_STATE_REASONS.cancellationUnavailable,
    ),
    createAction(
      "return",
      RETURN_REQUEST_STATUSES.has(order.status),
      RETURN_REQUEST_STATUSES.has(order.status)
        ? null
        : CUSTOMER_REQUEST_STATE_REASONS.returnUnavailable,
    ),
    createAction(
      "refund",
      canRequestRefund,
      canRequestRefund
        ? null
        : CUSTOMER_REQUEST_STATE_REASONS.refundUnavailable,
    ),
  ];
}

export function applyCustomerRequestPolicyToSupportActions(
  policy: CustomerRequestPolicy,
  actions: readonly CustomerOrderSupportRequestAction[],
  options: { includeHidden?: boolean } = {},
): CustomerOrderSupportRequestAction[] {
  return projectCustomerRequestActions(policy, actions, options).map((action) => ({
    type: action.type,
    label: action.label,
    description: action.description,
    eligible: action.eligible,
    disabledReason: action.disabledReason,
  }));
}

export async function listOrderSupportRequests(
  db: Database,
  orderId: string,
): Promise<OrderSupportRequestView[]> {
  const rows = await db
    .select(supportRequestSelectFields)
    .from(orderSupportRequests)
    .where(eq(orderSupportRequests.orderId, orderId))
    .orderBy(desc(orderSupportRequests.createdAt), desc(orderSupportRequests.id));

  return rows.map(formatOrderSupportRequest);
}

export async function updateAdminOrderSupportRequestStatus(
  db: Database,
  orderId: string,
  requestId: string,
  input: UpdateAdminOrderSupportRequestStatusInput,
): Promise<{
  request: OrderSupportRequestView;
  supportRequests: OrderSupportRequestView[];
  statusChanged: boolean;
  previousStatus: string | null;
  newStatus: string;
}> {
  const targetStatus = normalizeAdminSupportRequestStatus(input.status);
  const note = input.note?.trim() || null;
  if (note && note.length > 1000) {
    throw new ValidationError("Resolution note must be 1000 characters or less.");
  }

  const current = await db
    .select(supportRequestSelectFields)
    .from(orderSupportRequests)
    .where(and(
      eq(orderSupportRequests.id, requestId),
      eq(orderSupportRequests.orderId, orderId),
    ))
    .get();

  if (!current) {
    throw new NotFoundError("Support request not found");
  }

  const transition = getAdminOrderSupportRequestTransition(current.status, targetStatus);
  if (!transition.changed) {
    if (input.returnId && current.returnId !== input.returnId) {
      const linked = await db.update(orderSupportRequests).set({
        returnId: input.returnId,
        updatedAt: sql`unixepoch()`,
      }).where(and(
        eq(orderSupportRequests.id, requestId),
        eq(orderSupportRequests.orderId, orderId),
        isNull(orderSupportRequests.returnId),
      )).returning(supportRequestSelectFields);
      if (linked[0]) current.returnId = linked[0].returnId;
    }
    return {
      request: formatOrderSupportRequest(current),
      supportRequests: await listOrderSupportRequests(db, orderId),
      statusChanged: false,
      previousStatus: current.status,
      newStatus: current.status,
    };
  }

  const activeKey = transition.active ? `order:${orderId}` : null;
  let updatedRows: SupportRequestRow[];
  try {
    updatedRows = await db
      .update(orderSupportRequests)
      .set({
        status: targetStatus,
        returnId: input.returnId ?? current.returnId,
        activeKey,
        resolvedAt: transition.terminal ? sql`unixepoch()` : null,
        updatedAt: sql`unixepoch()`,
      })
      .where(and(
        eq(orderSupportRequests.id, requestId),
        eq(orderSupportRequests.orderId, orderId),
        eq(orderSupportRequests.status, current.status),
      ))
      .returning(supportRequestSelectFields);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ConflictError("Another support request is already open for this order.");
    }
    throw error;
  }

  const updated = updatedRows[0];
  if (!updated) {
    throw new ConflictError("Support request changed while you were resolving it. Please refresh.");
  }

  await db.insert(orderSupportRequestEvents).values({
    id: `osre_${nanoid(16)}`,
    requestId,
    orderId,
    customerId: current.customerId,
    actorType: "admin",
    actorId: input.actorId ?? null,
    eventType: "status_updated",
    fromStatus: current.status,
    toStatus: targetStatus,
    note,
    createdAt: sql`unixepoch()`,
  });

  return {
    request: formatOrderSupportRequest(updated),
    supportRequests: await listOrderSupportRequests(db, orderId),
    statusChanged: true,
    previousStatus: current.status,
    newStatus: targetStatus,
  };
}

export async function createCustomerOrderSupportRequest(
  db: Database,
  customerId: string,
  orderId: string,
  input: CreateCustomerOrderSupportRequestInput,
): Promise<{
  request: OrderSupportRequestView;
  supportRequests: OrderSupportRequestView[];
  supportRequestActions: CustomerOrderSupportRequestAction[];
  supportRequestIntro: string;
}> {
  return createVerifiedOrderSupportRequest(db, orderId, input, {
    actorType: "customer",
    actorId: customerId,
    expectedCustomerId: customerId,
  });
}

export async function createReceiptOrderSupportRequest(
  db: Database,
  orderId: string,
  input: CreateCustomerOrderSupportRequestInput,
): Promise<{
  request: OrderSupportRequestView;
  supportRequests: OrderSupportRequestView[];
  supportRequestActions: CustomerOrderSupportRequestAction[];
  supportRequestIntro: string;
}> {
  return createVerifiedOrderSupportRequest(db, orderId, input, {
    actorType: "guest_receipt",
    actorId: null,
  });
}

export async function getReceiptOrderSupportRequestState(
  db: Database,
  orderId: string,
): Promise<{
  supportRequests: OrderSupportRequestView[];
  supportRequestActions: CustomerOrderSupportRequestAction[];
  supportRequestIntro: string;
}> {
  const order = await selectSupportRequestOrderState(db, orderId);
  if (!order) {
    throw new NotFoundError("Order not found");
  }
  return getReceiptOrderSupportRequestStateForOrder(db, order);
}

export async function getReceiptOrderSupportRequestStateForOrder(
  db: Database,
  order: SupportRequestActionOrderState,
): Promise<{
  supportRequests: OrderSupportRequestView[];
  supportRequestActions: CustomerOrderSupportRequestAction[];
  supportRequestIntro: string;
}> {
  const state = await buildOrderSupportRequestState(db, order);
  return {
    supportRequests: state.supportRequests,
    supportRequestActions: state.supportRequestActions,
    supportRequestIntro: state.supportRequestIntro,
  };
}

type SupportRequestActorContext = {
  actorType: "customer" | "guest_receipt";
  actorId: string | null;
  expectedCustomerId?: string;
};

async function createVerifiedOrderSupportRequest(
  db: Database,
  orderId: string,
  input: CreateCustomerOrderSupportRequestInput,
  actor: SupportRequestActorContext,
): Promise<{
  request: OrderSupportRequestView;
  supportRequests: OrderSupportRequestView[];
  supportRequestActions: CustomerOrderSupportRequestAction[];
  supportRequestIntro: string;
}> {
  if (!isSupportRequestType(input.type)) {
    throw new ValidationError("Unsupported support request type.");
  }

  const reason = input.reason.trim();
  const message = input.message?.trim() || null;
  if (reason.length < 3 || reason.length > 500) {
    throw new ValidationError("Please enter a reason between 3 and 500 characters.");
  }
  if (message && message.length > 1000) {
    throw new ValidationError("Request details must be 1000 characters or less.");
  }

  const order = await selectSupportRequestOrderState(db, orderId, actor.expectedCustomerId);

  if (!order) {
    throw new NotFoundError("Order not found");
  }

  const state = await buildOrderSupportRequestState(db, order);
  const activeRequestTypes = getActiveSupportRequestTypes(state.supportRequests);
  const actions = state.allSupportRequestActions;
  const selectedAction = actions.find((action) => action.type === input.type);
  if (!selectedAction?.eligible) {
    const reasonText = selectedAction?.disabledReason ?? "This request is not available for the current order state.";
    if (activeRequestTypes.size > 0 || state.hasActiveRefundOperation) {
      throw new ConflictError(reasonText);
    }
    throw new ValidationError(reasonText);
  }

  const requestId = `osr_${nanoid(16)}`;
  const activeKey = `order:${orderId}`;
  const requestCustomerId = actor.actorType === "customer"
    ? actor.expectedCustomerId ?? null
    : order.customerId ?? null;

  try {
    await db.batch([
      db.insert(orderSupportRequests).values({
        id: requestId,
        orderId,
        customerId: requestCustomerId,
        type: input.type,
        status: "submitted",
        reason,
        message,
        activeKey,
        submittedAt: sql`unixepoch()`,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      }),
      db.insert(orderSupportRequestEvents).values({
        id: `osre_${nanoid(16)}`,
        requestId,
        orderId,
        customerId: requestCustomerId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        eventType: "submitted",
        fromStatus: null,
        toStatus: "submitted",
        note: reason,
        createdAt: sql`unixepoch()`,
      }),
    ] as Parameters<Database["batch"]>[0]);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ConflictError("A support request is already open for this order.");
    }
    throw error;
  }

  const updatedSupportRequests = await listOrderSupportRequests(db, orderId);
  const request = updatedSupportRequests.find((item) => item.id === requestId);
  if (!request) {
    throw new ConflictError("Support request was recorded, but could not be read back. Please refresh.");
  }

  return {
    request,
    supportRequests: updatedSupportRequests,
    supportRequestActions: applyCustomerRequestPolicyToSupportActions(
      state.policy,
      getCustomerOrderSupportRequestActions(order, {
        hasShipment: state.hasShipment,
        hasActiveRefundOperation: state.hasActiveRefundOperation,
        activeRequestTypes: getActiveSupportRequestTypes(updatedSupportRequests),
      }),
    ),
    supportRequestIntro: state.supportRequestIntro,
  };
}

async function selectSupportRequestOrderState(
  db: Database,
  orderId: string,
  expectedCustomerId?: string,
): Promise<SupportRequestActionOrderState | undefined> {
  return db
    .select({
      id: orders.id,
      customerId: orders.customerId,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      fulfillmentStatus: orders.fulfillmentStatus,
      paidAmount: orders.paidAmount,
    })
    .from(orders)
    .where(expectedCustomerId
      ? and(
        eq(orders.id, orderId),
        eq(orders.customerId, expectedCustomerId),
        isNull(orders.deletedAt),
      )
      : and(
        eq(orders.id, orderId),
        isNull(orders.deletedAt),
      ))
    .get();
}

async function buildOrderSupportRequestState(
  db: Database,
  order: SupportRequestActionOrderState,
): Promise<{
  supportRequests: OrderSupportRequestView[];
  supportRequestActions: CustomerOrderSupportRequestAction[];
  allSupportRequestActions: CustomerOrderSupportRequestAction[];
  supportRequestIntro: string;
  hasShipment: boolean;
  hasActiveRefundOperation: boolean;
  policy: CustomerRequestPolicy;
}> {
  const [shipmentRows, supportRequests, refundAttemptViews, policy] = await Promise.all([
    db
      .select({ id: deliveryShipments.id })
      .from(deliveryShipments)
      .where(eq(deliveryShipments.orderId, order.id))
      .limit(1),
    listOrderSupportRequests(db, order.id),
    listOrderRefundAttempts(db, order.id, { audience: "customer" }),
    getCustomerRequestPolicy(db),
  ]);
  const activeRefundOperation = summarizeActiveRefundOperation(refundAttemptViews, "customer");
  const activeRequestTypes = getActiveSupportRequestTypes(supportRequests);
  const baseActions = getCustomerOrderSupportRequestActions(order, {
    hasShipment: shipmentRows.length > 0,
    hasActiveRefundOperation: Boolean(activeRefundOperation),
    activeRequestTypes,
  });
  return {
    supportRequests,
    supportRequestActions: applyCustomerRequestPolicyToSupportActions(policy, baseActions),
    allSupportRequestActions: applyCustomerRequestPolicyToSupportActions(
      policy,
      baseActions,
      { includeHidden: true },
    ),
    supportRequestIntro: getCustomerRequestIntro(policy),
    hasShipment: shipmentRows.length > 0,
    hasActiveRefundOperation: Boolean(activeRefundOperation),
    policy,
  };
}
