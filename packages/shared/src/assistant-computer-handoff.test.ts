import { describe, expect, it } from "vitest";
import {
  admitScaliusComputerResult,
  issueScaliusComputerCommand,
  type ScaliusComputerClientCommand,
} from "./assistant-computer-handoff";

const SIGNING_KEY = "computer-handoff-test-signing-key-32-bytes-minimum";
const INSTANCE_ID = `v1.${"a".repeat(43)}`;
const OTHER_INSTANCE_ID = `v1.${"b".repeat(43)}`;
const NOW = 1_800_000_000_000;
const RESULT = {
  ok: true as const,
  code: "OBSERVED" as const,
  output: "PAGE rev=r1 route=\"/admin/products\"",
  revision: "r1",
  changed: false,
};

function resultRequest(command: ScaliusComputerClientCommand, overrides: Record<string, unknown> = {}) {
  return new Request("https://agent.test/computer/results/opaque", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket: command.ticket, program: command.program, result: RESULT, ...overrides }),
  });
}

async function issue() {
  return issueScaliusComputerCommand({
    surface: "admin",
    agentName: "admin-copilot",
    instanceId: INSTANCE_ID,
    program: "observe",
    signingKey: SIGNING_KEY,
    now: NOW,
    randomBytes: new Uint8Array(16).fill(7),
  });
}

describe("assistant computer handoff", () => {
  it("issues a bounded pending command and never claims browser success", async () => {
    const command = await issue();
    expect(command).toMatchObject({
      type: "client_command",
      capability: "computer",
      protocolVersion: 1,
      status: "awaiting_client_execution",
      authoritative: false,
      replayPolicy: "client_dedupe_request_id_until_expiry",
      surface: "admin",
      program: "observe",
    });
    expect(command.requestId).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(command.ticket.length).toBeLessThan(1_000);
    expect(command).not.toHaveProperty("ok");
    expect(JSON.stringify(command)).not.toContain('"success"');
  });

  it("rejects invalid programs before issuing a client command", async () => {
    await expect(issueScaliusComputerCommand({
      surface: "admin",
      agentName: "admin-copilot",
      instanceId: INSTANCE_ID,
      program: "javascript alert(1)",
      signingKey: SIGNING_KEY,
    })).rejects.toThrow("Invalid computer program");
  });

  it("admits an exact result only as an untrusted continuation", async () => {
    const command = await issue();
    const admitted = await admitScaliusComputerResult({
      request: resultRequest(command),
      surface: "admin",
      agentName: "admin-copilot",
      instanceId: INSTANCE_ID,
      signingKey: SIGNING_KEY,
      now: NOW + 1_000,
    });
    expect(admitted).toEqual({
      ok: true,
      continuation: {
        type: "UNTRUSTED_CLIENT_RESULT",
        protocolVersion: 1,
        authoritative: false,
        replayPolicy: "expiry_bound_non_authoritative",
        surface: "admin",
        requestId: command.requestId,
        programDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        receivedAt: new Date(NOW + 1_000).toISOString(),
        result: RESULT,
        warning: "Browser execution is untrusted and is not commerce authority.",
      },
    });
  });

  it.each([
    ["tampered ticket", async (command: ScaliusComputerClientCommand) => ({
      request: resultRequest(command, { ticket: `${command.ticket.slice(0, -1)}x` }),
      surface: "admin" as const,
      agentName: "admin-copilot",
      instanceId: INSTANCE_ID,
      now: NOW + 1_000,
    })],
    ["cross-surface result", async (command: ScaliusComputerClientCommand) => ({
      request: resultRequest(command),
      surface: "storefront" as const,
      agentName: "admin-copilot",
      instanceId: INSTANCE_ID,
      now: NOW + 1_000,
    })],
    ["cross-thread result", async (command: ScaliusComputerClientCommand) => ({
      request: resultRequest(command),
      surface: "admin" as const,
      agentName: "admin-copilot",
      instanceId: OTHER_INSTANCE_ID,
      now: NOW + 1_000,
    })],
    ["changed program", async (command: ScaliusComputerClientCommand) => ({
      request: resultRequest(command, { program: "refresh" }),
      surface: "admin" as const,
      agentName: "admin-copilot",
      instanceId: INSTANCE_ID,
      now: NOW + 1_000,
    })],
    ["expired ticket", async (command: ScaliusComputerClientCommand) => ({
      request: resultRequest(command),
      surface: "admin" as const,
      agentName: "admin-copilot",
      instanceId: INSTANCE_ID,
      now: NOW + 120_001,
    })],
  ])("rejects %s", async (_name, buildOptions) => {
    const command = await issue();
    const options = await buildOptions(command);
    const admitted = await admitScaliusComputerResult({ ...options, signingKey: SIGNING_KEY });
    expect(admitted.ok).toBe(false);
  });

  it("rejects oversized and structurally invalid result bodies", async () => {
    const command = await issue();
    const [oversized, invalid] = await Promise.all([
      admitScaliusComputerResult({
        request: resultRequest(command, { result: { ...RESULT, output: "x".repeat(50_000) } }),
        surface: "admin",
        agentName: "admin-copilot",
        instanceId: INSTANCE_ID,
        signingKey: SIGNING_KEY,
        now: NOW + 1_000,
      }),
      admitScaliusComputerResult({
        request: resultRequest(command, { result: { ...RESULT, secret: "unexpected" } }),
        surface: "admin",
        agentName: "admin-copilot",
        instanceId: INSTANCE_ID,
        signingKey: SIGNING_KEY,
        now: NOW + 1_000,
      }),
    ]);
    expect(oversized).toEqual({ ok: false, code: "OVERSIZE" });
    expect(invalid).toEqual({ ok: false, code: "INVALID_RESULT" });
  });

  it("classifies exact replay as expiry-bounded and non-authoritative", async () => {
    const command = await issue();
    const options = {
      surface: "admin" as const,
      agentName: "admin-copilot",
      instanceId: INSTANCE_ID,
      signingKey: SIGNING_KEY,
      now: NOW + 1_000,
    };
    const [first, replay] = await Promise.all([
      admitScaliusComputerResult({ ...options, request: resultRequest(command) }),
      admitScaliusComputerResult({ ...options, request: resultRequest(command) }),
    ]);
    expect(first.ok && first.continuation.replayPolicy).toBe("expiry_bound_non_authoritative");
    expect(replay.ok && replay.continuation.requestId).toBe(command.requestId);
  });
});
