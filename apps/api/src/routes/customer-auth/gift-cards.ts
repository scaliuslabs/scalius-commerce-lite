// Signed-in buyer gift-card routes (Wave B §4.5, §7.1): the account list,
// "Save a card to my account" (possession of the code is the proof; it links
// the card and changes no identity) and "Show code" for a card they own.
// Codes only in POST bodies and the reveal response; everything is no-store.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  listBuyerGiftCards,
  revealBuyerGiftCardCode,
  saveGiftCardToAccount,
  type BuyerGiftCard,
} from "@scalius/core/modules/gift-cards";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { fromMinor } from "@scalius/shared/money";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { ok } from "../../utils/api-response";
import { RateLimitError, UnauthorizedError } from "../../utils/api-error";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { isWithinRateLimit } from "../../utils/rate-limit";
import { errorResponses, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import { requireCustomerSession, setPrivateNoStoreHeaders } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

const isoTimestamp = z.string().openapi({ format: "date-time" });
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

const buyerGiftCardTransactionSchema = z.object({
  id: z.string(),
  kind: z.enum(["issue", "redeem", "release", "refund", "adjust"]),
  amount: z.number(),
  amountMinor: z.number().int(),
  balanceAfter: z.number(),
  balanceAfterMinor: z.number().int(),
  orderId: z.string().nullable(),
  orderNumber: z.string().nullable(),
  createdAt: isoTimestamp,
}).openapi("BuyerGiftCardTransaction");

export const buyerGiftCardSchema = z.object({
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
  createdAt: isoTimestamp,
  transactions: z.array(buyerGiftCardTransactionSchema),
}).openapi("BuyerGiftCard");

function presentBuyerGiftCard(card: BuyerGiftCard) {
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
    createdAt: iso(card.createdAt),
    transactions: card.transactions.map((transaction) => ({
      id: transaction.id,
      kind: transaction.kind,
      amount: fromMinor(transaction.amountMinor, places),
      amountMinor: transaction.amountMinor,
      balanceAfter: fromMinor(transaction.balanceAfterMinor, places),
      balanceAfterMinor: transaction.balanceAfterMinor,
      orderId: transaction.orderId,
      orderNumber: transaction.orderId ? formatOrderNumber(transaction.orderNumber, transaction.orderId) : null,
      createdAt: iso(transaction.createdAt),
    })),
  };
}

async function signedInCustomerId(c: Parameters<typeof requireCustomerSession>[0]): Promise<string> {
  const { session } = await requireCustomerSession(c);
  if (!session.customerId) throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
  return session.customerId;
}

async function enforceLimit(env: Env, tier: "RL_STRICT" | "RL_STANDARD", purpose: string, customerId: string) {
  if (!await isWithinRateLimit(env, tier, purpose, customerId)) {
    throw new RateLimitError("Too many gift card attempts. Please wait a minute and try again.", 60);
  }
}

app.openapi(createRoute({
  method: "get",
  path: "/gift-cards",
  tags: ["Customer Auth"],
  summary: "The signed-in buyer's gift cards",
  responses: {
    200: {
      description: "Gift cards saved to the account, newest first",
      content: { "application/json": { schema: successEnvelope(z.object({ giftCards: z.array(buyerGiftCardSchema) })) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  setPrivateNoStoreHeaders(c);
  const customerId = await signedInCustomerId(c);
  const cards = await listBuyerGiftCards(c.get("db"), customerId);
  return ok(c, { giftCards: cards.map(presentBuyerGiftCard) });
});

app.openapi(createRoute({
  method: "post",
  path: "/gift-cards/save",
  tags: ["Customer Auth"],
  summary: "Save a gift card to the signed-in account",
  description: "Links an unowned gift card to the account by its code (POST body only). The card's balance and code do not change.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ code: z.string().trim().min(1).max(64) }).strict() } },
    },
  },
  responses: {
    200: {
      description: "The saved card",
      content: { "application/json": { schema: successEnvelope(z.object({ giftCard: buyerGiftCardSchema })) } },
    },
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
}), async (c) => {
  setPrivateNoStoreHeaders(c);
  const customerId = await signedInCustomerId(c);
  await enforceLimit(c.env, "RL_STRICT", "gift-card-save", customerId);
  const { code } = c.req.valid("json");
  const card = await saveGiftCardToAccount(c.get("db"), {
    customerId,
    code,
    credentialEncryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
  });
  return ok(c, { giftCard: presentBuyerGiftCard(card) });
});

app.openapi(createRoute({
  method: "post",
  path: "/gift-cards/{giftCardId}/reveal",
  tags: ["Customer Auth"],
  summary: "Show the code of a gift card the signed-in buyer owns",
  request: {
    params: z.object({ giftCardId: z.string().min(4).max(80) }),
  },
  responses: {
    200: {
      description: "The formatted code (XXXX-XXXX-XXXX-XXXX)",
      content: { "application/json": { schema: successEnvelope(z.object({ code: z.string() })) } },
    },
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
}), async (c) => {
  setPrivateNoStoreHeaders(c);
  const customerId = await signedInCustomerId(c);
  await enforceLimit(c.env, "RL_STANDARD", "gift-card-reveal", customerId);
  const { giftCardId } = c.req.valid("param");
  const code = await revealBuyerGiftCardCode(c.get("db"), {
    customerId,
    giftCardId,
    credentialEncryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
  });
  return ok(c, { code });
});

export { app as customerGiftCardRoutes };
