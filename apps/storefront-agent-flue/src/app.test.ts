import { describe, expect, it } from "vitest";
import { issueScaliusComputerCommand } from "@scalius/shared/assistant-computer-handoff";
import app, { createStorefrontCanaryApp } from "./app";
import { createThreadInstanceId } from "./thread-identity";

const AUTH_TOKEN = "storefront-app-test-auth-token-at-least-32-bytes";
const THREAD_KEY = "storefront-app-test-thread-key-at-least-32-bytes";
const COMPUTER_KEY = "storefront-app-test-computer-key-at-least-32-bytes";
const IDENTITY = { tenantId: "store_a", principalId: "buyer_1", threadId: "thread_1" };

describe("storefront Flue canary app", () => {
  it("serves a no-store health response without exposing agent routes", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "scalius-storefront-agent-flue-canary",
      runtime: "flue-cloudflare",
      version: "0.1.0",
    });
  });

  it("fails closed before Flue admission when credentials are absent", async () => {
    const [absent, partiallyConfigured] = await Promise.all([
      app.request("/agents/shopping-assistant/guessed-thread"),
      app.request(
        "/agents/shopping-assistant/guessed-thread",
        { headers: { Authorization: `Bearer ${"a".repeat(32)}` } },
        { CANARY_AUTH_TOKEN: "a".repeat(32) } as never,
      ),
    ]);
    expect(absent.status).toBe(404);
    expect(absent.headers.get("cache-control")).toBe("no-store");
    expect(partiallyConfigured.status).toBe(404);
  });

  it("does not report ready when a required secret or API binding is absent", async () => {
    const unavailable = await app.request("/readyz");
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    await expect(unavailable.json()).resolves.toMatchObject({
      locallyConfigured: false,
      endToEnd: false,
      readiness: "configuration_unavailable",
    });

    const ready = await app.request(
      "/readyz",
      undefined,
      {
        CANARY_AUTH_TOKEN: AUTH_TOKEN,
        THREAD_ID_SIGNING_KEY: THREAD_KEY,
        COMPUTER_TICKET_SIGNING_KEY: COMPUTER_KEY,
        API: { fetch: async () => new Response(null, { status: 204 }) },
      },
    );
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({
      locallyConfigured: true,
      endToEnd: false,
      readiness: "local_configuration_present",
    });
  });

  it("probes the real service token and API-signed instance without invoking a model", async () => {
    const readinessApp = createStorefrontCanaryApp({
      recordAuthorizationFailure: () => undefined,
    });
    const instanceId = await createThreadInstanceId(
      "storefront",
      IDENTITY,
      THREAD_KEY,
    );
    const mismatchedInstanceId = await createThreadInstanceId(
      "storefront",
      IDENTITY,
      "mismatched-storefront-thread-key-at-least-32-bytes",
    );
    const headers = {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "X-Scalius-Tenant-Id": IDENTITY.tenantId,
      "X-Scalius-Principal-Id": IDENTITY.principalId,
      "X-Scalius-Thread-Id": IDENTITY.threadId,
    };
    const env = {
      CANARY_AUTH_TOKEN: AUTH_TOKEN,
      THREAD_ID_SIGNING_KEY: THREAD_KEY,
      COMPUTER_TICKET_SIGNING_KEY: COMPUTER_KEY,
      API: { fetch: async () => new Response(null, { status: 204 }) },
    };

    const ready = await readinessApp.request(
      `/readyz/agents/shopping-assistant/${instanceId}`,
      { headers },
      env,
    );
    expect(ready.status).toBe(204);
    expect(ready.headers.get("x-scalius-readiness")).toBe(
      "facade-authenticated",
    );
    expect(ready.headers.get("cache-control")).toBe("no-store");

    const wrongToken = await readinessApp.request(
      `/readyz/agents/shopping-assistant/${instanceId}`,
      {
        headers: {
          ...headers,
          Authorization: `Bearer ${"valid-length-but-wrong-service-token".repeat(2)}`,
        },
      },
      env,
    );
    expect(wrongToken.status).toBe(404);

    const wrongSignature = await readinessApp.request(
      `/readyz/agents/shopping-assistant/${mismatchedInstanceId}`,
      { headers },
      env,
    );
    expect(wrongSignature.status).toBe(404);
  });

  it("queues only an exact signed browser result on the same Storefront thread", async () => {
    const instanceId = await createThreadInstanceId("storefront", IDENTITY, THREAD_KEY);
    const command = await issueScaliusComputerCommand({
      surface: "storefront",
      agentName: "shopping-assistant",
      instanceId,
      program: "goto /products",
      signingKey: COMPUTER_KEY,
    });
    const dispatched: unknown[] = [];
    const testApp = createStorefrontCanaryApp({
      recordAuthorizationFailure: () => undefined,
      beginAgentAdmission: async () => ({
        admissionId: "a".repeat(22),
        admissionClaimToken: "l".repeat(43),
        generation: Date.now(),
      }),
      finishAgentAdmission: async () => true,
      consumeComputerHandoff: async ({ handoff, state }) => ({
        ok: true,
        status: "claimed",
        state: state as "dispatched",
        requestId: handoff.requestId,
        dispatchClaimToken: "d".repeat(43),
      }),
      beginComputerHandoff: async () => true,
      confirmComputerHandoff: async () => true,
      dispatchComputerResult: async (id, continuation, generation) => {
        dispatched.push({ id, continuation, generation });
        return { dispatchId: "dispatch_storefront_1", acceptedAt: new Date().toISOString() };
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
        result: { ok: true, code: "NAVIGATED", output: "Opened /products", changed: true },
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
          surface: "storefront",
          requestId: command.requestId,
        }),
        generation: expect.any(Number),
      }),
    ]);

    const crossThread = await testApp.request(`/computer/results/${instanceId}`, {
      method: "POST",
      headers: { ...headers, "X-Scalius-Principal-Id": "buyer_2" },
      body: JSON.stringify({ ticket: command.ticket, program: command.program, result: { ok: false, code: "BUSY", output: "busy", retryable: true } }),
    }, env);
    expect(crossThread.status).toBe(404);
    expect(dispatched).toHaveLength(1);
  });

  it("lets cancellation and result race through one D1 first winner", async () => {
    const instanceId = await createThreadInstanceId("storefront", IDENTITY, THREAD_KEY);
    const command = await issueScaliusComputerCommand({
      surface: "storefront",
      agentName: "shopping-assistant",
      instanceId,
      program: "observe",
      signingKey: COMPUTER_KEY,
    });
    let winner: "cancelled" | "dispatched" | null = null;
    const dispatched: string[] = [];
    const testApp = createStorefrontCanaryApp({
      recordAuthorizationFailure: () => undefined,
      beginAgentAdmission: async () => ({
        admissionId: "a".repeat(22),
        admissionClaimToken: "l".repeat(43),
        generation: Date.now(),
      }),
      finishAgentAdmission: async () => true,
      consumeComputerHandoff: async ({ handoff, state }) => {
        if (winner) return { ok: false as const, reason: "conflict" as const };
        winner = state;
        return state === "cancelled"
          ? {
              ok: true as const,
              status: "claimed" as const,
              state,
              requestId: handoff.requestId,
            }
          : {
              ok: true as const,
              status: "claimed" as const,
              state,
              requestId: handoff.requestId,
              dispatchClaimToken: "d".repeat(43),
            };
      },
      beginComputerHandoff: async () => true,
      confirmComputerHandoff: async () => true,
      dispatchComputerResult: async () => {
        dispatched.push("dispatch");
        return { dispatchId: "dispatch_race", acceptedAt: new Date().toISOString() };
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
    const [result, cancel] = await Promise.all([
      testApp.request(`/computer/results/${instanceId}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ticket: command.ticket,
          program: command.program,
          result: { ok: true, code: "OBSERVED", output: "Observed", changed: false },
        }),
      }, env),
      testApp.request(`/computer/cancel/${instanceId}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ticket: command.ticket, program: command.program }),
      }, env),
    ]);
    expect([result.status, cancel.status].sort()).toEqual([202, 409]);
    expect(dispatched.length).toBe(winner === "dispatched" ? 1 : 0);
  });

  it("marks an ambiguous dispatch uncertain and never retries it", async () => {
    const instanceId = await createThreadInstanceId("storefront", IDENTITY, THREAD_KEY);
    const command = await issueScaliusComputerCommand({
      surface: "storefront",
      agentName: "shopping-assistant",
      instanceId,
      program: "observe",
      signingKey: COMPUTER_KEY,
    });
    const uncertain: unknown[] = [];
    const dispatchComputerResult = async () => {
      throw new Error("ambiguous dispatch response");
    };
    const testApp = createStorefrontCanaryApp({
      recordAuthorizationFailure: () => undefined,
      beginAgentAdmission: async () => ({
        admissionId: "a".repeat(22),
        admissionClaimToken: "l".repeat(43),
        generation: Date.now(),
      }),
      finishAgentAdmission: async () => true,
      consumeComputerHandoff: async ({ handoff }) => ({
        ok: true,
        status: "claimed",
        state: "dispatched",
        requestId: handoff.requestId,
        dispatchClaimToken: "d".repeat(43),
      }),
      beginComputerHandoff: async () => true,
      dispatchComputerResult,
      markComputerHandoffUncertain: async (claim) => {
        uncertain.push(claim);
        return true;
      },
    });
    const response = await testApp.request(`/computer/results/${instanceId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        "X-Scalius-Tenant-Id": IDENTITY.tenantId,
        "X-Scalius-Principal-Id": IDENTITY.principalId,
        "X-Scalius-Thread-Id": IDENTITY.threadId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ticket: command.ticket,
        program: command.program,
        result: { ok: true, code: "OBSERVED", output: "Observed", changed: false },
      }),
    }, {
      CANARY_AUTH_TOKEN: AUTH_TOKEN,
      THREAD_ID_SIGNING_KEY: THREAD_KEY,
      COMPUTER_TICKET_SIGNING_KEY: COMPUTER_KEY,
    });
    expect(response.status).toBe(503);
    expect(uncertain).toHaveLength(1);
  });
});
