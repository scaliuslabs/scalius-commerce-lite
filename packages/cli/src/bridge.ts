import { createInterface } from "node:readline";
import { ConfigStore } from "./config.js";
import { fetchWithNetworkErrors } from "./http.js";
import { mcpNameFor, mcpUrl, parseMcpBody, type Audience } from "./mcp-client.js";
import type { ResolvedProfile, Runtime } from "./types.js";

// `scalius mcp`: a local stdio MCP server that forwards every message to the
// store's remote MCP endpoint with the CLI's paired credential. The agent
// harness launches it, so connecting an agent and using the CLI share one
// login, and the credential never enters the harness configuration. Stream
// responses are relayed event by event, so long-lived subscription streams
// (`subscriptions/listen`) deliver their notifications as they happen.

const MAX_IN_FLIGHT = 8;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const STREAMING_METHODS = new Set(["subscriptions/listen"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcError(id: unknown, code: number, message: string, data?: Record<string, unknown>) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function envelopeVersion(message: Record<string, unknown>): string | undefined {
  const meta = isRecord(message.params) && isRecord(message.params._meta) ? message.params._meta : undefined;
  const version = meta?.["io.modelcontextprotocol/protocolVersion"];
  return typeof version === "string" ? version : undefined;
}

/** Relays each `data:` event of a text/event-stream body as soon as it is complete. */
async function relayEvents(body: ReadableStream<Uint8Array>, onMessage: (message: unknown) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (event: string) => {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) return;
    try {
      onMessage(JSON.parse(data));
    } catch {
      // A malformed event is dropped; the request's own reply or error still arrives.
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > MAX_EVENT_BYTES) throw new Error("event too large");
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)![0];
        flush(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + separator.length);
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
    flush(buffer + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

export interface BridgeOptions {
  audience: Audience;
  profile?: string;
}

export async function serveMcpBridge(runtime: Runtime, options: BridgeOptions): Promise<void> {
  const store = new ConfigStore(runtime);
  let profile: ResolvedProfile | undefined;
  let setupError: string | undefined;
  try {
    profile = await store.resolveProfileForResource(options.audience, options.profile, true);
  } catch (error) {
    setupError = error instanceof Error ? error.message : "No Scalius credential is configured.";
  }
  const loginHint = `Run 'npx scalius init${profile ? ` --server ${profile.server}` : ""}' (or 'scalius auth login') in a terminal, then restart the agent.`;
  let negotiated: string | undefined;
  let sessionId: string | undefined;
  const controllers = new Map<string, AbortController>();
  const send = (value: unknown) => {
    runtime.stdout.write(`${JSON.stringify(value)}\n`);
  };

  const forward = async (message: unknown): Promise<void> => {
    const single = isRecord(message) ? message : undefined;
    const id = single?.id;
    const method = typeof single?.method === "string" ? single.method : undefined;
    const expectsReply = single !== undefined && "id" in single && method !== undefined;
    if (!profile?.token) {
      if (expectsReply) send(rpcError(id, -32001, `Scalius is not connected: ${setupError ?? "no credential"}. ${loginHint}`));
      return;
    }
    if (method === "notifications/cancelled" && isRecord(single?.params)) {
      controllers.get(String(single.params.requestId))?.abort();
    }
    const headers = new Headers({
      Authorization: `Bearer ${profile.token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    });
    const version = (single && envelopeVersion(single)) ?? negotiated;
    if (version) headers.set("MCP-Protocol-Version", version);
    if (method) headers.set("Mcp-Method", method);
    const name = method ? mcpNameFor(method, single?.params) : undefined;
    if (name) headers.set("Mcp-Name", name);
    if (sessionId) headers.set("Mcp-Session-Id", sessionId);
    const controller = new AbortController();
    const key = expectsReply ? String(id) : undefined;
    if (key !== undefined) controllers.set(key, controller);
    const relay = (reply: unknown) => {
      if (method === "initialize" && isRecord(reply) && reply.id === id && isRecord(reply.result) && typeof reply.result.protocolVersion === "string") {
        negotiated = reply.result.protocolVersion;
      }
      send(reply);
    };
    try {
      let response: Response;
      try {
        response = await fetchWithNetworkErrors(runtime, mcpUrl(profile.server, options.audience), {
          method: "POST",
          headers,
          body: JSON.stringify(message),
          redirect: "error",
          signal: controller.signal,
        });
      } catch (error) {
        if (expectsReply && !controller.signal.aborted) {
          send(rpcError(id, -32002, `The store could not be reached: ${error instanceof Error ? error.message : "network error"}.`));
        }
        return;
      }
      const session = response.headers.get("Mcp-Session-Id");
      if (session) sessionId = session;
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        if (expectsReply) send(rpcError(id, -32001, `The store rejected the Scalius credential (expired or revoked). ${loginHint}`));
        return;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (response.ok && contentType.toLowerCase().includes("text/event-stream") && response.body) {
        await relayEvents(response.body, relay).catch(() => undefined);
        return;
      }
      const text = await response.text();
      let messages: unknown[] = [];
      try {
        messages = parseMcpBody(text, contentType);
      } catch {
        if (expectsReply) send(rpcError(id, -32603, "The store sent an invalid MCP response."));
        return;
      }
      if (!response.ok) {
        const replies = messages.filter((candidate) => isRecord(candidate) && (candidate.error || candidate.result));
        if (replies.length > 0) replies.forEach(relay);
        else if (expectsReply) send(rpcError(id, -32000, `The store answered HTTP ${response.status}.`, { status: response.status }));
        return;
      }
      messages.forEach(relay);
    } finally {
      if (key !== undefined) controllers.delete(key);
    }
  };

  const lines = createInterface({ input: runtime.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  const inFlight = new Set<Promise<void>>();
  const streams = new Set<Promise<void>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      send(rpcError(null, -32600, "Message too large."));
      continue;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send(rpcError(null, -32700, "Parse error."));
      continue;
    }
    const streaming = isRecord(message) && typeof message.method === "string" && STREAMING_METHODS.has(message.method);
    const pool = streaming ? streams : inFlight;
    const task: Promise<void> = forward(message).catch(() => undefined).finally(() => pool.delete(task));
    pool.add(task);
    // The handshake settles the protocol version every later request carries.
    if (isRecord(message) && message.method === "initialize") await task;
    else if (inFlight.size >= MAX_IN_FLIGHT) await Promise.race(inFlight);
  }
  // The harness closed stdin: finish the requests it sent, then end open subscriptions.
  await Promise.all(inFlight);
  for (const controller of controllers.values()) controller.abort();
  await Promise.all(streams);
}
