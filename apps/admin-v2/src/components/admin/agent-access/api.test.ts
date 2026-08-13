import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock("~/lib/api", () => mocks);

import {
  approveAgentAuthorizationRequest,
  approveAgentDeviceAuthorization,
  createAgentToken,
  getAgentConnection,
  listAgentAuditEvents,
  listAgentConnections,
  lookupAgentDeviceAuthorization,
  revokeAgentGrant,
  rotateAgentToken,
  updateAgentGrant,
} from "./api";

describe("Agent Access dashboard API client", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it("uses the existing admin proxy for paginated connection and audit reads", async () => {
    mocks.apiGet
      .mockResolvedValueOnce({
        connections: [],
        pagination: { page: 2, limit: 20, total: 0, totalPages: 0 },
      })
      .mockResolvedValueOnce({
        events: [],
        pagination: { page: 3, limit: 10, total: 0, totalPages: 0 },
      });

    await listAgentConnections({
      page: 2,
      limit: 20,
      status: "active",
      resource: "dashboard",
      kind: "oauth",
    });
    await listAgentAuditEvents("agr_1", { page: 3, limit: 10 });

    expect(mocks.apiGet).toHaveBeenNthCalledWith(
      1,
      "/agent-access/connections",
      {
        page: "2",
        limit: "20",
        status: "active",
        resource: "dashboard",
        kind: "oauth",
      },
    );
    expect(mocks.apiGet).toHaveBeenNthCalledWith(
      2,
      "/agent-access/connections/agr_1/events",
      { page: "3", limit: "10" },
    );
  });

  it("unwraps detail and narrowing responses without inventing another gateway", async () => {
    const connection = { id: "agr_1" };
    mocks.apiGet.mockResolvedValue({ connection });
    mocks.apiPatch.mockResolvedValue({ connection });

    await expect(getAgentConnection("agr_1")).resolves.toBe(connection);
    await expect(
      updateAgentGrant("agr_1", {
        permissions: ["products.view"],
        riskCeiling: "read",
        expiresAt: "2026-09-01T00:00:00.000Z",
      }),
    ).resolves.toBe(connection);

    expect(mocks.apiPatch).toHaveBeenCalledWith(
      "/agent-access/grants/agr_1",
      {
        permissions: ["products.view"],
        riskCeiling: "read",
        expiresAt: "2026-09-01T00:00:00.000Z",
      },
    );
  });

  it("sends token, OAuth, and CLI grant decisions in request bodies", async () => {
    mocks.apiPost.mockResolvedValue({ status: "approved" });
    const selection = {
      resource: "dashboard" as const,
      preset: "full" as const,
      permissions: [],
      riskCeiling: "security" as const,
      expiresInDays: 30,
    };

    await createAgentToken({ ...selection, label: "Codex" });
    await rotateAgentToken("cred_1", 30);
    await approveAgentAuthorizationRequest("auth_1", selection);
    await lookupAgentDeviceAuthorization("AB12CD34");
    await approveAgentDeviceAuthorization("dev_1", selection);

    expect(mocks.apiPost).toHaveBeenNthCalledWith(
      1,
      "/agent-access/tokens",
      { ...selection, label: "Codex" },
    );
    expect(mocks.apiPost).toHaveBeenNthCalledWith(
      2,
      "/agent-access/tokens/cred_1/rotate",
      { expiresInDays: 30 },
    );
    expect(mocks.apiPost).toHaveBeenNthCalledWith(
      3,
      "/agent-access/authorization-requests/auth_1/approve",
      {
        preset: "full",
        permissions: [],
        riskCeiling: "security",
        expiresInDays: 30,
      },
    );
    expect(mocks.apiPost).toHaveBeenNthCalledWith(
      4,
      "/agent-access/device-authorizations/lookup",
      { userCode: "AB12CD34" },
    );
    expect(mocks.apiPost).toHaveBeenNthCalledWith(
      5,
      "/agent-access/device-authorizations/dev_1/approve",
      {
        preset: "full",
        permissions: [],
        riskCeiling: "security",
        expiresInDays: 30,
      },
    );
  });

  it("unwraps safe OAuth and device lookup objects and sends required empty bodies", async () => {
    const authorizationRequest = { id: "auth_1" };
    const deviceAuthorization = { id: "dev_1" };
    mocks.apiGet.mockResolvedValue({ authorizationRequest });
    mocks.apiPost
      .mockResolvedValueOnce({ deviceAuthorization })
      .mockResolvedValueOnce({ credentialId: "cred_1", token: "secret", connection: {} })
      .mockResolvedValueOnce({ status: "denied" });

    const { getAgentAuthorizationRequest, denyAgentDeviceAuthorization } =
      await import("./api");
    await expect(getAgentAuthorizationRequest("auth_1")).resolves.toBe(
      authorizationRequest,
    );
    await expect(lookupAgentDeviceAuthorization("AB12CD34")).resolves.toBe(
      deviceAuthorization,
    );
    await rotateAgentToken("cred_1");
    await denyAgentDeviceAuthorization("dev_1");

    expect(mocks.apiPost).toHaveBeenNthCalledWith(
      2,
      "/agent-access/tokens/cred_1/rotate",
      {},
    );
    expect(mocks.apiPost).toHaveBeenNthCalledWith(
      3,
      "/agent-access/device-authorizations/dev_1/deny",
      {},
    );
  });

  it("revokes a grant through the documented DELETE route", async () => {
    mocks.apiDelete.mockResolvedValue({ status: "revoked", grantId: "agr_1" });

    await revokeAgentGrant("agr_1", "Retired machine");

    expect(mocks.apiDelete).toHaveBeenCalledWith(
      "/agent-access/grants/agr_1",
      { reason: "Retired machine" },
    );
  });
});
