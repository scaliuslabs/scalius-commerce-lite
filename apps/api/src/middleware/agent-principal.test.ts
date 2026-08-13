import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveBearer: vi.fn(),
  resolveGrant: vi.fn(),
  resolveOperation: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("../agent-access/principal", () => ({
  resolveAgentPrincipalFromBearer: mocks.resolveBearer,
  resolveAgentPrincipalFromGrant: mocks.resolveGrant,
}));

vi.mock("../agent-access/direct-operation", () => ({
  resolveDirectAgentOperation: mocks.resolveOperation,
}));

vi.mock("../agent-access/audit", () => ({
  writeAgentAuditEvent: mocks.writeAudit,
}));

import { agentPrincipalMiddleware } from "./agent-principal";

const TOKEN = `sc_pat_agc_0123456789abcdefghij_${"a".repeat(43)}`;
const MAX_CONTEXT_BYTES = 1024 * 1024;

function testApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
    await agentPrincipalMiddleware(c, next);
  });
  app.post("/api/v1/storefront/agent-contexts", async (c) => {
    const text = await c.req.text();
    return c.json({ text, length: new TextEncoder().encode(text).byteLength });
  });
  app.onError((error) => {
    const status = (error as Error & { status?: unknown }).status;
    return new Response(JSON.stringify({
      code: (error as Error & { code?: unknown }).code,
      message: error.message,
    }), {
      status: typeof status === "number" ? status : 500,
      headers: { "Content-Type": "application/json" },
    });
  });
  return app;
}

function env(): Env {
  return {
    AGENT_TOKEN_PEPPER: "pepper",
    AGENT_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
  } as unknown as Env;
}

describe("storefront direct-agent manifest body boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveBearer.mockResolvedValue({
      kind: "agent",
      grantId: "agr_0123456789abcdefghij",
      credentialId: "agc_0123456789abcdefghij",
      ownerUserId: "owner-1",
      isSuperAdmin: true,
      resource: "storefront",
      grantKind: "pat",
      preset: "custom",
      permissions: new Set(["agent_access.view"]),
      riskCeiling: "write",
      authorityRevision: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });
    mocks.resolveOperation.mockReturnValue({
      operationId: "storefront.context.create",
      exposure: "execute",
      surface: "storefront",
      principals: ["visitor", "customer"],
      risk: "write",
      rbac: { type: "agentGrant" },
      maxRequestBytes: MAX_CONTEXT_BYTES,
    });
    mocks.writeAudit.mockResolvedValue(undefined);
  });

  it("rejects an oversized declared body before the context handler parses it", async () => {
    const response = await testApp().request("/api/v1/storefront/agent-contexts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": String(MAX_CONTEXT_BYTES + 1),
      },
      body: "{}",
    }, env());
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("rejects an oversized body with no declared length", async () => {
    const response = await testApp().request("/api/v1/storefront/agent-contexts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: new Uint8Array(MAX_CONTEXT_BYTES + 1),
    }, env());
    expect(response.status).toBe(413);
  });

  it("reconstructs a bounded JSON body exactly once for downstream parsing", async () => {
    const body = JSON.stringify({ label: "buyer context" });
    const response = await testApp().request("/api/v1/storefront/agent-contexts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body,
    }, env());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      text: body,
      length: new TextEncoder().encode(body).byteLength,
    });
  });
});
