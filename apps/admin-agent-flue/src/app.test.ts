import { describe, expect, it, vi } from "vitest";
import {
  issueScaliusComputerCommand,
  type ScaliusComputerClientCommand,
} from "@scalius/shared/assistant-computer-handoff";
import app, { createAdminCanaryApp } from "./app";
import { createThreadInstanceId } from "./thread-identity";

const AUTH_TOKEN = "admin-app-test-auth-token-at-least-32-bytes";
const THREAD_KEY = "admin-app-test-thread-key-at-least-32-bytes";
const COMPUTER_KEY = "admin-app-test-computer-key-at-least-32-bytes";
const IDENTITY = { tenantId: "merchant_a", principalId: "admin_1", threadId: "thread_1" };
const CLAIM_TOKEN = "d".repeat(43);

function authHeaders() {
  return {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    "X-Scalius-Tenant-Id": IDENTITY.tenantId,
    "X-Scalius-Principal-Id": IDENTITY.principalId,
    "X-Scalius-Thread-Id": IDENTITY.threadId,
    "Content-Type": "application/json",
  };
}

function baseEnv(overrides: Record<string, unknown> = {}) {
  return {
    CANARY_AUTH_TOKEN: AUTH_TOKEN,
    THREAD_ID_SIGNING_KEY: THREAD_KEY,
    COMPUTER_TICKET_SIGNING_KEY: COMPUTER_KEY,
    ...overrides,
  };
}

async function issue() {
  const instanceId = await createThreadInstanceId("admin", IDENTITY, THREAD_KEY);
  const command = await issueScaliusComputerCommand({
    surface: "admin",
    agentName: "admin-copilot",
    instanceId,
    program: "observe",
    signingKey: COMPUTER_KEY,
  });
  return { instanceId, command };
}

function resultBody(command: ScaliusComputerClientCommand) {
  return JSON.stringify({
    ticket: command.ticket,
    program: command.program,
    result: {
      ok: true,
      code: "OBSERVED",
      output: "PAGE r1",
      revision: "r1",
      changed: false,
    },
  });
}

function cancelBody(command: ScaliusComputerClientCommand) {
  return JSON.stringify({ ticket: command.ticket, program: command.program });
}

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

  it("claims, dispatches, and confirms an exact signed result through bounded API calls", async () => {
    const { instanceId, command } = await issue();
    const dispatched: unknown[] = [];
    const apiFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).has("cookie")).toBe(false);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      const body = await new Response(init?.body).json() as Record<string, unknown>;
      if (String(input).endsWith("/consume")) {
        expect(body).toMatchObject({
          instanceId,
          requestId: command.requestId,
          state: "dispatched",
          ticketExpiresAt: Date.parse(command.expiresAt),
        });
        return Response.json({
          success: true,
          data: {
            status: "claimed",
            state: "dispatched",
            requestId: command.requestId,
            dispatchClaimToken: CLAIM_TOKEN,
          },
        });
      }
      expect(String(input)).toMatch(/\/confirm$/u);
      expect(body).toMatchObject({
        instanceId,
        requestId: command.requestId,
        dispatchClaimToken: CLAIM_TOKEN,
      });
      return Response.json({
        success: true,
        data: {
          status: "confirmed",
          state: "dispatched",
          requestId: command.requestId,
        },
      });
    });
    const testApp = createAdminCanaryApp({
      dispatchComputerResult: async (id, continuation) => {
        dispatched.push({ id, continuation });
        return { dispatchId: "dispatch_admin_1", acceptedAt: new Date().toISOString() };
      },
    });
    const response = await testApp.request(`/computer/results/${instanceId}`, {
      method: "POST",
      headers: authHeaders(),
      body: resultBody(command),
    }, baseEnv({ API: { fetch: apiFetch } }) as never);

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      authoritative: false,
      status: "queued_for_agent_interpretation",
      requestId: command.requestId,
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
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
      headers: { ...authHeaders(), "X-Scalius-Thread-Id": "thread_2" },
      body: resultBody(command),
    }, baseEnv({ API: { fetch: apiFetch } }) as never);
    expect(crossThread.status).toBe(404);
    expect(dispatched).toHaveLength(1);
  });

  it("cancels idempotently without invoking Flue dispatch or confirmation", async () => {
    const { instanceId, command } = await issue();
    const dispatchComputerResult = vi.fn();
    let calls = 0;
    const consumeComputerHandoff = vi.fn(async (input) => ({
      ok: true as const,
      status: calls++ === 0 ? "claimed" as const : "replayed" as const,
      state: "cancelled" as const,
      requestId: input.handoff.requestId,
    }));
    const confirmComputerHandoff = vi.fn();
    const testApp = createAdminCanaryApp({
      dispatchComputerResult,
      consumeComputerHandoff,
      confirmComputerHandoff,
    });
    const request = () => testApp.request(`/computer/cancel/${instanceId}`, {
      method: "POST",
      headers: authHeaders(),
      body: cancelBody(command),
    }, baseEnv() as never);
    const [first, replay] = [await request(), await request()];

    for (const response of [first, replay]) {
      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        accepted: true,
        status: "cancelled",
        requestId: command.requestId,
      });
    }
    expect(consumeComputerHandoff).toHaveBeenCalledTimes(2);
    expect(dispatchComputerResult).not.toHaveBeenCalled();
    expect(confirmComputerHandoff).not.toHaveBeenCalled();
  });

  it("lets one cancel/result winner block the other and dispatches a confirmed replay at most once", async () => {
    const { instanceId, command } = await issue();
    let terminal: "cancelled" | "dispatched" | null = null;
    let confirmed = false;
    const dispatchComputerResult = vi.fn(async () => ({
      dispatchId: "dispatch_1",
      acceptedAt: new Date().toISOString(),
    }));
    const consumeComputerHandoff = vi.fn(async (input) => {
      if (terminal && terminal !== input.state) {
        return { ok: false as const, reason: "conflict" as const };
      }
      if (!terminal) {
        terminal = input.state;
        return input.state === "dispatched"
          ? {
            ok: true as const,
            status: "claimed" as const,
            state: "dispatched" as const,
            requestId: input.handoff.requestId,
            dispatchClaimToken: CLAIM_TOKEN,
          }
          : {
            ok: true as const,
            status: "claimed" as const,
            state: "cancelled" as const,
            requestId: input.handoff.requestId,
          };
      }
      if (terminal === "dispatched" && !confirmed) {
        return { ok: false as const, reason: "uncertain" as const };
      }
      return {
        ok: true as const,
        status: "replayed" as const,
        state: terminal,
        requestId: input.handoff.requestId,
      };
    });
    const confirmComputerHandoff = vi.fn(async () => {
      confirmed = true;
      return true;
    });
    const testApp = createAdminCanaryApp({
      dispatchComputerResult,
      consumeComputerHandoff,
      confirmComputerHandoff,
    });
    const result = () => testApp.request(`/computer/results/${instanceId}`, {
      method: "POST",
      headers: authHeaders(),
      body: resultBody(command),
    }, baseEnv() as never);
    const cancel = () => testApp.request(`/computer/cancel/${instanceId}`, {
      method: "POST",
      headers: authHeaders(),
      body: cancelBody(command),
    }, baseEnv() as never);

    expect((await result()).status).toBe(202);
    expect((await result()).status).toBe(202);
    expect((await cancel()).status).toBe(409);
    expect(dispatchComputerResult).toHaveBeenCalledOnce();
    expect(confirmComputerHandoff).toHaveBeenCalledOnce();
  });

  it("never redispatches after claim+dispatch failure or after dispatch+confirm failure", async () => {
    const { instanceId, command } = await issue();
    let claimed = false;
    const consumeComputerHandoff = vi.fn(async (input) => {
      if (claimed) return { ok: false as const, reason: "uncertain" as const };
      claimed = true;
      return {
        ok: true as const,
        status: "claimed" as const,
        state: "dispatched" as const,
        requestId: input.handoff.requestId,
        dispatchClaimToken: CLAIM_TOKEN,
      };
    });
    const dispatchFailure = vi.fn(async () => {
      throw new Error("dispatch failed after durable claim");
    });
    const failedApp = createAdminCanaryApp({
      consumeComputerHandoff,
      dispatchComputerResult: dispatchFailure,
      confirmComputerHandoff: vi.fn(async () => true),
    });
    const send = (target = failedApp) => target.request(`/computer/results/${instanceId}`, {
      method: "POST",
      headers: authHeaders(),
      body: resultBody(command),
    }, baseEnv() as never);
    expect((await send()).status).toBe(503);
    expect((await send()).status).toBe(503);
    expect(dispatchFailure).toHaveBeenCalledOnce();

    claimed = false;
    const dispatchSuccess = vi.fn(async () => ({
      dispatchId: "dispatch_2",
      acceptedAt: new Date().toISOString(),
    }));
    const confirmFailure = vi.fn(async () => false);
    const unconfirmedApp = createAdminCanaryApp({
      consumeComputerHandoff,
      dispatchComputerResult: dispatchSuccess,
      confirmComputerHandoff: confirmFailure,
    });
    expect((await send(unconfirmedApp)).status).toBe(503);
    expect((await send(unconfirmedApp)).status).toBe(503);
    expect(dispatchSuccess).toHaveBeenCalledOnce();
    expect(confirmFailure).toHaveBeenCalledOnce();
  });

  it("fails signed handoffs closed when durable API authority is unavailable", async () => {
    const { instanceId, command } = await issue();
    const dispatchComputerResult = vi.fn();
    const testApp = createAdminCanaryApp({ dispatchComputerResult });
    const response = await testApp.request(`/computer/results/${instanceId}`, {
      method: "POST",
      headers: authHeaders(),
      body: resultBody(command),
    }, baseEnv() as never);
    expect(response.status).toBe(503);
    expect(dispatchComputerResult).not.toHaveBeenCalled();
  });
});
