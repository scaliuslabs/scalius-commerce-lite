// One recorded MCP session for the merchant-task acceptance harness: real
// JSON-RPC over an in-memory transport into the real agent MCP server, so
// every byte counted is a byte a model would read.

import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { AGENT_OPERATIONS_BY_ID } from "../../generated/agent-operations.gen";
import { isConfirmGated } from "../mcp/confirm";
import { createAgentMcpServer } from "../mcp/server";
import type { AgentResource } from "../types";

const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).byteLength;

/** Rough token estimate from bytes (JSON averages close to 4 bytes per token). */
export const BYTES_PER_TOKEN = 4;

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  argBytes: number;
  resultBytes: number;
  isError: boolean;
  /** Operation ids the call ran or previewed. */
  operationIds: string[];
  dryRun: boolean;
  confirmToken: boolean;
  /** Write that reached its route (not a dry run, not refused before dispatch). */
  wrote: boolean;
  gated: boolean;
  structured: Record<string, unknown>;
}

export interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

function operationIdsOf(args: Record<string, unknown>): string[] {
  if (typeof args.operationId === "string") return [args.operationId];
  if (Array.isArray(args.steps)) {
    return args.steps.map((step) => (step as { operationId?: unknown }).operationId).filter((id): id is string => typeof id === "string");
  }
  return [];
}

export class McpEvalSession {
  readonly records: ToolCallRecord[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>();
  private client!: InMemoryTransport;
  private closeServer!: () => Promise<void>;
  /** Bytes of the initialize instructions plus tools/list: what every session loads before the first call. */
  overheadBytes = 0;

  private constructor() {}

  static async open(options: { surface: AgentResource; env: Env; ctx: ExecutionContext }): Promise<McpEvalSession> {
    const session = new McpEvalSession();
    const server = createAgentMcpServer({ surface: options.surface, env: options.env, ctx: options.ctx });
    const [client, transport] = InMemoryTransport.createLinkedPair();
    client.onmessage = (message) => {
      const id = (message as { id?: unknown }).id;
      if (typeof id === "number") session.pending.get(id)?.(message as Record<string, unknown>);
    };
    await client.start();
    await server.connect(transport);
    session.client = client;
    session.closeServer = async () => {
      await client.close();
      await server.close();
    };
    const init = await session.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "scalius-agent-eval", version: "1" },
    });
    await client.send({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
    const list = await session.request("tools/list", {});
    session.overheadBytes = byteLength(String((init.result as { instructions?: string })?.instructions ?? "")) +
      byteLength(JSON.stringify((list.result as { tools?: unknown })?.tools ?? []));
    return session;
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 30_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(message);
      });
      void this.client.send({ jsonrpc: "2.0", id, method, params } as JSONRPCMessage).catch(reject);
    });
  }

  /** One tools/call, recorded with the bytes a model reads (content text) and writes (arguments). */
  async call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const response = await this.request("tools/call", { name: tool, arguments: args });
    if (response.error) throw new Error(`tools/call ${tool} failed: ${JSON.stringify(response.error)}`);
    const result = response.result as ToolResult;
    const resultBytes = (result.content ?? []).reduce((sum, item) =>
      sum + (item.type === "text" ? byteLength(item.text ?? "") : byteLength(JSON.stringify(item))), 0);
    const operationIds = tool === "scalius_read" || tool === "scalius_write" ? operationIdsOf(args) : [];
    const dryRun = tool === "scalius_write" && args.dryRun === true;
    const gated = operationIds.some((id) => {
      const operation = AGENT_OPERATIONS_BY_ID[id];
      return operation ? isConfirmGated(operation) : false;
    });
    const structured = result.structuredContent ?? {};
    const refusedBeforeDispatch = (structured.error as { code?: string } | undefined)?.code?.startsWith("confirm") ?? false;
    this.records.push({
      tool,
      args,
      argBytes: byteLength(JSON.stringify(args)),
      resultBytes,
      isError: result.isError === true,
      operationIds,
      dryRun,
      confirmToken: typeof args.confirmToken === "string",
      wrote: tool === "scalius_write" && !dryRun && !refusedBeforeDispatch,
      gated,
      structured,
    });
    return result;
  }

  async close(): Promise<void> {
    await this.closeServer();
  }
}

export interface SessionMetrics {
  toolCalls: number;
  resultBytes: number;
  argBytes: number;
  overheadBytes: number;
  estimatedTokens: number;
  errors: number;
}

export function sessionMetrics(records: readonly ToolCallRecord[], overheadBytes: number): SessionMetrics {
  const resultBytes = records.reduce((sum, record) => sum + record.resultBytes, 0);
  const argBytes = records.reduce((sum, record) => sum + record.argBytes, 0);
  return {
    toolCalls: records.length,
    resultBytes,
    argBytes,
    overheadBytes,
    estimatedTokens: Math.ceil((resultBytes + argBytes + overheadBytes) / BYTES_PER_TOKEN),
    errors: records.filter((record) => record.isError).length,
  };
}

/**
 * Every gated (destructive or financial) write that ran must have been dry-run
 * first in the same task and must carry the confirm token. Returns violations.
 */
export function confirmViolations(records: readonly ToolCallRecord[]): string[] {
  const violations: string[] = [];
  records.forEach((record, index) => {
    if (!record.gated || record.dryRun || record.tool !== "scalius_write") return;
    if (!record.wrote) return;
    const previewed = records.slice(0, index).some((earlier) =>
      earlier.dryRun && earlier.operationIds.join(",") === record.operationIds.join(","));
    if (!previewed) violations.push(`${record.operationIds.join(",")} ran without a dry run`);
    if (!record.confirmToken) violations.push(`${record.operationIds.join(",")} ran without a confirm token`);
  });
  return violations;
}
