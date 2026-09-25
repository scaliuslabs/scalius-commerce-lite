// G8: the public apply and balance routes answer every unusable card the same
// way, never echo the code, are no-store, and fail closed without the limiter
// or the durable key.
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { issueManualGiftCard, openGiftCardApplyHandle } from "@scalius/core/modules/gift-cards";
import { formatGiftCardCode } from "@scalius/shared/gift-card-code";
import { errorResponseFromError } from "../utils/api-response";
import { checkoutGiftCardRoutes } from "./checkout-gift-cards";

const KEY = "test-credential-encryption-key-0123456789abcdef";
const MASTER = "test-master-secret-0123456789abcdefghijklmnopqrstuvwxyz";

function setup(options: { limited?: boolean; noLimiter?: boolean; noKey?: boolean } = {}) {
  const { sqlite, db } = createSqliteD1Database();
  sqlite.exec("INSERT INTO user (id, name, email) VALUES ('admin_1', 'Nadia', 'nadia@example.test')");
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/checkout/gift-cards", checkoutGiftCardRoutes);
  const limiter = { limit: async () => ({ success: !options.limited }) };
  const env = {
    SCALIUS_SECRET: MASTER,
    ...(options.noKey ? {} : { CREDENTIAL_ENCRYPTION_KEY: KEY }),
    ...(options.noLimiter ? {} : { RL_STRICT: limiter, RL_STANDARD: limiter }),
    PUBLIC_API_BASE_URL: "https://api.shop.test",
  } as unknown as Env;
  const post = async (path: string, body: unknown) => {
    const response = await app.request(`/api/v1/checkout/gift-cards${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
      body: JSON.stringify(body),
    }, env);
    const text = await response.text();
    return { status: response.status, cache: response.headers.get("Cache-Control"), text, body: JSON.parse(text) };
  };
  return { db, sqlite, post };
}

async function issue(db: Parameters<typeof issueManualGiftCard>[0], requestKey: string, amountMinor = 50_000) {
  return issueManualGiftCard(db, KEY, {
    requestKey,
    amountMinor,
    currencyCode: "BDT",
    expiresAt: null,
    customerId: null,
    recipient: null,
    message: null,
    note: null,
    actorUserId: "admin_1",
  });
}

describe("checkout gift-card routes (G8)", () => {
  it("applies a usable card with a sealed handle, no-store and without echoing the code", async () => {
    const { db, post } = setup();
    const card = await issue(db, "route-request-0001");
    const response = await post("/apply", { code: formatGiftCardCode(card.code).toLowerCase() });
    expect(response.status).toBe(200);
    expect(response.cache).toContain("no-store");
    expect(response.text).not.toContain(card.code);
    expect(response.body.data).toMatchObject({ last4: card.code.slice(-4), balance: 500, balanceMinor: 50_000, currencyCode: "BDT", expiresAt: null });
    expect(await openGiftCardApplyHandle(MASTER, response.body.data.handle)).toBe(card.giftCardId);
  });

  it("answers unknown, malformed, disabled and spent cards with one message", async () => {
    const { db, sqlite, post } = setup();
    const disabled = await issue(db, "route-request-0002");
    sqlite.exec(`UPDATE gift_cards SET status = 'disabled' WHERE id = '${disabled.giftCardId}'`);
    const answers = [
      await post("/apply", { code: "0000-0000-0000-0000" }),
      await post("/apply", { code: "hello" }),
      await post("/apply", { code: disabled.code }),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(400);
      expect(answer.body.error).toEqual({ code: "GIFT_CARD_UNUSABLE", message: "This gift card can't be used." });
    }
  });

  it("shows a balance without the code and a uniform not-found", async () => {
    const { db, post } = setup();
    const card = await issue(db, "route-request-0003", 12_300);
    const found = await post("/balance", { code: card.code });
    expect(found.status).toBe(200);
    expect(found.text).not.toContain(card.code);
    expect(found.body.data).toEqual({ last4: card.code.slice(-4), balance: 123, balanceMinor: 12_300, currencyCode: "BDT", expiresAt: null, status: "active" });
    const missing = await post("/balance", { code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("GIFT_CARD_NOT_FOUND");
  });

  it("rate limits, and fails closed without a limiter or the durable key", async () => {
    const limited = setup({ limited: true });
    expect((await limited.post("/apply", { code: "0000-0000-0000-0000" })).status).toBe(429);
    const noLimiter = setup({ noLimiter: true });
    expect((await noLimiter.post("/balance", { code: "0000-0000-0000-0000" })).status).toBe(503);
    const noKey = setup({ noKey: true });
    const answer = await noKey.post("/apply", { code: "0000-0000-0000-0000" });
    expect(answer.status).toBe(503);
    expect(answer.body.error.message).toBe("Gift cards are unavailable right now.");
  });

  it("refuses codes outside a POST JSON body", async () => {
    const { post } = setup();
    expect((await post("/apply", { code: "x", extra: true })).status).toBe(400);
  });
});
