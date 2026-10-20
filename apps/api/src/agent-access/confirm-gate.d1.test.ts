// The direct REST lane (a PAT or CLI credential calling /api/v1/admin itself)
// passes the same confirmation gate as MCP: a refund nobody approved writes
// nothing and answers 428 with an approval link for the grant's owner (never a
// token the caller could redeem itself); after the owner approves in the
// dashboard the retry with the approval id runs exactly once, and a replay or
// a declined approval never runs (audit R2 F3). Opt-in grant scopes hold here too.
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
import { APPROVAL_HEADER, decideAgentApproval } from "./approvals";

const OWNER = "00000000-0000-4000-8000-000000000043";
const GRANT = "agr_restconfirmrefund001";
const CREDENTIAL = "agc_restconfirm000000001";
const TOKEN = `sc_pat_${CREDENTIAL}_${"A".repeat(43)}`;

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
      permissions: new Set(["orders.view", "orders.refund", "conversations.view", "settings.general.view"]), riskCeiling: "security",
      authorityRevision: 1, expiresAt: new Date(Date.now() + 3_600_000),
    };
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare("INSERT INTO user (id, name, email) VALUES (?, 'Owner', 'owner@example.test')").run(OWNER);
    sqlite.prepare(`INSERT INTO agent_grants (id, kind, owner_user_id, resource, label, preset, permissions_json, risk_ceiling,
      authority_revision, status, expires_at, created_at, updated_at)
      VALUES (?, 'pat', ?, 'dashboard', 'CI', 'full', '["conversations.view","orders.refund","orders.view","settings.general.view"]', 'security', 1, 'active', ?, ?, ?)`)
      .run(GRANT, OWNER, now + 3_600, now - 60, now - 60);
    sqlite.prepare(`INSERT INTO agent_credentials (id, grant_id, kind, token_hash, token_hint, expires_at, created_at, updated_at)
      VALUES (?, ?, 'pat', ?, 'sc_pat_agc_restconf', ?, ?, ?)`)
      .run(CREDENTIAL, GRANT, "h".repeat(64), now + 3_600, now - 60, now - 60);
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

  it("hands out an approval link, runs the refund once after the owner approves, and refuses a replay", async () => {
    const refused = await call("POST", `/orders/${orderId}/refund`, refundBody);
    expect(refused.status, JSON.stringify(refused.body)).toBe(428);
    expect(refused.body.error).toMatchObject({
      code: "confirmation_required",
      details: { confirmation: {
        summary: expect.stringContaining("amount=500"),
        approvalId: expect.stringMatching(/^abh_/),
        approvalUrl: expect.stringMatching(/^https:\/\/dashboard\.example\.test\/admin\/settings\/agent-access\/approve\/abh_/),
        header: APPROVAL_HEADER,
      } },
    });
    expect(JSON.stringify(refused.body)).not.toMatch(/sct_|confirmToken/);
    expect(attempts()).toBe(0);
    const approvalId = refused.body.error.details.confirmation.approvalId as string;

    // Before the owner answers, the retry gets the same link and runs nothing.
    const early = await call("POST", `/orders/${orderId}/refund`, refundBody, { [APPROVAL_HEADER]: approvalId });
    expect(early.status).toBe(428);
    expect(early.body.error.details.confirmation).toMatchObject({ approvalId, header: APPROVAL_HEADER });
    expect(attempts()).toBe(0);

    // Someone else cannot approve it; the owner can, once.
    expect(await decideAgentApproval(db, approvalId, "00000000-0000-4000-8000-000000000099", "approve")).toBe(false);
    expect(await decideAgentApproval(db, approvalId, OWNER, "approve")).toBe(true);
    expect(await decideAgentApproval(db, approvalId, OWNER, "approve")).toBe(false);

    // The approval covers exactly the approved input.
    const otherInput = await call("POST", `/orders/${orderId}/refund`, { ...refundBody, amount: 900 }, { [APPROVAL_HEADER]: approvalId });
    expect(otherInput.status).toBe(400);
    expect(otherInput.body.error.code).toBe("approval_invalid");
    expect(attempts()).toBe(0);

    const confirmed = await call("POST", `/orders/${orderId}/refund`, refundBody, { [APPROVAL_HEADER]: approvalId });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(attempts()).toBe(1);

    const replay = await call("POST", `/orders/${orderId}/refund`, refundBody, { [APPROVAL_HEADER]: approvalId });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe("approval_invalid");
    expect(attempts()).toBe(1);
  }, 60_000);

  it("never runs a change its owner declined", async () => {
    const refused = await call("POST", `/orders/${orderId}/refund`, refundBody);
    const approvalId = refused.body.error.details.confirmation.approvalId as string;
    expect(await decideAgentApproval(db, approvalId, OWNER, "decline")).toBe(true);
    expect(await decideAgentApproval(db, approvalId, OWNER, "approve")).toBe(false);
    const retry = await call("POST", `/orders/${orderId}/refund`, refundBody, { [APPROVAL_HEADER]: approvalId });
    expect(retry.status).toBe(400);
    expect(retry.body.error.code).toBe("approval_invalid");
    expect(attempts()).toBe(0);
  });

  it("never accepts a self-made approval id", async () => {
    const forged = await call("POST", `/orders/${orderId}/refund`, refundBody, { [APPROVAL_HEADER]: `abh_${"x".repeat(20)}` });
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe("approval_invalid");
    expect(attempts()).toBe(0);
  });

  it("runs a security read (a GET tagged security) without asking anyone", async () => {
    const email = await call("GET", "/settings/email");
    expect(email.status, JSON.stringify(email.body)).toBe(200);
  });

  it("lets reads through and keeps opt-in scopes away from preset grants", async () => {
    expect((await call("GET", `/orders/${orderId}`)).status).toBe(200);
    const inbox = await call("GET", "/conversations");
    expect(inbox.status).toBe(403);
  });
});
