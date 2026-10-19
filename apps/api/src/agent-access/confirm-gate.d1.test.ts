// The direct REST lane (a PAT or CLI credential calling /api/v1/admin itself)
// passes the same confirmation gate as MCP: a refund without the merchant's
// confirm token writes nothing and answers 428 with a token, the token runs it
// exactly once, and a replay is refused. Opt-in grant scopes hold here too.
import "@hono/zod-openapi";
import { Buffer } from "node:buffer";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { Database } from "@scalius/database/client";
import type { AgentPrincipal } from "./types";

const state = vi.hoisted(() => ({ principal: null as AgentPrincipal | null }));
vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));
vi.mock("./principal", () => ({
  resolveAgentPrincipalFromBearer: vi.fn(async () => state.principal),
  resolveAgentPrincipalFromGrant: vi.fn(async () => state.principal),
}));

import { createOrder } from "@scalius/core/modules/orders";
import { fetchRuntimeApiApp } from "../runtime/fetch-runtime-app";
import { CONFIRM_TOKEN_HEADER } from "./confirm-gate";

const OWNER = "00000000-0000-4000-8000-000000000043";
const GRANT = "agr_restconfirmrefund001";
const TOKEN = `sc_pat_agc_restconfirm000000001_${"A".repeat(43)}`;

describe("the confirmation gate on the direct REST lane", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;
  let orderId: string;
  let background: Promise<unknown>[];
  const settle = async () => {
    while (background.length > 0) await Promise.allSettled(background.splice(0));
  };
  const ctx = () => ({
    waitUntil: vi.fn((promise: Promise<unknown>) => { background.push(promise); }),
    passThroughOnException: vi.fn(),
    props: {},
  }) as unknown as ExecutionContext;

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetchRuntimeApiApp(new Request(`https://api.example.test/api/v1/admin${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, ctx());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions inspect the wire envelope.
    return { status: response.status, body: await response.json() as any };
  }

  beforeEach(async () => {
    background = [];
    const harness = createSqliteD1Database();
    sqlite = harness.sqlite;
    db = harness.db;
    state.principal = {
      kind: "agent", grantId: GRANT, credentialId: "agc_restconfirm000000001", ownerUserId: OWNER, isSuperAdmin: false,
      resource: "dashboard", grantKind: "pat", preset: "full",
      permissions: new Set(["orders.view", "orders.refund", "conversations.view"]), riskCeiling: "financial",
      authorityRevision: 1, expiresAt: new Date(Date.now() + 3_600_000),
    };
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare("INSERT INTO user (id, name, email) VALUES (?, 'Owner', 'owner@example.test')").run(OWNER);
    sqlite.prepare(`INSERT INTO agent_grants (id, kind, owner_user_id, resource, label, preset, permissions_json, risk_ceiling,
      authority_revision, status, expires_at, created_at, updated_at)
      VALUES (?, 'pat', ?, 'dashboard', 'CI', 'full', '["conversations.view","orders.refund","orders.view"]', 'financial', 1, 'active', ?, ?, ?)`)
      .run(GRANT, OWNER, now + 3_600, now - 60, now - 60);
    sqlite.exec(`
      INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
      VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'North', 'BD', 2, 'city_1', '{}', '{}', 1);
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('product_1', 'Kurta', 'kurta', 80000, 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory)
      VALUES ('variant_1', 'product_1', 'KURTA-M', 80000, 25, 0, 0, 1, 1);
    `);
    ({ id: orderId } = await createOrder(db, {
      requestKey: crypto.randomUUID(),
      customerName: "Rahim Uddin",
      customerPhone: "+8801712345601",
      customerEmail: null,
      shippingAddress: "House 1, Road 2, Gulshan",
      city: "city_1",
      zone: "zone_1",
      area: null,
      notes: null,
      items: [{ productId: "product_1", variantId: "variant_1", quantity: 2 }],
      discountAmount: null,
      shippingCharge: 80,
    } as never, OWNER));
    sqlite.prepare(`INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status, cod_collected_by, created_at, updated_at)
      VALUES (?, ?, 168000, 'BDT', 'cod', 'full', 'succeeded', 'Rider', unixepoch(), unixepoch())`).run(`pay_cod_${orderId}`, orderId);
    sqlite.prepare(`UPDATE orders SET paid_amount_minor = 168000, balance_due_minor = 0, payment_status = 'paid', payment_method = 'cod' WHERE id = ?`).run(orderId);
    env = {
      DB: harness.binding,
      PUBLIC_API_BASE_URL: "https://api.example.test",
      STOREFRONT_URL: "https://storefront.example.test",
      BETTER_AUTH_URL: "https://dashboard.example.test",
      SCALIUS_SECRET: "rest-confirm-test-master-secret-0123456789",
      AGENT_TOKEN_PEPPER: "rest-confirm-test-pepper",
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      RL_STANDARD: { limit: vi.fn(async () => ({ success: true })) },
    } as unknown as Env;
  }, 60_000);

  afterEach(async () => {
    await settle();
    sqlite.close();
  });

  const attempts = () => (sqlite.prepare("SELECT COUNT(*) AS count FROM refund_attempts WHERE order_id = ?").get(orderId) as { count: number }).count;
  const refundBody = { amount: 500, reason: "requested_by_customer", manualSettlementConfirmed: true, requestKey: "rest-confirm-refund-0001" };

  it("refuses an unconfirmed refund, runs it once with the token, and refuses a replay", async () => {
    const refused = await call("POST", `/orders/${orderId}/refund`, refundBody);
    expect(refused.status, JSON.stringify(refused.body)).toBe(428);
    expect(refused.body.error).toMatchObject({
      code: "confirmation_required",
      details: { confirmation: { summary: expect.stringContaining("amount=500"), confirmToken: expect.stringMatching(/^sct_/), header: CONFIRM_TOKEN_HEADER } },
    });
    expect(attempts()).toBe(0);
    const token = refused.body.error.details.confirmation.confirmToken as string;

    // A token for another input does not open this one.
    const otherInput = await call("POST", `/orders/${orderId}/refund`, { ...refundBody, amount: 900 }, { [CONFIRM_TOKEN_HEADER]: token });
    expect(otherInput.status).toBe(400);
    expect(otherInput.body.error.code).toBe("confirm_token_invalid");
    expect(attempts()).toBe(0);

    const confirmed = await call("POST", `/orders/${orderId}/refund`, refundBody, { [CONFIRM_TOKEN_HEADER]: token });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(attempts()).toBe(1);

    const replay = await call("POST", `/orders/${orderId}/refund`, refundBody, { [CONFIRM_TOKEN_HEADER]: token });
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe("confirm_token_used");
    expect(attempts()).toBe(1);
  });

  it("lets reads through and keeps opt-in scopes away from preset grants", async () => {
    expect((await call("GET", `/orders/${orderId}`)).status).toBe(200);
    const inbox = await call("GET", "/conversations");
    expect(inbox.status).toBe(403);
  });
});
