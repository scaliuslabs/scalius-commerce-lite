// A loopback Streamable-HTTP endpoint in front of the in-process MCP server,
// so an external MCP client (Claude Code / the Agent SDK) talks to the same
// seeded store the deterministic layer scores. JSON responses only (no SSE),
// and one server per request, as the Worker handler builds it.

import { createServer, type Server } from "node:http";
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { createAgentMcpServer } from "../mcp/server";
import type { ToolCallRecord } from "./session";

export interface McpHttpBridge {
  url: string;
  /** Every tools/call the external client made, in order, with its bytes. */
  calls: Array<Pick<ToolCallRecord, "tool" | "args" | "argBytes" | "resultBytes" | "isError">>;
  close(): Promise<void>;
}

const encoder = new TextEncoder();
type Message = Record<string, unknown>;

export async function startMcpHttpBridge(options: { env: Env; ctx: ExecutionContext; port?: number }): Promise<McpHttpBridge> {
  const calls: McpHttpBridge["calls"] = [];

  async function handle(message: Message): Promise<Message | null> {
    const server = createAgentMcpServer({ surface: "dashboard", env: options.env, ctx: options.ctx });
    const [client, transport] = InMemoryTransport.createLinkedPair();
    const pending = new Map<unknown, (reply: Message) => void>();
    client.onmessage = (reply) => pending.get((reply as { id?: unknown }).id)?.(reply as Message);
    const rpc = (request: Message) => new Promise<Message>((resolve) => {
      pending.set(request.id, resolve);
      void client.send(request as JSONRPCMessage);
    });
    await client.start();
    await server.connect(transport);
    try {
      if (message.method !== "initialize") {
        // Each HTTP request is stateless: the handshake is replayed in-process.
        await rpc({ jsonrpc: "2.0", id: "bridge-init", method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "bridge", version: "1" } } });
        await client.send({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
      }
      if (message.id === undefined) {
        await client.send(message as JSONRPCMessage);
        return null;
      }
      const reply = await rpc(message);
      if (message.method === "tools/call") {
        const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        const result = (reply.result ?? {}) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
        calls.push({
          tool: String(params.name),
          args: params.arguments ?? {},
          argBytes: encoder.encode(JSON.stringify(params.arguments ?? {})).byteLength,
          resultBytes: (result.content ?? []).reduce((sum, item) => sum + encoder.encode(item.text ?? JSON.stringify(item)).byteLength, 0),
          isError: result.isError === true,
        });
      }
      return reply;
    } finally {
      await client.close();
      await server.close();
    }
  }

  const server: Server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Message | Message[];
          const messages = Array.isArray(body) ? body : [body];
          const replies = (await Promise.all(messages.map(handle))).filter((reply): reply is Message => reply !== null);
          if (replies.length === 0) {
            response.writeHead(202).end();
            return;
          }
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
        } catch (error) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: String(error) } }));
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
