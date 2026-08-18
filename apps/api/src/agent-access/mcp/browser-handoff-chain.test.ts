import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import type { AgentOAuthProps, AgentPrincipal } from "../types";

const chain = vi.hoisted(() => ({
  operation: null as AgentOperationManifestEntry | null,
  principal: null as AgentPrincipal | null,
  props: null as AgentOAuthProps | null,
  continuationCode: `tpc_${"s".repeat(48)}`,
}));

vi.mock("agents/mcp/server", () => ({
  getMcpAuthContext: () => ({ props: chain.props }),
}));

vi.mock("../backend", () => ({
  loadAgentAccessBackend: vi.fn(async () => ({
    resolvePrincipal: vi.fn(async () => chain.principal),
    authorizeOperation: vi.fn(async () => true),
  })),
}));

vi.mock("./operations", () => ({
  getAuthorizedOperation: vi.fn(async (operationId: string) =>
    chain.operation?.operationId === operationId ? chain.operation : null),
  listAuthorizedOperations: vi.fn(async () => chain.operation ? [chain.operation] : []),
  summarizeOperation: vi.fn((operation: AgentOperationManifestEntry) => operation),
  describeOperation: vi.fn((operation: AgentOperationManifestEntry) => operation),
}));

vi.mock("../dispatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../dispatch")>();
  return {
    ...actual,
    dispatchAgentOperation: vi.fn(async () => ({
      operationId: "dashboard.theme.preview_session_create",
      status: 200,
      ok: true,
      requestId: "request-browser-handoff",
      contentType: "application/json",
      sensitiveContinuation: true,
      data: {
        continuation: {
          url: "https://storefront.example.test/theme-preview/continue",
          method: "POST",
          fields: {
            continuationCode: chain.continuationCode,
            path: "/products/example",
            device: "desktop",
          },
        },
      },
    })),
  };
});

import { AGENT_OPERATIONS } from "../../generated/agent-operations.gen";
import { createAgentMcpServer } from "./server";

interface D1Result {
  results: Record<string, SQLOutputValue>[];
  success: true;
  meta: Record<string, never>;
}

interface D1Statement {
  bind(...values: SQLInputValue[]): D1Statement;
  run(): Promise<D1Result>;
  all(): Promise<D1Result>;
  raw(): Promise<SQLOutputValue[][]>;
  first(column?: string): Promise<unknown>;
  execute(): D1Result;
}

function rows(statement: StatementSync, values: SQLInputValue[]) {
  return statement.all(...values) as Record<string, SQLOutputValue>[];
}

function d1Statement(
  sqlite: DatabaseSync,
  query: string,
  values: SQLInputValue[] = [],
): D1Statement {
  const execute = (): D1Result => ({
    results: rows(sqlite.prepare(query), values),
    success: true,
    meta: {},
  });
  return {
    bind: (...next) => d1Statement(sqlite, query, next),
    run: async () => execute(),
    all: async () => execute(),
    raw: async () => {
      const prepared = sqlite.prepare(query);
      prepared.setReturnArrays(true);
      return prepared.all(...values) as unknown as SQLOutputValue[][];
    },
    first: async (column) => {
      const row = rows(sqlite.prepare(query), values)[0];
      return column ? row?.[column] ?? null : row ?? null;
    },
    execute,
  };
}

function harness() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE agent_grants (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, owner_user_id TEXT,
      resource TEXT NOT NULL, authority_revision INTEGER NOT NULL,
      status TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE agent_browser_handoffs (
      id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, credential_id TEXT,
      owner_user_id TEXT NOT NULL, resource TEXT NOT NULL,
      operation_id TEXT NOT NULL, authority_revision INTEGER NOT NULL,
      encrypted_action TEXT NOT NULL, status TEXT NOT NULL,
      expires_at INTEGER NOT NULL, consumed_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  const binding = {
    prepare: (query: string) => d1Statement(sqlite, query),
    async batch(statements: D1Statement[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        if (sqlite.isTransaction) sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { sqlite, binding };
}

const grantId = "agr_0123456789abcdefghij";
const ownerUserId = "owner-browser-handoff";

function principal(): AgentPrincipal {
  return {
    kind: "agent",
    grantId,
    credentialId: null,
    ownerUserId,
    isSuperAdmin: true,
    resource: "dashboard",
    grantKind: "oauth",
    preset: "full",
    permissions: new Set(["settings.general.view"]),
    riskCeiling: "security",
    authorityRevision: 1,
    expiresAt: new Date(Date.now() + 3_600_000),
  };
}

describe("MCP secure browser handoff chain", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
    vi.clearAllMocks();
  });

  it("turns a sensitive continuation into an encrypted one-use resource link", async () => {
    const operation = AGENT_OPERATIONS.find((candidate) =>
      candidate.operationId === "dashboard.theme.preview_session_create");
    expect(operation).toMatchObject({
      exposure: "continuation",
      sensitiveOutput: true,
      continuationOutput: expect.any(Object),
    });
    chain.operation = operation!;
    chain.principal = principal();
    chain.props = {
      grantId,
      ownerUserId,
      resource: "dashboard",
      permissions: ["settings.general.view"],
      riskCeiling: "security",
      audience: ["https://api.example.test/api/v1/mcp/dashboard"],
    };

    const test = harness();
    sqlite = test.sqlite;
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare(`
      INSERT INTO agent_grants
        (id, kind, owner_user_id, resource, authority_revision, status, expires_at)
      VALUES (?, 'oauth', ?, 'dashboard', 1, 'active', ?)
    `).run(grantId, ownerUserId, now + 3_600);
    const env = {
      DB: test.binding,
      BETTER_AUTH_URL: "https://dashboard.example.test",
      PUBLIC_API_BASE_URL: "https://api.example.test",
      STOREFRONT_URL: "https://storefront.example.test",
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    } as unknown as Env;
    const server = createAgentMcpServer({
      surface: "dashboard",
      env,
      ctx: { waitUntil: vi.fn() } as unknown as ExecutionContext,
    });
    const read = Reflect.get(server, "_registeredTools")?.["operations.read"]
      ?.handler as ((input: unknown) => Promise<Record<string, unknown>>) | undefined;
    expect(read).toBeTypeOf("function");

    const result = await read!({
      operationId: operation!.operationId,
      input: { body: { path: "/products/example", device: "desktop" } },
    });
    expect(result, JSON.stringify(result)).not.toHaveProperty("isError");
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "resource_link",
        uri: expect.stringMatching(
          /^https:\/\/dashboard\.example\.test\/admin\/settings\/agent-access\/continue\/abh_[A-Za-z0-9_-]{20}$/,
        ),
      }),
    ]));
    expect(JSON.stringify(result)).not.toContain(chain.continuationCode);
    expect(JSON.stringify(result)).not.toContain("continuationCode");

    const row = sqlite.prepare(`
      SELECT encrypted_action encryptedAction, operation_id operationId, status
      FROM agent_browser_handoffs
    `).get() as Record<string, unknown>;
    expect(row).toMatchObject({
      operationId: operation!.operationId,
      status: "active",
      encryptedAction: expect.stringMatching(/^enc:/),
    });
    expect(String(row.encryptedAction)).not.toContain(chain.continuationCode);
  });
});
