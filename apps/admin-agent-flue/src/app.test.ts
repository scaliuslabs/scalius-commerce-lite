import { describe, expect, it } from "vitest";
import { issueScaliusComputerCommand } from "@scalius/shared/assistant-computer-handoff";
import app, { createAdminCanaryApp } from "./app";
import { createThreadInstanceId } from "./thread-identity";

const AUTH_TOKEN = "admin-app-test-auth-token-at-least-32-bytes";
const THREAD_KEY = "admin-app-test-thread-key-at-least-32-bytes";
const COMPUTER_KEY = "admin-app-test-computer-key-at-least-32-bytes";
const IDENTITY = { tenantId: "merchant_a", principalId: "admin_1", threadId: "thread_1" };

describe("admin Flue canary app", () => {
  it("serves a no-store health response without exposing agent routes", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "scalius-admin-agent-flue-canary",
      runtime: "flue-cloudflare",
      version: "0.1.0",
    });
  });

  it("fails closed before Flue admission when credentials are absent", async () => {
    const [absent, partiallyConfigured] = await Promise.all([
      app.request("/agents/admin-copilot/guessed-thread"),
      app.request(
        "/agents/admin-copilot/guessed-thread",
        { headers: { Authorization: `Bearer ${"a".repeat(32)}` } },
        { CANARY_AUTH_TOKEN: "a".repeat(32) } as never,
      ),
    ]);
    expect(absent.status).toBe(404);
    expect(absent.headers.get("cache-control")).toBe("no-store");
    expect(partiallyConfigured.status).toBe(404);
  });

  it("queues only an exact signed browser result on the same Admin thread", async () => {
    const instanceId = await createThreadInstanceId("admin", IDENTITY, THREAD_KEY);
    const command = await issueScaliusComputerCommand({
      surface: "admin",
      agentName: "admin-copilot",
      instanceId,
      program: "observe",
      signingKey: COMPUTER_KEY,
    });
    const dispatched: unknown[] = [];
    const testApp = createAdminCanaryApp({
      dispatchComputerResult: async (id, continuation) => {
        dispatched.push({ id, continuation });
        return { dispatchId: "dispatch_admin_1", acceptedAt: new Date().toISOString() };
      },
    });
    const headers = {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "X-Scalius-Tenant-Id": IDENTITY.tenantId,
      "X-Scalius-Principal-Id": IDENTITY.principalId,
      "X-Scalius-Thread-Id": IDENTITY.threadId,
      "Content-Type": "application/json",
    };
    const env = {
      CANARY_AUTH_TOKEN: AUTH_TOKEN,
      THREAD_ID_SIGNING_KEY: THREAD_KEY,
      COMPUTER_TICKET_SIGNING_KEY: COMPUTER_KEY,
    };
    const response = await testApp.request(`/computer/results/${instanceId}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ticket: command.ticket,
        program: command.program,
        result: { ok: true, code: "OBSERVED", output: "PAGE r1", revision: "r1", changed: false },
      }),
    }, env);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      authoritative: false,
      status: "queued_for_agent_interpretation",
      requestId: command.requestId,
    });
    expect(dispatched).toEqual([
      expect.objectContaining({
        id: instanceId,
        continuation: expect.objectContaining({
          type: "UNTRUSTED_CLIENT_RESULT",
          requestId: command.requestId,
          authoritative: false,
        }),
      }),
    ]);

    const crossThread = await testApp.request(`/computer/results/${instanceId}`, {
      method: "POST",
      headers: { ...headers, "X-Scalius-Thread-Id": "thread_2" },
      body: JSON.stringify({ ticket: command.ticket, program: command.program, result: { ok: false, code: "BUSY", output: "busy", retryable: true } }),
    }, env);
    expect(crossThread.status).toBe(404);
    expect(dispatched).toHaveLength(1);
  });
});
