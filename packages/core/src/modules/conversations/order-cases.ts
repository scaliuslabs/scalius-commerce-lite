// Support requests as structured cases on the order thread (Wave A §4.2).
// Moved from orders/order-support-requests.ts: the case keeps its
// one-active-per-order key, return link, refund-blocking rules and merchant
// policy (read side still in `orders`), and gains `conversation_id`. The
// buyer's words become the first public message; status changes become event
// lines. One batch: case row, thread CAS and messages commit together.
//
// C5: a case is a record for staff review. It never mutates payments, stock,
// delivery or order status (enforced by scripts/check-source-policies.mjs).

import type { Database } from "@scalius/database/client";
import { orderSupportRequests } from "@scalius/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";
import {
  applyCustomerRequestPolicyToSupportActions,
  buildOrderSupportRequestState,
  formatOrderSupportRequest,
  getActiveSupportRequestTypes,
  getAdminOrderSupportRequestTransition,
  getCustomerOrderSupportRequestActions,
  isSupportRequestType,
  listOrderSupportRequests,
  normalizeAdminSupportRequestStatus,
  recordOrderEvent,
  selectSupportRequestOrderState,
  supportRequestSelectFields,
  type CreateCustomerOrderSupportRequestInput,
  type CustomerOrderSupportRequestAction,
  type OrderSupportRequestView,
  type SupportRequestRow,
  type UpdateAdminOrderSupportRequestStatusInput,
} from "../orders";
import {
  getOrCreateOrderThread,
  planConversationAppend,
  readThread,
  type ConversationLine,
} from "./threads";

type BatchStatements = Parameters<Database["batch"]>[0];

const CASE_ATTEMPTS = 3;

export interface CaseSubmitResult {
  request: OrderSupportRequestView;
  supportRequests: OrderSupportRequestView[];
  supportRequestActions: CustomerOrderSupportRequestAction[];
  supportRequestIntro: string;
  conversationId: string;
}

function isConstraintError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
  return /constraint|unique|SQLITE_CONSTRAINT|conversation sequence|message seq|duplicate key/i.test(text);
}

function isActiveCaseConflict(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
  return /active_key|order_support_requests/i.test(text);
}

async function appendCaseLines(db: Database, orderId: string, lines: ConversationLine[]): Promise<void> {
  let thread = await getOrCreateOrderThread(db, orderId);
  for (let attempt = 1; attempt <= CASE_ATTEMPTS; attempt += 1) {
    try {
      await db.batch(planConversationAppend(db, thread, lines, { notify: false }).statements as unknown as BatchStatements);
      return;
    } catch (error) {
      if (!isConstraintError(error) || attempt === CASE_ATTEMPTS) {
        console.error(`[conversations] Case event not recorded on the thread of order ${orderId}:`, error instanceof Error ? error.message : "unknown error");
        return;
      }
      const fresh = await readThread(db, thread.id);
      if (!fresh) return;
      thread = fresh;
    }
  }
}

export async function createCustomerOrderSupportRequest(
  db: Database,
  customerId: string,
  orderId: string,
  input: CreateCustomerOrderSupportRequestInput,
): Promise<CaseSubmitResult> {
  return createVerifiedOrderSupportRequest(db, orderId, input, {
    actorType: "customer",
    customerId,
  });
}

export async function createReceiptOrderSupportRequest(
  db: Database,
  orderId: string,
  input: CreateCustomerOrderSupportRequestInput,
): Promise<CaseSubmitResult> {
  return createVerifiedOrderSupportRequest(db, orderId, input, {
    actorType: "guest_receipt",
    customerId: null,
  });
}

async function createVerifiedOrderSupportRequest(
  db: Database,
  orderId: string,
  input: CreateCustomerOrderSupportRequestInput,
  actor: { actorType: "customer" | "guest_receipt"; customerId: string | null },
): Promise<CaseSubmitResult> {
  if (!isSupportRequestType(input.type)) {
    throw new ValidationError("Unsupported support request type.");
  }

  const reason = input.reason.trim();
  const details = input.message?.trim() || null;
  if (reason.length < 3 || reason.length > 500) {
    throw new ValidationError("Please enter a reason between 3 and 500 characters.");
  }
  if (details && details.length > 1000) {
    throw new ValidationError("Request details must be 1000 characters or less.");
  }

  const order = await selectSupportRequestOrderState(db, orderId, actor.customerId ?? undefined);
  if (!order) throw new NotFoundError("Order not found");

  const state = await buildOrderSupportRequestState(db, order);
  const activeRequestTypes = getActiveSupportRequestTypes(state.supportRequests);
  const selectedAction = state.allSupportRequestActions.find((action) => action.type === input.type);
  if (!selectedAction?.eligible) {
    const reasonText = selectedAction?.disabledReason ?? "This request is not available for the current order state.";
    if (activeRequestTypes.size > 0 || state.hasActiveRefundOperation) throw new ConflictError(reasonText);
    throw new ValidationError(reasonText);
  }

  const requestId = `osr_${nanoid(16)}`;
  const requestCustomerId = actor.actorType === "customer" ? actor.customerId : order.customerId ?? null;
  const authorType = actor.actorType;
  const lines: ConversationLine[] = [
    {
      kind: "event",
      visibility: "public",
      authorType: "system",
      eventKind: "support_request_submitted",
      eventData: { requestId, type: input.type, status: "submitted" },
      readBy: ["customer"],
    },
    {
      kind: "message",
      visibility: "public",
      authorType,
      authorCustomerId: actor.actorType === "customer" ? actor.customerId : null,
      body: details ? `${reason}\n\n${details}` : reason,
      readBy: ["customer"],
    },
  ];

  let thread = await getOrCreateOrderThread(db, orderId);
  let committed = false;
  for (let attempt = 1; attempt <= CASE_ATTEMPTS && !committed; attempt += 1) {
    // Case notifications stay on the order types (support_request_submitted),
    // so the buyer's words raise no second staff message notification.
    const plan = planConversationAppend(db, thread, lines, { notify: false });
    try {
      await db.batch([
        db.insert(orderSupportRequests).values({
          id: requestId,
          orderId,
          customerId: requestCustomerId,
          conversationId: thread.id,
          type: input.type,
          status: "submitted",
          reason,
          activeKey: `order:${orderId}`,
          submittedAt: sql`unixepoch()`,
          createdAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
        }),
        ...plan.statements,
      ] as BatchStatements);
      committed = true;
    } catch (error) {
      if (isActiveCaseConflict(error)) throw new ConflictError("A support request is already open for this order.");
      if (!isConstraintError(error) || attempt === CASE_ATTEMPTS) {
        if (isConstraintError(error)) throw new ConflictError("A support request is already open for this order.");
        throw error;
      }
      const fresh = await readThread(db, thread.id);
      if (!fresh) throw new NotFoundError("Conversation not found");
      thread = fresh;
    }
  }

  // Staff see the buyer's own words on the order timeline (R2-ORD-15).
  await recordOrderEvent(db, {
    orderId,
    kind: "request_submitted",
    requestKey: requestId,
    body: reason,
    data: { type: input.type, reason },
  });

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
      { order },
    ),
    supportRequestIntro: state.supportRequestIntro,
    conversationId: thread.id,
  };
}

/**
 * Staff settle or advance a case. The status change is a public event line on
 * the order thread; a resolution note is an internal note beside it.
 */
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
    .where(and(eq(orderSupportRequests.id, requestId), eq(orderSupportRequests.orderId, orderId)))
    .get();
  if (!current) throw new NotFoundError("Support request not found");

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

  const lines: ConversationLine[] = [{
    kind: "event",
    visibility: "public",
    authorType: "system",
    eventKind: "support_request_status",
    eventData: { requestId, type: current.type, fromStatus: current.status, toStatus: targetStatus },
    readBy: ["staff"],
  }];
  if (note && input.actorId) {
    lines.push({
      kind: "message",
      visibility: "internal",
      authorType: "staff",
      authorUserId: input.actorId,
      body: note,
      readBy: ["staff"],
    });
  }

  // The case row is the authority: its status CAS commits first, then the
  // thread records it. A thread write that loses every race leaves the case
  // settled and the event line missing, never the reverse.
  let updatedRows: SupportRequestRow[];
  try {
    const thread = await getOrCreateOrderThread(db, orderId);
    updatedRows = await db.update(orderSupportRequests).set({
      status: targetStatus,
      returnId: input.returnId ?? current.returnId,
      conversationId: thread.id,
      activeKey: transition.active ? `order:${orderId}` : null,
      resolvedAt: transition.terminal ? sql`unixepoch()` : null,
      updatedAt: sql`unixepoch()`,
    }).where(and(
      eq(orderSupportRequests.id, requestId),
      eq(orderSupportRequests.orderId, orderId),
      eq(orderSupportRequests.status, current.status),
    )).returning(supportRequestSelectFields);
  } catch (error) {
    if (isConstraintError(error)) throw new ConflictError("Another support request is already open for this order.");
    throw error;
  }
  const updated = updatedRows[0];
  if (!updated) throw new ConflictError("Support request changed while you were resolving it. Please refresh.");
  await appendCaseLines(db, orderId, lines);

  return {
    request: formatOrderSupportRequest(updated),
    supportRequests: await listOrderSupportRequests(db, orderId),
    statusChanged: true,
    previousStatus: current.status,
    newStatus: targetStatus,
  };
}
