import type { DatabaseSync } from "node:sqlite";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
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

    const test = createSqliteD1Database();
    sqlite = test.sqlite;
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare("INSERT INTO user (id, name, email) VALUES (?, 'Owner', 'owner@example.test')").run(ownerUserId);
    sqlite.prepare(`
      INSERT INTO agent_grants (id, kind, owner_user_id, resource, label, oauth_client_id, oauth_redirect_uris_json,
        preset, risk_ceiling, authority_revision, status, expires_at, created_at, updated_at)
      VALUES (?, 'oauth', ?, 'dashboard', 'Agent', 'client-1', '[]', 'full', 'security', 1, 'active', ?, ?, ?)
    `).run(grantId, ownerUserId, now + 3_600, now - 60, now - 60);
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
