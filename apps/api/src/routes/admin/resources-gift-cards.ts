// Gift cards in the stable app API (operation-registry/README.md), mounted at
// /admin/resources: the same core issue, ledger and update paths as the
// dashboard (routes/admin/gift-cards.ts), in integer minor units of the
// card's currency. Every write is financial and confirmation-gated for
// agents; an app reaches them only under the Sensitive `write_gift_cards`.
//
// The card's code never reaches an app or an agent: an issue answers with the
// card (last four characters only), and `notify` has the store deliver the
// code to the recipient, else the owning customer. Recipient contacts are
// protected customer data.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  adjustGiftCardBalance,
  getGiftCardForStaff,
  getStaffGiftCardSummary,
  giftCardExpiryFromMonths,
  issueManualGiftCard,
  listGiftCardsForStaff,
  normalizeGiftCardMessage,
  parseGiftCardRecipientStrict,
  updateGiftCardForStaff,
  type StaffGiftCardSummary,
} from "@scalius/core/modules/gift-cards";
import { buildNotificationOutboxInsert } from "@scalius/core/modules/notifications";
import { priceIncrementForCurrency, readGiftCardSettings } from "@scalius/core/modules/settings";
import { readStoreCurrency } from "@scalius/core/modules/markets";
import { customers } from "@scalius/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { isWholeUnitIncrement } from "@scalius/shared/currency-policy";
import { isIncrementMultipleMinor, priceIncrementMessage } from "@scalius/shared/money";
import { created, ok } from "../../utils/api-response";
import { ServiceUnavailableError, UnauthorizedError, ValidationError } from "../../utils/api-error";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { conflictResponse, errorResponses, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import { protectedField } from "../../schemas/protected";
import { notificationSender } from "../../background/notification-sender";
import { idempotencyKeyHeaderSchema, scopedRequestKey } from "./idempotency";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
});

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const isoTimestamp = z.string().openapi({ format: "date-time" });

const giftCardSummaryShape = {
  id: z.string(),
  last4: z.string().openapi({ description: "The code's last four characters; the code itself never leaves the store." }),
  currency: z.string().length(3),
  initialAmountMinor: z.number().int().openapi({ description: "The value it was issued with, in minor units of `currency`." }),
  balanceMinor: z.number().int().openapi({ description: "What is left to spend, in minor units of `currency`." }),
  status: z.enum(["active", "disabled"]),
  expiresAt: isoTimestamp.nullable(),
  expired: z.boolean(),
  source: z.enum(["purchase", "manual", "refund"]),
  customerId: z.string().nullable().openapi({ description: "The customer who owns it, if any." }),
  recipientName: protectedField("name", z.string().nullable()),
  version: z.number().int().positive().openapi({ description: "Send it as `expectedVersion` to change the card; every balance movement advances it." }),
  createdAt: isoTimestamp,
};

const GiftCardSummaryResource = z.object(giftCardSummaryShape).openapi("GiftCardSummaryResource");

const GiftCardTransactionResource = z.object({
  id: z.string(),
  kind: z.enum(["issue", "redeem", "release", "refund", "adjust"]),
  amountMinor: z.number().int().openapi({ description: "Signed: positive adds value, negative spends it, in minor units of the card's `currency`." }),
  balanceAfterMinor: z.number().int(),
  orderId: z.string().nullable(),
  actorType: z.enum(["system", "admin", "customer"]),
  reason: z.string().nullable(),
  createdAt: isoTimestamp,
}).openapi("GiftCardTransactionResource");

// One flat object (not an extension), so `currency` sits beside every amount.
const GiftCardResource = z.object({
  ...giftCardSummaryShape,
  recipientEmail: protectedField("email", z.string().nullable()),
  recipientPhone: protectedField("phone", z.string().nullable()),
  message: z.string().nullable().openapi({ description: "The message the recipient reads with the card." }),
  note: z.string().nullable().openapi({ description: "The store's own note; buyers never see it." }),
  sourceOrderId: z.string().nullable().openapi({ description: "The order it was bought or refunded on, if any." }),
  transactions: z.array(GiftCardTransactionResource).openapi({ description: "Its ledger, in minor units of `currency`." }),
}).openapi("GiftCardResource");

type GiftCardSummaryResourceValue = z.infer<typeof GiftCardSummaryResource>;
type GiftCardResourceValue = z.infer<typeof GiftCardResource>;

function summaryResource(card: StaffGiftCardSummary): GiftCardSummaryResourceValue {
  return {
    id: card.id,
    last4: card.last4,
    currency: card.currencyCode,
    initialAmountMinor: card.initialAmountMinor,
    balanceMinor: card.balanceMinor,
    status: card.status,
    expiresAt: card.expiresAt === null ? null : iso(card.expiresAt),
    expired: card.expired,
    source: card.source,
    customerId: card.customer?.id ?? null,
    recipientName: card.recipientName,
    version: card.version,
    createdAt: iso(card.createdAt),
  };
}

async function readGiftCardResource(c: Context, giftCardId: string): Promise<GiftCardResourceValue> {
  const { giftCard, transactions } = await getGiftCardForStaff(c.get("db"), giftCardId);
  return {
    ...summaryResource(giftCard),
    recipientEmail: giftCard.recipientEmail,
    recipientPhone: giftCard.recipientPhone,
    message: giftCard.message,
    note: giftCard.note,
    sourceOrderId: giftCard.sourceOrder?.id ?? null,
    transactions: transactions.map((transaction) => ({
      id: transaction.id,
      kind: transaction.kind,
      amountMinor: transaction.amountMinor,
      balanceAfterMinor: transaction.balanceAfterMinor,
      orderId: transaction.orderId,
      actorType: transaction.actorType,
      reason: transaction.reason,
      createdAt: iso(transaction.createdAt),
    })),
  };
}

/** The staff member a write is recorded as (an app's approving Super Admin). */
function actorId(c: Context): string {
  const id = (c.get("user") as { id?: string } | undefined)?.id;
  if (!id) throw new UnauthorizedError("Sign in again to manage gift cards.");
  return id;
}

/** ISO date-time → epoch seconds; null clears. Past expiries are refused. */
function parseExpiry(value: string | null | undefined): number | null | undefined {
  if (value === undefined || value === null) return value;
  const seconds = Math.floor(Date.parse(value) / 1000);
  if (!Number.isFinite(seconds)) throw new ValidationError("Enter a valid expiry date.", { field: "expiresAt" });
  if (seconds <= Math.floor(Date.now() / 1000)) throw new ValidationError("The expiry date must be in the future.", { field: "expiresAt" });
  return seconds;
}

/** An amount on the currency's price increment (a BDT store's default: whole taka). */
function assertIncrement(amountMinor: number, currencyCode: string, priceIncrementMinor: number, field: string): void {
  if (isIncrementMultipleMinor(Math.abs(amountMinor), priceIncrementMinor)) return;
  throw new ValidationError(isWholeUnitIncrement(currencyCode, priceIncrementMinor)
    ? `${field} must be a whole amount in ${currencyCode}.`
    : `${field}: ${priceIncrementMessage(currencyCode, priceIncrementMinor)}`, { field });
}

const giftCardId = z.object({ id: z.string().min(4).max(80) });
const expectedVersion = z.number().int().positive().openapi({ description: "The card's `version` you read; a card changed since is refused with 409." });
const giftCardEnvelope = successEnvelope(z.object({ giftCard: GiftCardResource }));
const writeResponses = { ...errorResponses, 409: conflictResponse };

app.openapi(createRoute({
  operationId: "dashboard.resources.gift_cards.list",
  method: "get",
  path: "/gift-cards",
  tags: ["App API - Gift cards"],
  summary: "List gift cards, newest first",
  description: "Gift cards with their balances in minor units of `currency`. `status` narrows to active, disabled, expired or empty cards.",
  request: {
    query: z.object({
      status: z.enum(["active", "disabled", "expired", "empty"]).optional(),
      cursor: z.string().max(200).optional().openapi({ description: "The `nextCursor` of the page before; leave it out for the first page." }),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }),
  },
  responses: {
    200: {
      description: "A page of gift cards",
      content: { "application/json": { schema: successEnvelope(z.object({
        giftCards: z.array(GiftCardSummaryResource),
        nextCursor: z.string().nullable().openapi({ description: "Pass it as `cursor` for the next page; null on the last page." }),
      })) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const page = await listGiftCardsForStaff(c.get("db"), { status: query.status, cursor: query.cursor, limit: query.limit });
  return ok(c, { giftCards: page.items.map(summaryResource), nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.gift_cards.get",
  method: "get",
  path: "/gift-cards/{id}",
  tags: ["App API - Gift cards"],
  summary: "Get a gift card and its ledger",
  request: { params: giftCardId },
  responses: {
    200: { description: "The gift card", content: { "application/json": { schema: giftCardEnvelope } } },
    ...errorResponses,
  },
}), async (c) => ok(c, { giftCard: await readGiftCardResource(c, c.req.valid("param").id) }));

const recipientInput = z.object({
  name: z.string().trim().max(120).nullable().optional(),
  email: z.string().trim().max(254).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
}).strict();

app.openapi(createRoute({
  operationId: "dashboard.resources.gift_cards.create",
  method: "post",
  path: "/gift-cards",
  tags: ["App API - Gift cards"],
  summary: "Issue a gift card",
  description: "Issues a gift card in the store currency, in minor units at its price increment. The code is never returned: with `notify` the store sends it to the recipient, else the owning customer. Send an Idempotency-Key: a repeat returns the first card.",
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).openapi({ description: "Its value, in minor units of the store currency." }),
        expiresAt: z.string().datetime({ offset: true }).nullable().optional()
          .openapi({ description: "Omit for the store's default expiry; null for none." }),
        customerId: z.string().min(1).max(80).nullable().optional(),
        recipient: recipientInput.nullable().optional(),
        message: z.string().max(400).nullable().optional(),
        note: z.string().max(500).nullable().optional(),
        notify: z.boolean().default(false).openapi({ description: "Send the code to the recipient (else the owning customer) now." }),
      }).strict() } },
    },
  },
  responses: {
    201: { description: "The issued gift card", content: { "application/json": { schema: giftCardEnvelope } } },
    ...writeResponses,
    503: serviceUnavailableResponse,
  },
}), async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const actorUserId = actorId(c);
  const [currency, settings] = await Promise.all([readStoreCurrency(db), readGiftCardSettings(db)]);
  if (!settings.ok) throw new ServiceUnavailableError("Gift-card settings can't be read right now. Try again.");
  assertIncrement(body.amountMinor, currency.code, currency.priceIncrementMinor, "amountMinor");
  const expiresAt = body.expiresAt === undefined
    ? giftCardExpiryFromMonths(settings.value.defaultExpiryMonths)
    : parseExpiry(body.expiresAt) ?? null;
  if (body.customerId) {
    const customer = await db.select({ id: customers.id }).from(customers)
      .where(and(eq(customers.id, body.customerId), isNull(customers.deletedAt))).get();
    if (!customer) throw new ValidationError("That customer doesn't exist.", { field: "customerId" });
  }
  const recipient = parseGiftCardRecipientStrict(body.recipient ?? null);
  const notify = body.notify && Boolean(recipient?.email || recipient?.phone || body.customerId);
  let outboxId: string | null = null;
  const result = await issueManualGiftCard(db, getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>), {
    requestKey: await scopedRequestKey(c, "dashboard.resources.gift_cards.create", c.req.valid("header")["idempotency-key"]),
    amountMinor: body.amountMinor,
    currencyCode: currency.code,
    expiresAt,
    customerId: body.customerId ?? null,
    recipient,
    message: normalizeGiftCardMessage(body.message),
    note: body.note?.trim() || null,
    actorUserId,
  }, (id) => {
    if (!notify) return [];
    const insert = buildNotificationOutboxInsert(db, {
      subjectType: "gift_card",
      subjectId: id,
      audience: "customer",
      notificationType: "gift_card_issued",
      dedupeKey: `gift_card_issued:${id}`,
      source: "app-api-gift-card-issue",
    });
    outboxId = insert.outboxId;
    return [insert.statement as unknown as BatchItem<"sqlite">];
  });
  if (result.created && outboxId) await notificationSender(c)([outboxId]);
  return created(c, { giftCard: await readGiftCardResource(c, result.giftCardId) });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.gift_cards.adjust",
  method: "post",
  path: "/gift-cards/{id}/adjust",
  tags: ["App API - Gift cards"],
  summary: "Add to or take from a gift card balance",
  description: "One ledger movement with a reason: a positive `amountMinor` adds value, a negative one removes it (never below zero), in minor units of the card's currency. Send an Idempotency-Key: a repeat moves the balance once.",
  request: {
    params: giftCardId,
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        expectedVersion,
        amountMinor: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).refine((value) => value !== 0, "Enter an amount to add or remove."),
        reason: z.string().trim().min(1).max(500),
      }).strict() } },
    },
  },
  responses: {
    200: { description: "The gift card", content: { "application/json": { schema: giftCardEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const [card, store] = await Promise.all([getStaffGiftCardSummary(db, id), readStoreCurrency(db)]);
  assertIncrement(body.amountMinor, card.currencyCode, priceIncrementForCurrency(store, card.currencyCode), "amountMinor");
  await adjustGiftCardBalance(db, {
    giftCardId: id,
    amountMinor: body.amountMinor,
    reason: body.reason,
    requestKey: await scopedRequestKey(c, "dashboard.resources.gift_cards.adjust", c.req.valid("header")["idempotency-key"]),
    actorUserId: actorId(c),
    expectedVersion: body.expectedVersion,
  });
  return ok(c, { giftCard: await readGiftCardResource(c, id) });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.gift_cards.update",
  method: "patch",
  path: "/gift-cards/{id}",
  tags: ["App API - Gift cards"],
  summary: "Disable, enable or re-date a gift card",
  description: "`status: disabled` stops a card being spent (its balance stays); `active` turns it back on. Also changes the expiry, the owning customer or the store's note. Fields left out keep their value.",
  request: {
    params: giftCardId,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        expectedVersion,
        status: z.enum(["active", "disabled"]).optional(),
        expiresAt: z.string().datetime({ offset: true }).nullable().optional().openapi({ description: "null removes the expiry." }),
        customerId: z.string().min(1).max(80).nullable().optional(),
        note: z.string().max(500).nullable().optional(),
      }).strict() } },
    },
  },
  responses: {
    200: { description: "The gift card", content: { "application/json": { schema: giftCardEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  await updateGiftCardForStaff(c.get("db"), {
    giftCardId: id,
    version: body.expectedVersion,
    status: body.status,
    expiresAt: parseExpiry(body.expiresAt),
    customerId: body.customerId,
    note: body.note,
  });
  return ok(c, { giftCard: await readGiftCardResource(c, id) });
});

export { app as adminResourceGiftCardRoutes };
