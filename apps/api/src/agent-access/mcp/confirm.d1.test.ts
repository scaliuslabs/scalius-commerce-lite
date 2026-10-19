// Confirmation and dry run on a real refund: the MCP tool dispatches into the
// real Hono app on D1, so "writes nothing" is checked against every table.
import "@hono/zod-openapi";
import { Buffer } from "node:buffer";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { Database } from "@scalius/database/client";
import type { AgentAuditInput, AgentOAuthProps, AgentPrincipal } from "../types";

const state = vi.hoisted(() => ({ principal: null as AgentPrincipal | null, props: null as AgentOAuthProps | null }));
vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));
vi.mock("agents/mcp/server", () => ({ createMcpHandler: vi.fn(), getMcpAuthContext: () => ({ props: state.props }) }));
vi.mock("../principal", () => ({
  resolveAgentPrincipalFromBearer: vi.fn(async () => state.principal),
  resolveAgentPrincipalFromGrant: vi.fn(async () => state.principal),
}));
vi.mock("../backend", async () => {
  const { writeAgentAuditEvent } = await import("../audit");
  const { getDb } = await import("@scalius/database/client");
  return {
    loadAgentAccessBackend: vi.fn(async () => ({
      resolvePrincipal: vi.fn(async () => state.principal),
      authorizeOperation: vi.fn(async () => true),
      writeAudit: vi.fn(async (event: AgentAuditInput, env: Env) => writeAgentAuditEvent(getDb(env), event)),
    })),
  };
});

import { createOrder } from "@scalius/core/modules/orders";
import { createAgentMcpServer } from "./server";

const OWNER = "00000000-0000-4000-8000-000000000042";
const GRANT = "agr_confirmrefund0000001";

type ToolOutput = {
  isError?: boolean;
  structuredContent: {
    error?: Record<string, unknown>;
    confirmation?: { confirmToken: string; summary: string };
    [key: string]: unknown;
  };
};

/** Every row of every table except the agent audit trail (and the grant's last-used stamp it moves). */
function snapshot(sqlite: DatabaseSync): Record<string, unknown[]> {
  // Real tables only: virtual (search index) tables are maintained by triggers on these.
  const tables = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name`).all() as Array<{ name: string }>;
  const rows: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    if (name === "agent_audit_events" || name === "agent_grants" || name === "agent_credentials") continue;
    try {
      rows[name] = sqlite.prepare(`SELECT * FROM "${name}"`).all();
    } catch {
      // A shadow table of a virtual table cannot be read directly.
    }
  }
  expect(Object.keys(rows)).toEqual(expect.arrayContaining(["orders", "order_payments", "refund_attempts", "product_variants", "system_kv"]));
  return rows;
}

describe("confirmed refunds through MCP on D1", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;
  let orderId: string;
  let write: (args: Record<string, unknown>) => Promise<ToolOutput>;

  beforeEach(async () => {
    const harness = createSqliteD1Database();
    sqlite = harness.sqlite;
    db = harness.db;
    state.principal = {
      kind: "agent", grantId: GRANT, credentialId: null, ownerUserId: OWNER, isSuperAdmin: false, resource: "dashboard",
      grantKind: "oauth", preset: "operator", permissions: new Set(["orders.view", "orders.refund"]), riskCeiling: "financial",
      authorityRevision: 1, expiresAt: new Date(Date.now() + 3_600_000),
    };
    state.props = {
      grantId: GRANT, ownerUserId: OWNER, resource: "dashboard", permissions: ["orders.refund", "orders.view"],
      riskCeiling: "financial", audience: ["https://api.example.test/api/v1/mcp/dashboard"],
    };
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare("INSERT INTO user (id, name, email) VALUES (?, 'Owner', 'owner@example.test')").run(OWNER);
    sqlite.prepare(`INSERT INTO agent_grants (id, kind, owner_user_id, resource, label, oauth_client_id, oauth_redirect_uris_json,
      preset, permissions_json, risk_ceiling, authority_revision, status, expires_at, created_at, updated_at)
      VALUES (?, 'oauth', ?, 'dashboard', 'Agent', 'client-1', '[]', 'operator', '["orders.refund","orders.view"]', 'financial', 1, 'active', ?, ?, ?)`)
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
      SCALIUS_SECRET: "confirm-refund-test-master-secret-0123456789",
      AGENT_TOKEN_PEPPER: "confirm-refund-test-pepper",
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      RL_STANDARD: { limit: vi.fn(async () => ({ success: true })) },
    } as unknown as Env;
    const server = createAgentMcpServer({
      surface: "dashboard",
      env,
      ctx: { props: state.props, waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    });
    const handler = Reflect.get(server, "_registeredTools").scalius_write.handler;
    write = (args) => handler(args) as Promise<ToolOutput>;
  }, 60_000);

  afterEach(() => sqlite.close());

  const refund = () => ({
    operationId: "dashboard.orders.refund",
    input: {
      path: { id: orderId },
      body: { amount: 500, reason: "requested_by_customer", manualSettlementConfirmed: true, requestKey: "mcp-confirm-refund-0001" },
    },
  });
  const attempts = () => sqlite.prepare("SELECT COUNT(*) AS count FROM refund_attempts WHERE order_id = ?").get(orderId) as { count: number };
  const audits = () => sqlite.prepare("SELECT operation_id, outcome, error_class, http_status, metadata_json FROM agent_audit_events ORDER BY created_at, rowid").all() as Array<Record<string, unknown>>;

  it("dry-runs orders.refund without touching the ledger, payments or any other row", async () => {
    const before = snapshot(sqlite);
    const output = await write({ ...refund(), dryRun: true });
    expect(output.isError, JSON.stringify(output)).toBeUndefined();
    expect(output.structuredContent).toMatchObject({
      ok: true,
      dryRun: true,
      written: false,
      operationId: "dashboard.orders.refund",
      validated: true,
      confirmation: { summary: expect.stringContaining("amount=500"), confirmToken: expect.stringMatching(/^sct_/) },
    });
    expect(snapshot(sqlite)).toEqual(before);
    expect(audits()).toEqual([]);
  });

  it("writes nothing without a confirmation, runs exactly once with the token, and refuses a replay", async () => {
    const before = snapshot(sqlite);
    const refused = await write(refund());
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.error).toMatchObject({ code: "confirmation_required", retryable: true });
    expect(snapshot(sqlite)).toEqual(before);
    expect(audits()).toEqual([expect.objectContaining({
      operation_id: "dashboard.orders.refund",
      outcome: "denied",
      error_class: "confirmation_required",
    })]);

    const token = refused.structuredContent.confirmation!.confirmToken;
    const confirmed = await write({ ...refund(), confirmToken: token });
    expect(confirmed.isError, JSON.stringify(confirmed)).toBeUndefined();
    expect(confirmed.structuredContent).toMatchObject({ ok: true, meta: { operationId: "dashboard.orders.refund", status: 200 } });
    expect(attempts().count).toBe(1);
    const refundRows = sqlite.prepare("SELECT COUNT(*) AS count FROM order_payments WHERE order_id = ?").get(orderId) as { count: number };
    expect(refundRows.count).toBeGreaterThan(1);
    expect(audits().at(-1)).toMatchObject({ outcome: "success", http_status: 200, metadata_json: expect.stringContaining('"confirmedBy":"token"') });

    const afterConfirm = snapshot(sqlite);
    const replay = await write({ ...refund(), confirmToken: token });
    expect(replay.isError).toBe(true);
    expect(replay.structuredContent.error).toMatchObject({ code: "confirm_token_used", status: 409, current: null });
    expect(attempts().count).toBe(1);
    const { system_kv: _claims, ...unchanged } = snapshot(sqlite);
    const { system_kv: _before, ...expected } = afterConfirm;
    expect(unchanged).toEqual(expected);
  });
});
