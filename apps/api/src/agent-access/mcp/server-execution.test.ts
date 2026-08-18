import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_OPERATIONS } from "../../generated/agent-operations.gen";
import type { AgentOperationResult } from "../dispatch";
import type { AgentPrincipal } from "../types";

const mocks = vi.hoisted(() => ({
  authorizeOperation: vi.fn(),
  dispatchAgentOperation: vi.fn(),
  resolvePrincipal: vi.fn(),
}));

vi.mock("agents/mcp/server", () => ({
  getMcpAuthContext: () => ({
    props: {
      grantId: `agr_${"a".repeat(20)}`,
      credentialId: `agc_${"b".repeat(20)}`,
      ownerUserId: "mcp-test-admin",
      resource: "dashboard",
      permissions: ["*"],
      riskCeiling: "security",
      audience: ["https://api.example.test/api/v1/mcp/dashboard"],
    },
  }),
}));

vi.mock("../backend", () => ({
  loadAgentAccessBackend: async () => ({
    authorizeOperation: mocks.authorizeOperation,
    resolvePrincipal: mocks.resolvePrincipal,
  }),
}));

vi.mock("../dispatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../dispatch")>();
  return {
    ...actual,
    dispatchAgentOperation: mocks.dispatchAgentOperation,
  };
});

import { createAgentMcpServer } from "./server";

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: unknown;
}

const principal: AgentPrincipal = {
  kind: "agent",
  grantId: `agr_${"a".repeat(20)}`,
  credentialId: `agc_${"b".repeat(20)}`,
  ownerUserId: "mcp-test-admin",
  isSuperAdmin: true,
  resource: "dashboard",
  grantKind: "oauth",
  preset: "full",
  permissions: new Set(["*"]),
  riskCeiling: "security",
  authorityRevision: 1,
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
};

function operationResult(
  operationId: string,
  requestId: string,
  ok: boolean,
  data: unknown,
): AgentOperationResult {
  return {
    operationId,
    status: ok ? 200 : 409,
    ok,
    requestId,
    contentType: "application/json",
    data,
  };
}

async function connectInMemory() {
  const server = createAgentMcpServer({
    surface: "dashboard",
    env: {
      PUBLIC_API_BASE_URL: "https://api.example.test",
      AGENT_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as unknown as Env,
    ctx: {} as ExecutionContext,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  clientTransport.onmessage = (message) => {
    const response = message as JsonRpcResponse;
    if (typeof response.id === "number") pending.get(response.id)?.(response);
  };
  await clientTransport.start();
  await server.connect(serverTransport);
  let requestId = 0;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    requestId += 1;
    const id = requestId;
    const response = new Promise<JsonRpcResponse>((resolve) => pending.set(id, resolve));
    await clientTransport.send({ jsonrpc: "2.0", id, method, params } as JSONRPCMessage);
    const resolved = await response;
    pending.delete(id);
    return resolved;
  };
  await request("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "mcp-execution-test", version: "1.0.0" },
  });
  await clientTransport.send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  } as JSONRPCMessage);
  return {
    request,
    close: async () => {
      await clientTransport.close();
      await server.close();
    },
  };
}

function structuredContent(response: JsonRpcResponse) {
  expect(response.error).toBeUndefined();
  return (response.result as { structuredContent: Record<string, unknown> }).structuredContent;
}

const parallelRead = AGENT_OPERATIONS.find((operation) =>
  operation.surface === "dashboard" &&
  operation.exposure === "execute" &&
  operation.risk === "read" &&
  operation.batch === "parallel"
);
const sequentialWrite = AGENT_OPERATIONS.find((operation) =>
  operation.surface === "dashboard" &&
  operation.exposure === "execute" &&
  operation.risk !== "read" &&
  operation.batch === "sequential"
);

describe("MCP split operation execution", () => {
  beforeEach(() => {
    mocks.authorizeOperation.mockReset().mockResolvedValue(true);
    mocks.resolvePrincipal.mockReset().mockResolvedValue(principal);
    mocks.dispatchAgentOperation.mockReset();
    expect(parallelRead).toBeDefined();
    expect(sequentialWrite).toBeDefined();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects cross-risk single operations before dispatch", async () => {
    const connection = await connectInMemory();
    try {
      const readResponse = await connection.request("tools/call", {
        name: "operations.read",
        arguments: { operationId: sequentialWrite!.operationId },
      });
      expect(structuredContent(readResponse)).toMatchObject({
        ok: false,
        error: { code: "operation_risk_mismatch" },
      });

      const writeResponse = await connection.request("tools/call", {
        name: "operations.write",
        arguments: { operationId: parallelRead!.operationId },
      });
      expect(structuredContent(writeResponse)).toMatchObject({
        ok: false,
        error: { code: "operation_risk_mismatch" },
      });
      expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("returns operation not found before an unauthorized cross-risk operation can reveal risk", async () => {
    mocks.authorizeOperation.mockResolvedValue(false);
    const connection = await connectInMemory();
    try {
      const response = await connection.request("tools/call", {
        name: "operations.read",
        arguments: { operationId: sequentialWrite!.operationId },
      });
      expect(structuredContent(response)).toMatchObject({
        ok: false,
        error: { code: "operation_not_found" },
      });
      expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("returns parallel read results in input order within the two-lane bound", async () => {
    const releases = new Map<string, () => void>();
    const seenInputs = new Map<string, unknown>();
    let active = 0;
    let maxActive = 0;
    mocks.dispatchAgentOperation.mockImplementation(async ({ operation, input }) => {
      const label = (input.body as { label: string }).label;
      seenInputs.set(label, input);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.set(label, resolve));
      active -= 1;
      return operationResult(operation.operationId, `request-${label}`, true, { label });
    });

    const connection = await connectInMemory();
    try {
      const responsePromise = connection.request("tools/call", {
        name: "operations.read_batch",
        arguments: {
          steps: [
            {
              id: "first",
              operationId: parallelRead!.operationId,
              input: { body: { label: "first" } },
            },
            {
              id: "second",
              operationId: parallelRead!.operationId,
              input: { body: { label: "second" } },
            },
            {
              id: "third",
              operationId: parallelRead!.operationId,
              input: {
                query: { dependency: { $step: "first", pointer: "/data/label" } },
                body: { label: "third" },
              },
            },
          ],
        },
      });
      await vi.waitFor(() => expect(releases.size).toBe(2));
      releases.get("second")!();
      await Promise.resolve();
      expect(mocks.dispatchAgentOperation).toHaveBeenCalledTimes(2);
      releases.get("first")!();
      await vi.waitFor(() => expect(releases.has("third")).toBe(true));
      releases.get("third")!();

      const output = structuredContent(await responsePromise) as {
        results: Array<{ id: string; result: AgentOperationResult }>;
      };
      expect(output.results.map((item) => item.id)).toEqual(["first", "second", "third"]);
      expect(output.results.map((item) => item.result.data)).toEqual([
        { label: "first" },
        { label: "second" },
        { label: "third" },
      ]);
      expect(seenInputs.get("third")).toMatchObject({
        query: { dependency: "first" },
      });
      expect(maxActive).toBe(2);
    } finally {
      for (const release of releases.values()) release();
      await connection.close();
    }
  });

  it("runs write batches sequentially, resolves earlier steps, and stops on failure", async () => {
    const seenBodies: unknown[] = [];
    mocks.dispatchAgentOperation.mockImplementation(async ({ operation, input }) => {
      seenBodies.push(input.body);
      const call = seenBodies.length;
      return operationResult(
        operation.operationId,
        `request-${call}`,
        call === 1,
        call === 1 ? { value: "resolved-value" } : { reason: "conflict" },
      );
    });

    const connection = await connectInMemory();
    try {
      const response = await connection.request("tools/call", {
        name: "operations.write_batch",
        arguments: {
          steps: [
            {
              id: "create",
              operationId: sequentialWrite!.operationId,
              input: { body: { value: "initial" } },
            },
            {
              id: "update",
              operationId: sequentialWrite!.operationId,
              input: { body: { $step: "create", pointer: "/data/value" } },
            },
            {
              id: "never",
              operationId: sequentialWrite!.operationId,
              input: { body: { value: "must-not-run" } },
            },
          ],
        },
      });
      const output = structuredContent(response) as {
        ok: boolean;
        results: Array<{ id: string; ok: boolean }>;
      };
      expect(output.ok).toBe(false);
      expect(output.results).toEqual([
        expect.objectContaining({ id: "create", ok: true }),
        expect.objectContaining({ id: "update", ok: false }),
      ]);
      expect(seenBodies).toEqual([{ value: "initial" }, "resolved-value"]);
      expect(mocks.dispatchAgentOperation).toHaveBeenCalledTimes(2);
    } finally {
      await connection.close();
    }
  });

  it("preflights every write-batch step before dispatching the first mutation", async () => {
    mocks.authorizeOperation
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const connection = await connectInMemory();
    try {
      const response = await connection.request("tools/call", {
        name: "operations.write_batch",
        arguments: {
          steps: [
            { id: "allowed", operationId: sequentialWrite!.operationId },
            { id: "denied", operationId: sequentialWrite!.operationId },
          ],
        },
      });
      expect(structuredContent(response)).toMatchObject({
        ok: false,
        error: { code: "operation_not_found" },
      });
      expect(mocks.authorizeOperation).toHaveBeenCalledTimes(2);
      expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });
});
