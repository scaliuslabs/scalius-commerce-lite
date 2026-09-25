// Dashboard gift-card routes (Wave B §4.2, §7.2), mounted at /admin/gift-cards
// (admin sales family). Reads need GIFT_CARDS_VIEW and writes
// GIFT_CARDS_MANAGE (route-permissions/gift-cards.ts); gift cards issue money,
// so they are never folded into orders permissions. Staff see last 4 only;
// the full code is in the issue response once, and never in a URL or log.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  GIFT_CARD_LIST_FILTERS,
  adjustGiftCardBalance,
  getGiftCardForStaff,
  getStaffGiftCardSummary,
  giftCardExpiryFromMonths,
  giftCardLiabilitySummary,
  issueManualGiftCard,
  listGiftCardsForStaff,
  normalizeGiftCardMessage,
  normalizeGiftCardRecipient,
  updateGiftCardForStaff,
  type StaffGiftCardSummary,
} from "@scalius/core/modules/gift-cards";
import {
  buildNotificationOutboxInsert,
  enqueueNotificationOutboxById,
  recordAndEnqueueNotification,
} from "@scalius/core/modules/notifications";
import { getCurrencySettings, readGiftCardSettings } from "@scalius/core/modules/settings";
import { customers } from "@scalius/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { formatGiftCardCode } from "@scalius/shared/gift-card-code";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { fromMinor, isWholeCashAmountMinor, toMinor } from "@scalius/shared/money";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { ok, created } from "../../utils/api-response";
import { ServiceUnavailableError, UnauthorizedError, ValidationError } from "../../utils/api-error";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { conflictResponse, errorResponses, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

const isoTimestamp = z.string().openapi({ format: "date-time" });
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

function staffId(c: { get: (key: "user") => unknown }): string {
  const id = (c.get("user") as { id?: string } | undefined)?.id;
  if (!id) throw new UnauthorizedError("Sign in again to manage gift cards.");
  return id;
}

function noStore(c: { header: (name: string, value: string) => void }) {
  c.header("Cache-Control", "private, no-store");
}

const giftCardSummarySchema = z.object({
  id: z.string(),
  last4: z.string(),
  currencyCode: z.string(),
  initialAmount: z.number(),
  initialAmountMinor: z.number().int(),
  balance: z.number(),
  balanceMinor: z.number().int(),
  status: z.enum(["active", "disabled"]),
  expiresAt: isoTimestamp.nullable(),
  expired: z.boolean(),
  source: z.enum(["purchase", "manual", "refund"]),
  customer: z.object({ id: z.string(), name: z.string() }).nullable(),
  recipientName: z.string().nullable(),
  recipientContactMasked: z.string().nullable(),
  createdAt: isoTimestamp,
  version: z.number().int(),
}).openapi("AdminGiftCardSummary");

const giftCardDetailSchema = giftCardSummarySchema.extend({
  note: z.string().nullable(),
  message: z.string().nullable(),
  recipientEmail: z.string().nullable(),
  recipientPhone: z.string().nullable(),
  sourceOrder: z.object({ id: z.string(), orderNumber: z.string() }).nullable(),
  issuedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
}).openapi("AdminGiftCardDetail");

const giftCardTransactionSchema = z.object({
  id: z.string(),
  kind: z.enum(["issue", "redeem", "release", "refund", "adjust"]),
  amount: z.number(),
  amountMinor: z.number().int(),
  balanceAfter: z.number(),
  balanceAfterMinor: z.number().int(),
  orderId: z.string().nullable(),
  orderNumber: z.string().nullable(),
  actorType: z.enum(["system", "admin", "customer"]),
  actorName: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: isoTimestamp,
}).openapi("AdminGiftCardTransaction");

function presentSummary(card: StaffGiftCardSummary) {
  const places = getDecimalPlaces(card.currencyCode);
  return {
    id: card.id,
    last4: card.last4,
    currencyCode: card.currencyCode,
    initialAmount: fromMinor(card.initialAmountMinor, places),
    initialAmountMinor: card.initialAmountMinor,
    balance: fromMinor(card.balanceMinor, places),
    balanceMinor: card.balanceMinor,
    status: card.status,
    expiresAt: card.expiresAt === null ? null : iso(card.expiresAt),
    expired: card.expired,
    source: card.source,
    customer: card.customer,
    recipientName: card.recipientName,
    recipientContactMasked: card.recipientContactMasked,
    createdAt: iso(card.createdAt),
    version: card.version,
  };
}

/** ISO date-time or date → epoch seconds; null clears. Past expiries are refused. */
function parseExpiry(value: string | null | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === "") return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new ValidationError("Enter a valid expiry date.");
  const seconds = Math.floor(at / 1000);
  if (seconds <= Math.floor(Date.now() / 1000)) throw new ValidationError("The expiry date must be in the future.");
  return seconds;
}

function amountToMinor(amount: number, currencyCode: string, label: string): number {
  const minor = toMinor(amount, getDecimalPlaces(currencyCode));
  if (!Number.isSafeInteger(minor)) throw new ValidationError(`${label} is not a valid amount.`);
  if (!isWholeCashAmountMinor(Math.abs(minor), currencyCode)) {
    throw new ValidationError(`${label} must be a whole amount in ${currencyCode}.`);
  }
  return minor;
}

const requestKeySchema = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9:_-]+$/);

// ── List ──

app.openapi(createRoute({
  operationId: "dashboard.gift_cards.list",
  method: "get",
  path: "/",
  tags: ["Admin - Gift cards"],
  summary: "List gift cards",
  description: "Newest first, keyset paginated. `q` matches the last 4 characters of a code or a customer's name, phone or email.",
  request: {
    query: z.object({
      q: z.string().trim().max(120).optional(),
      status: z.enum(GIFT_CARD_LIST_FILTERS).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      cursor: z.string().max(200).optional(),
    }),
  },
  responses: {
    200: {
      description: "Gift cards",
      content: { "application/json": { schema: successEnvelope(z.object({
        items: z.array(giftCardSummarySchema),
        nextCursor: z.string().nullable(),
      })) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const page = await listGiftCardsForStaff(c.get("db"), query);
  return ok(c, { items: page.items.map(presentSummary), nextCursor: page.nextCursor });
});

// ── Liability summary ──

app.openapi(createRoute({
  operationId: "dashboard.gift_cards.summary",
  method: "get",
  path: "/summary",
  tags: ["Admin - Gift cards"],
  summary: "Outstanding gift card balance",
  description: "The store's liability: the balance left on active, unexpired cards, per currency.",
  responses: {
    200: {
      description: "Outstanding balance per currency",
      content: { "application/json": { schema: successEnvelope(z.object({
        outstanding: z.array(z.object({
          currencyCode: z.string(),
          balance: z.number(),
          balanceMinor: z.number().int(),
          cards: z.number().int(),
        })),
      })) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  const rows = await giftCardLiabilitySummary(c.get("db"));
  return ok(c, {
    outstanding: rows.map((row) => ({
      currencyCode: row.currencyCode,
      balance: fromMinor(row.balanceMinor, getDecimalPlaces(row.currencyCode)),
      balanceMinor: row.balanceMinor,
      cards: row.cards,
    })),
  });
});

// ── Detail ──

app.openapi(createRoute({
  operationId: "dashboard.gift_cards.get",
  method: "get",
  path: "/{giftCardId}",
  tags: ["Admin - Gift cards"],
  summary: "Get a gift card and its transactions",
  request: { params: z.object({ giftCardId: z.string().min(4).max(80) }) },
  responses: {
    200: {
      description: "Gift card detail",
      content: { "application/json": { schema: successEnvelope(z.object({
        giftCard: giftCardDetailSchema,
        transactions: z.array(giftCardTransactionSchema),
      })) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  const { giftCardId } = c.req.valid("param");
  const { giftCard, transactions } = await getGiftCardForStaff(c.get("db"), giftCardId);
  const places = getDecimalPlaces(giftCard.currencyCode);
  return ok(c, {
    giftCard: {
      ...presentSummary(giftCard),
      note: giftCard.note,
      message: giftCard.message,
      recipientEmail: giftCard.recipientEmail,
      recipientPhone: giftCard.recipientPhone,
      sourceOrder: giftCard.sourceOrder
        ? { id: giftCard.sourceOrder.id, orderNumber: formatOrderNumber(giftCard.sourceOrder.orderNumber, giftCard.sourceOrder.id) }
        : null,
      issuedBy: giftCard.issuedBy,
    },
    transactions: transactions.map((transaction) => ({
      id: transaction.id,
      kind: transaction.kind,
      amount: fromMinor(transaction.amountMinor, places),
      amountMinor: transaction.amountMinor,
      balanceAfter: fromMinor(transaction.balanceAfterMinor, places),
      balanceAfterMinor: transaction.balanceAfterMinor,
      orderId: transaction.orderId,
      orderNumber: transaction.orderId ? formatOrderNumber(transaction.orderNumber, transaction.orderId) : null,
      actorType: transaction.actorType,
      actorName: transaction.actorName,
      reason: transaction.reason,
      createdAt: iso(transaction.createdAt),
    })),
  });
});

// ── Issue ──

const recipientSchema = z.object({
  name: z.string().trim().max(120).optional().nullable(),
  email: z.string().trim().max(254).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
}).strict();

function giftCardIssuedNotification(giftCardId: string, source: string, dedupeSuffix = "") {
  return {
    subjectType: "gift_card" as const,
    subjectId: giftCardId,
    audience: "customer" as const,
    notificationType: "gift_card_issued" as const,
    dedupeKey: `gift_card_issued:${giftCardId}${dedupeSuffix}`,
    source,
  };
}

app.openapi(createRoute({
  operationId: "dashboard.gift_cards.create",
  method: "post",
  path: "/",
  tags: ["Admin - Gift cards"],
  summary: "Issue a gift card",
  description: "Issues a manual gift card. Idempotent by `requestKey`. The response carries the full code once; afterwards staff see the last 4 characters only.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        requestKey: requestKeySchema,
        amount: z.number().positive(),
        expiresAt: z.string().max(40).nullable().optional(),
        customerId: z.string().min(1).max(80).nullable().optional(),
        recipient: recipientSchema.nullable().optional(),
        message: z.string().max(400).nullable().optional(),
        note: z.string().max(500).nullable().optional(),
        notify: z.boolean().default(false),
      }).strict() } },
    },
  },
  responses: {
    201: {
      description: "Gift card issued",
      content: { "application/json": { schema: successEnvelope(z.object({
        giftCard: giftCardSummarySchema,
        code: z.string().openapi({ description: "XXXX-XXXX-XXXX-XXXX, shown once." }),
      })) } },
    },
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
}), async (c) => {
  noStore(c);
  const db = c.get("db");
  const body = c.req.valid("json");
  const actorUserId = staffId(c);
  const [currency, settings] = await Promise.all([getCurrencySettings(db), readGiftCardSettings(db)]);
  if (!settings.ok) throw new ServiceUnavailableError("Gift-card settings can't be read right now. Try again.");
  const amountMinor = amountToMinor(body.amount, currency.currencyCode, "The amount");
  if (amountMinor <= 0) throw new ValidationError("The amount must be more than zero.");
  const expiresAt = body.expiresAt === undefined
    ? giftCardExpiryFromMonths(settings.value.defaultExpiryMonths)
    : parseExpiry(body.expiresAt) ?? null;
  if (body.customerId) {
    const customer = await db.select({ id: customers.id }).from(customers)
      .where(and(eq(customers.id, body.customerId), isNull(customers.deletedAt))).get();
    if (!customer) throw new ValidationError("That customer doesn't exist.");
  }
  const recipient = normalizeGiftCardRecipient(body.recipient ?? null);
  const notify = body.notify && Boolean(recipient?.email || recipient?.phone || body.customerId);
  let outboxId: string | null = null;
  const result = await issueManualGiftCard(db, getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>), {
    requestKey: body.requestKey,
    amountMinor,
    currencyCode: currency.currencyCode,
    expiresAt,
    customerId: body.customerId ?? null,
    recipient,
    message: normalizeGiftCardMessage(body.message),
    note: body.note?.trim() || null,
    actorUserId,
  }, (giftCardId) => {
    if (!notify) return [];
    const insert = buildNotificationOutboxInsert(db, giftCardIssuedNotification(giftCardId, "admin-gift-card-issue"));
    outboxId = insert.outboxId;
    return [insert.statement as unknown as BatchItem<"sqlite">];
  });
  if (result.created && outboxId && c.env.JOBS_QUEUE) {
    await enqueueNotificationOutboxById({ db, queue: c.env.JOBS_QUEUE, outboxId }).catch((error: unknown) => {
      console.warn(`[gift-cards] issue notification for ${result.giftCardId} not enqueued:`, error instanceof Error ? error.message : "unknown error");
    });
  }
  const summary = await getStaffGiftCardSummary(db, result.giftCardId);
  return created(c, { giftCard: presentSummary(summary), code: formatGiftCardCode(result.code) });
});

// ── Adjust ──

app.openapi(createRoute({
  operationId: "dashboard.gift_cards.adjust",
  method: "post",
  path: "/{giftCardId}/adjust",
  tags: ["Admin - Gift cards"],
  summary: "Adjust a gift card balance",
  description: "Adds (positive) or removes (negative) balance with a required reason, as one ledger transaction. Idempotent by `requestKey`.",
  request: {
    params: z.object({ giftCardId: z.string().min(4).max(80) }),
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        requestKey: requestKeySchema,
        amount: z.number(),
        reason: z.string().trim().min(1).max(500),
      }).strict() } },
    },
  },
  responses: {
    200: {
      description: "Adjusted gift card",
      content: { "application/json": { schema: successEnvelope(z.object({ giftCard: giftCardSummarySchema })) } },
    },
    ...errorResponses,
    409: conflictResponse,
  },
}), async (c) => {
  const db = c.get("db");
  const { giftCardId } = c.req.valid("param");
  const body = c.req.valid("json");
  const card = await getStaffGiftCardSummary(db, giftCardId);
  const amountMinor = amountToMinor(body.amount, card.currencyCode, "The adjustment");
  const summary = await adjustGiftCardBalance(db, {
    giftCardId,
    amountMinor,
    reason: body.reason,
    requestKey: body.requestKey,
    actorUserId: staffId(c),
  });
  return ok(c, { giftCard: presentSummary(summary) });
});

// ── Update (status, expiry, owner, note) ──

app.openapi(createRoute({
  operationId: "dashboard.gift_cards.update",
  method: "patch",
  path: "/{giftCardId}",
  tags: ["Admin - Gift cards"],
  summary: "Update a gift card",
  description: "Disable or enable, change or remove the expiry, change the owning customer or the staff note. Requires the current `version`.",
  request: {
    params: z.object({ giftCardId: z.string().min(4).max(80) }),
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        version: z.number().int().min(1),
        status: z.enum(["active", "disabled"]).optional(),
        expiresAt: z.string().max(40).nullable().optional(),
        customerId: z.string().min(1).max(80).nullable().optional(),
        note: z.string().max(500).nullable().optional(),
      }).strict() } },
    },
  },
  responses: {
    200: {
      description: "Updated gift card",
      content: { "application/json": { schema: successEnvelope(z.object({ giftCard: giftCardSummarySchema })) } },
    },
    ...errorResponses,
    409: conflictResponse,
  },
}), async (c) => {
  const { giftCardId } = c.req.valid("param");
  const body = c.req.valid("json");
  const summary = await updateGiftCardForStaff(c.get("db"), {
    giftCardId,
    version: body.version,
    status: body.status,
    expiresAt: parseExpiry(body.expiresAt),
    customerId: body.customerId,
    note: body.note,
  });
  return ok(c, { giftCard: presentSummary(summary) });
});

// ── Resend ──

app.openapi(createRoute({
  operationId: "dashboard.gift_cards.resend",
  method: "post",
  path: "/{giftCardId}/resend",
  tags: ["Admin - Gift cards"],
  summary: "Send the gift card message again",
  description: "Queues the gift card email/SMS again to the card's recipient, else the order contact, else the owning customer.",
  request: { params: z.object({ giftCardId: z.string().min(4).max(80) }) },
  responses: {
    200: {
      description: "Queued",
      content: { "application/json": { schema: successEnvelope(z.object({ queued: z.boolean() })) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const { giftCardId } = c.req.valid("param");
  const card = await getStaffGiftCardSummary(db, giftCardId);
  if (card.status !== "active") throw new ValidationError("Enable the gift card before sending it again.");
  const result = await recordAndEnqueueNotification({
    db,
    queue: c.env.JOBS_QUEUE,
    notification: giftCardIssuedNotification(giftCardId, "admin-gift-card-resend", `:resend:${crypto.randomUUID()}`),
  });
  return ok(c, { queued: result.enqueued });
});

export { app as adminGiftCardRoutes };
