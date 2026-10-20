import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A key the store owner creates with approvals off records that choice for
// its grant; the default (and every view-only key) leaves the policy alone.
const mocks = vi.hoisted(() => ({
  createCredentialGrant: vi.fn(),
  getAgentConnection: vi.fn(),
  writeAgentConfirmPolicy: vi.fn(),
}));

vi.mock("@scalius/core/modules/agent-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/agent-access")>()),
  createCredentialGrant: mocks.createCredentialGrant,
  getAgentConnection: mocks.getAgentConnection,
}));
vi.mock("../../agent-access/mcp/confirm", () => ({ writeAgentConfirmPolicy: mocks.writeAgentConfirmPolicy }));

import { errorResponseFromError } from "../../utils/api-response";
import { adminAgentAccessRoutes } from "./agent-access";

const env = { AGENT_TOKEN_PEPPER: "p".repeat(32) } as unknown as Env;

function createApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", { tag: "db" } as never);
    c.set("user", { id: "user_1", isSuperAdmin: true, twoFactorEnabled: true } as never);
    c.set("session", { id: "session_1", twoFactorVerified: true } as never);
    c.set("adminPermissions", new Set(["agent_access.manage", "orders.view", "orders.edit", "conversations.view", "conversations.reply"]) as never);
    await next();
  });
  app.route("/agent-access", adminAgentAccessRoutes);
  return app;
}

const create = (body: unknown) => createApp().request("/api/v1/admin/agent-access/tokens", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}, env);

const custom = { preset: "custom", resource: "dashboard", permissions: ["conversations.view", "conversations.reply"], riskCeiling: "write", label: "Inbox helper" };

describe("POST /admin/agent-access/tokens confirmation policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createCredentialGrant.mockResolvedValue({ grantId: "grant_new" });
    mocks.getAgentConnection.mockResolvedValue({ id: "grant_new" });
  });

  it("records approvals off for the owner's custom key", async () => {
    const response = await create({ ...custom, confirmPolicy: "none" });
    expect(response.status).toBe(201);
    expect(mocks.createCredentialGrant.mock.calls[0]![1].selection).toMatchObject({
      preset: "custom",
      permissions: ["conversations.reply", "conversations.view"],
      riskCeiling: "write",
    });
    expect(mocks.writeAgentConfirmPolicy).toHaveBeenCalledWith(env, "grant_new", "none");
  });

  it("keeps approvals on by default and for view-only keys", async () => {
    expect((await create(custom)).status).toBe(201);
    expect((await create({ ...custom, confirmPolicy: "destructive_financial" })).status).toBe(201);
    expect((await create({ preset: "read", resource: "dashboard", confirmPolicy: "none" })).status).toBe(201);
    expect(mocks.writeAgentConfirmPolicy).not.toHaveBeenCalled();
  });
});
