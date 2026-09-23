import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  purgeRevokedAgentGrants: vi.fn(),
  deleteAgentArtifactObjects: vi.fn(),
  logOpsEvent: vi.fn(),
}));

vi.mock("@scalius/core/modules/agent-access/agent-access.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/agent-access/agent-access.service")>()),
  purgeRevokedAgentGrants: mocks.purgeRevokedAgentGrants,
}));
vi.mock("../../agent-access/artifact-delivery", () => ({
  deleteAgentArtifactObjects: mocks.deleteAgentArtifactObjects,
}));
vi.mock("../../utils/ops-log", () => ({ logOpsEvent: mocks.logOpsEvent }));

import { errorResponseFromError } from "../../utils/api-response";
import { adminAgentAccessRoutes } from "./agent-access";

const env = { BUCKET: { delete: vi.fn() } } as unknown as Env;

function createApp(options: {
  user?: Record<string, unknown>;
  session?: { twoFactorVerified?: boolean } | null;
  agentPrincipal?: Record<string, unknown>;
} = {}) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", { tag: "db" } as never);
    c.set("user", {
      id: "user_1",
      isSuperAdmin: true,
      twoFactorEnabled: true,
      ...options.user,
    } as never);
    if (options.session !== null) {
      c.set("session", { id: "session_1", twoFactorVerified: true, ...options.session } as never);
    }
    if (options.agentPrincipal) c.set("agentPrincipal", options.agentPrincipal as never);
    c.set("adminPermissions", new Set(["agent_access.manage"]) as never);
    await next();
  });
  app.route("/agent-access", adminAgentAccessRoutes);
  return app;
}

function purge(app: OpenAPIHono<{ Bindings: Env }>, query = "") {
  return app.request(`/api/v1/admin/agent-access/connections/revoked${query}`, { method: "DELETE" }, env);
}

describe("DELETE /admin/agent-access/connections/revoked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.purgeRevokedAgentGrants.mockResolvedValue({
      status: "purged",
      count: 2,
      credentials: 3,
      artifacts: 1,
    });
    mocks.deleteAgentArtifactObjects.mockResolvedValue({ deletedIds: ["aah_1"], failed: 1 });
  });

  it("purges through the service, deletes artifact objects before rows, and logs masked counts", async () => {
    const response = await purge(createApp(), "?resource=storefront");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { status: "purged", count: 2, credentials: 3, artifacts: 1 },
    });
    expect(mocks.purgeRevokedAgentGrants).toHaveBeenCalledTimes(1);
    const [db, options] = mocks.purgeRevokedAgentGrants.mock.calls[0] as [
      unknown,
      { resource?: string; onArtifactsPurging: (artifacts: unknown[]) => Promise<void> },
    ];
    expect(db).toEqual({ tag: "db" });
    expect(options.resource).toBe("storefront");

    const artifacts = [{ id: "aah_1", r2Key: "private/agent-artifacts/agr_1/a" }];
    await options.onArtifactsPurging(artifacts);
    expect(mocks.deleteAgentArtifactObjects).toHaveBeenCalledWith(env, artifacts);

    expect(mocks.logOpsEvent).toHaveBeenCalledWith("info", "agent_access.connections.purged", {
      actorUserId: "user_1",
      resource: "storefront",
      count: 2,
      credentials: 3,
      artifacts: 1,
      artifactObjectFailures: 0,
    });
  });

  it("defaults the resource filter to every resource", async () => {
    const response = await purge(createApp());

    expect(response.status).toBe(200);
    expect(mocks.purgeRevokedAgentGrants.mock.calls[0]?.[1]).toMatchObject({ resource: undefined });
    expect(mocks.logOpsEvent.mock.calls[0]?.[2]).toMatchObject({ resource: "all" });
  });

  it("rejects an invalid resource before touching data", async () => {
    const response = await purge(createApp(), "?resource=everything");

    expect(response.status).toBe(400);
    expect(mocks.purgeRevokedAgentGrants).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-super-admin", { user: { isSuperAdmin: false } }],
    ["a super admin without 2FA", { user: { twoFactorEnabled: false } }],
    ["a session that has not verified 2FA", { session: { twoFactorVerified: false } }],
    ["a session-less request", { session: null }],
    ["an agent principal whose owner is not a super admin", {
      agentPrincipal: { ownerUserId: "user_1", isSuperAdmin: false },
    }],
  ] as const)("refuses %s with 403 and never purges", async (_label, options) => {
    const response = await purge(createApp(options));

    expect(response.status).toBe(403);
    expect(mocks.purgeRevokedAgentGrants).not.toHaveBeenCalled();
    expect(mocks.logOpsEvent).not.toHaveBeenCalled();
  });
});
