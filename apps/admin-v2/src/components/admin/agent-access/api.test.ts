import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  approveAgentAuthorizationRequest,
  approveAgentDeviceAuthorization,
  countClearableAgentConnections,
  createAgentToken,
  getAgentAuthorizationRequest,
  listAgentConnections,
  lookupAgentDeviceAuthorization,
  purgeRevokedAgentConnections,
  denyAgentDeviceAuthorization,
  revokeAgentGrant,
} from "./api";

// These run through the real SDK client and admin transport; only the wire is
// stubbed (the browser transport calls same-origin `/api/v1/*`).
interface WireCall {
  method: string;
  path: string;
  body: unknown;
}

let calls: WireCall[] = [];
let responses: unknown[] = [];

beforeEach(() => {
  calls = [];
  responses = [];
  vi.stubGlobal("fetch", vi.fn(async (target: string, init: RequestInit = {}) => {
    const url = new URL(target, "https://dashboard.test");
    calls.push({
      method: init.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Response.json({ success: true, data: responses.shift() ?? {} });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Agent Access dashboard API client", () => {
  it("uses the admin API for paginated connection reads", async () => {
    await listAgentConnections({
      page: 2,
      limit: 20,
      status: "active",
      resource: "dashboard",
      kind: "oauth",
    });

    expect(calls).toEqual([
      {
        method: "GET",
        path: "/api/v1/admin/agent-access/connections?page=2&limit=20&status=active&resource=dashboard&kind=oauth",
        body: undefined,
      },
    ]);
  });

  it("sends token, OAuth, and CLI grant decisions in request bodies", async () => {
    const selection = {
      resource: "dashboard" as const,
      preset: "full" as const,
      permissions: [],
      riskCeiling: "security" as const,
      expiresInDays: 30,
    };
    const approval = {
      preset: "full",
      permissions: [],
      riskCeiling: "security",
      expiresInDays: 30,
    };
    responses.push({}, {}, { deviceAuthorization: {} }, {});

    await createAgentToken({ ...selection, label: "Codex" });
    await approveAgentAuthorizationRequest("auth_1", selection);
    await lookupAgentDeviceAuthorization("AB12CD34");
    await approveAgentDeviceAuthorization("dev_1", selection);

    expect(calls.map(({ method, path, body }) => [method, path, body])).toEqual([
      ["POST", "/api/v1/admin/agent-access/tokens", { ...selection, label: "Codex" }],
      ["POST", "/api/v1/admin/agent-access/authorization-requests/auth_1/approve", approval],
      ["POST", "/api/v1/admin/agent-access/device-authorizations/lookup", { userCode: "AB12CD34" }],
      ["POST", "/api/v1/admin/agent-access/device-authorizations/dev_1/approve", approval],
    ]);
  });

  it("unwraps OAuth and device lookup objects and sends required empty bodies", async () => {
    const authorizationRequest = { id: "auth_1" };
    const deviceAuthorization = { id: "dev_1" };
    responses.push({ authorizationRequest }, { deviceAuthorization }, {});

    await expect(getAgentAuthorizationRequest("auth_1")).resolves.toEqual(
      authorizationRequest,
    );
    await expect(lookupAgentDeviceAuthorization("AB12CD34")).resolves.toEqual(
      deviceAuthorization,
    );
    await denyAgentDeviceAuthorization("dev_1");

    expect(calls[2]).toMatchObject({
      path: "/api/v1/admin/agent-access/device-authorizations/dev_1/deny",
      body: {},
    });
  });

  it("clears revoked and expired connections through the documented purge route", async () => {
    const purged = { status: "purged", count: 4, credentials: 3, artifacts: 1 };
    responses.push(purged, purged);

    await expect(purgeRevokedAgentConnections()).resolves.toEqual(purged);
    await purgeRevokedAgentConnections("storefront");

    expect(calls.map(({ method, path }) => [method, path])).toEqual([
      ["DELETE", "/api/v1/admin/agent-access/connections/revoked"],
      ["DELETE", "/api/v1/admin/agent-access/connections/revoked?resource=storefront"],
    ]);
  });

  it("counts clearable connections from the revoked and expired list filters", async () => {
    responses.push(
      { connections: [], pagination: { page: 1, limit: 1, total: 3, totalPages: 3 } },
      { connections: [], pagination: { page: 1, limit: 1, total: 2, totalPages: 2 } },
    );

    await expect(countClearableAgentConnections()).resolves.toEqual({
      revoked: 3,
      expired: 2,
      total: 5,
    });
    expect(calls.map(({ path }) => path).sort()).toEqual([
      "/api/v1/admin/agent-access/connections?page=1&limit=1&status=expired",
      "/api/v1/admin/agent-access/connections?page=1&limit=1&status=revoked",
    ]);
  });

  it("revokes a grant through the documented DELETE route", async () => {
    await revokeAgentGrant("agr_1", "Retired machine");

    expect(calls).toEqual([{
      method: "DELETE",
      path: "/api/v1/admin/agent-access/grants/agr_1",
      body: { reason: "Retired machine" },
    }]);
  });
});
