// Public gift-card checkout routes (Wave B §4.3, §4.5, §7.1): prove a code once
// and get a short-lived apply handle, or check a balance. Codes only ever
// travel in POST bodies; responses are `no-store` and never echo the code.
// Every unusable card reads the same, and both routes are rate limited per IP
// (fail closed without the limiter). Mounted at /checkout/gift-cards.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  applyGiftCardCode,
  checkGiftCardBalance,
} from "@scalius/core/modules/gift-cards";
import { getCurrencySettings } from "@scalius/core/modules/settings";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { fromMinor } from "@scalius/shared/money";
import { getClientIp } from "@scalius/shared/rate-limit";
import { readMasterSecret } from "@scalius/shared/runtime-secrets";
import { ok } from "../utils/api-response";
import { RateLimitError, ServiceUnavailableError } from "../utils/api-error";
import { getCredentialEncryptionKey } from "../utils/encryption-key";
import { isWithinRateLimit } from "../utils/rate-limit";
import { errorResponses, serviceUnavailableResponse, successEnvelope } from "../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

const isoTimestamp = z.string().openapi({ format: "date-time" });
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/** A typed code: generous bound, normalized server-side (spaces, dashes, O/I/L). */
const codeBodySchema = z.object({
  code: z.string().trim().min(1).max(64).openapi({
    description: "The gift-card code as the buyer typed it. Only ever sent in a POST body.",
  }),
}).strict();

const appliedGiftCardSchema = z.object({
  handle: z.string().openapi({
    description: "Opaque, short-lived apply handle. Send it as `giftCards[].handle` with the tax quote and the order; never the code.",
  }),
  handleExpiresAt: isoTimestamp,
  last4: z.string(),
  balance: z.number(),
  balanceMinor: z.number().int(),
  currencyCode: z.string(),
  expiresAt: isoTimestamp.nullable(),
}).openapi("AppliedGiftCard");

const giftCardBalanceSchema = z.object({
  last4: z.string(),
  balance: z.number(),
  balanceMinor: z.number().int(),
  currencyCode: z.string(),
  expiresAt: isoTimestamp.nullable(),
  status: z.enum(["active", "disabled", "expired"]),
}).openapi("GiftCardBalance");

function noStore(c: { header: (name: string, value: string) => void }) {
  c.header("Cache-Control", "private, no-store");
  c.header("Pragma", "no-cache");
}

async function enforceGiftCardRateLimit(env: Env, request: Request, purpose: string): Promise<void> {
  const ip = getClientIp(request);
  const [strict, standard] = await Promise.all([
    isWithinRateLimit(env, "RL_STRICT", `${purpose}-ip`, ip),
    isWithinRateLimit(env, "RL_STANDARD", `${purpose}-ip-minute`, ip),
  ]);
  if (!strict || !standard) {
    throw new RateLimitError("Too many gift card attempts. Please wait a minute and try again.", 60);
  }
}

app.openapi(createRoute({
  method: "post",
  path: "/apply",
  tags: ["Checkout"],
  summary: "Apply a gift card to checkout",
  description: "Proves a gift-card code and returns an opaque apply handle for the tax quote and the order. Any unusable card (unknown, disabled, expired, spent or in another currency) answers the same way.",
  request: { body: { required: true, content: { "application/json": { schema: codeBodySchema } } } },
  responses: {
    200: { description: "The card can pay", content: { "application/json": { schema: successEnvelope(appliedGiftCardSchema) } } },
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
}), async (c) => {
  noStore(c);
  const { code } = c.req.valid("json");
  await enforceGiftCardRateLimit(c.env, c.req.raw, "gift-card-apply");
  const masterSecret = readMasterSecret(c.env);
  if (!masterSecret) throw new ServiceUnavailableError("Gift cards are unavailable right now.");
  const db = c.get("db");
  const currency = await getCurrencySettings(db);
  const applied = await applyGiftCardCode(db, {
    code,
    currencyCode: currency.currencyCode,
    credentialEncryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
    masterSecret,
  });
  return ok(c, {
    handle: applied.handle,
    handleExpiresAt: iso(applied.handleExpiresAt),
    last4: applied.last4,
    balance: fromMinor(applied.balanceMinor, getDecimalPlaces(applied.currencyCode)),
    balanceMinor: applied.balanceMinor,
    currencyCode: applied.currencyCode,
    expiresAt: applied.expiresAt === null ? null : iso(applied.expiresAt),
  });
});

app.openapi(createRoute({
  method: "post",
  path: "/balance",
  tags: ["Checkout"],
  summary: "Check a gift card balance",
  description: "The last 4 characters, balance, expiry and status of a gift card, from its code in the POST body.",
  request: { body: { required: true, content: { "application/json": { schema: codeBodySchema } } } },
  responses: {
    200: { description: "Gift card balance", content: { "application/json": { schema: successEnvelope(giftCardBalanceSchema) } } },
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
}), async (c) => {
  noStore(c);
  const { code } = c.req.valid("json");
  await enforceGiftCardRateLimit(c.env, c.req.raw, "gift-card-balance");
  const balance = await checkGiftCardBalance(c.get("db"), {
    code,
    credentialEncryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
  });
  return ok(c, {
    last4: balance.last4,
    balance: fromMinor(balance.balanceMinor, getDecimalPlaces(balance.currencyCode)),
    balanceMinor: balance.balanceMinor,
    currencyCode: balance.currencyCode,
    expiresAt: balance.expiresAt === null ? null : iso(balance.expiresAt),
    status: balance.status,
  });
});

export { app as checkoutGiftCardRoutes };
