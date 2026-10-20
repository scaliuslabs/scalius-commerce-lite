import { CliError, exitCodeForHttpStatus, type CliErrorEnvelope } from "./errors.js";
import { bearerHeaders, fetchWithNetworkErrors, responseError } from "./http.js";
import type { ResolvedProfile, Runtime } from "./types.js";

// The CLI talks to the same MCP tools an agent harness uses (scalius_search,
// scalius_describe, scalius_answer, scalius_read, scalius_write), so dry
// runs, confirmation, response budgets and error hints have one server-side
// implementation. Each call is one stateless 2026-07-28 request: the
// protocol version and client capabilities travel in the request envelope,
// and there is no session to open. No MCP client library is needed.

export const MCP_PROTOCOL_VERSION = "2026-07-28";
export type Audience = "dashboard" | "storefront";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const RETRYABLE_STATUS = new Set([408, 425, 429, 502, 503, 504]);

export function mcpPath(audience: Audience): string {
  return `/api/v1/mcp/${audience}`;
}

export function mcpUrl(server: string, audience: Audience): string {
  return `${server}${mcpPath(audience)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `Mcp-Name` header value a 2026-07-28 request mirrors from its params. */
export function mcpNameFor(method: string, params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  if ((method === "tools/call" || method === "prompts/get") && typeof params.name === "string") return params.name;
  if ((method === "resources/read" || method === "resources/subscribe") && typeof params.uri === "string") return params.uri;
  return undefined;
}

/** The JSON-RPC messages in a response body: one JSON document, or the `data:` events of a stream. */
export function parseMcpBody(text: string, contentType: string | null): unknown[] {
  if (!text.trim()) return [];
  if ((contentType ?? "").toLowerCase().includes("text/event-stream")) {
    const messages: unknown[] = [];
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (!data) continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        throw new CliError(8, "invalid_server_response", "The MCP server sent an invalid event.");
      }
    }
    return messages;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new CliError(8, "invalid_server_response", "The MCP server sent invalid JSON.");
  }
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("Retry-After");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 120_000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 120_000)) : undefined;
}

function authHint(profile: ResolvedProfile, audience: Audience): string {
  return `Run 'scalius auth login --server ${profile.server}${audience === "storefront" ? " --resource storefront" : ""}' (or 'scalius init') to pair again.`;
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new CliError(8, "output_too_large", "The MCP response is larger than 4 MiB.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new CliError(8, "output_too_large", "The MCP response is larger than 4 MiB.");
  return new TextDecoder().decode(bytes);
}

export interface McpRequestOptions {
  /** Retry temporary failures (429, 5xx, network) with backoff. Only for calls that are safe to repeat. */
  retry?: boolean;
  maxAttempts?: number;
  /** The client capabilities this request declares (form elicitation only when a person can answer). */
  capabilities?: Record<string, unknown>;
}

export interface ToolCallOptions extends McpRequestOptions {
  /**
   * Asks the person at the terminal to approve a server dialog (MCP form
   * elicitation). Set only when stdin and stderr are a TTY: without it the CLI
   * declares no dialog support, and a gated change answers with an approval
   * link for the dashboard instead.
   */
  confirm?: (message: string) => Promise<boolean>;
}

let requestCounter = 0;

/** One JSON-RPC request to the audience's MCP endpoint; returns its `result`. */
export async function mcpRequest(
  runtime: Runtime,
  profile: ResolvedProfile,
  audience: Audience,
  method: string,
  params: Record<string, unknown> = {},
  options: McpRequestOptions = {},
): Promise<Record<string, unknown>> {
  if (!profile.token) {
    throw new CliError(3, "not_authenticated", "This command needs a paired Scalius credential.", undefined, { hint: authHint(profile, audience) });
  }
  const attempts = options.retry ? Math.max(1, options.maxAttempts ?? 4) : 1;
  requestCounter += 1;
  const id = requestCounter;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": options.capabilities ?? {},
      },
    },
  });
  let lastError: CliError | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (runtime.signal?.aborted) throw new CliError(130, "interrupted", "Operation interrupted.");
    const headers = bearerHeaders(profile.token);
    headers.set("Accept", "application/json, text/event-stream");
    headers.set("Content-Type", "application/json");
    headers.set("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
    headers.set("Mcp-Method", method);
    const name = mcpNameFor(method, params);
    if (name) headers.set("Mcp-Name", name);
    let response: Response;
    try {
      response = await fetchWithNetworkErrors(runtime, mcpUrl(profile.server, audience), {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: runtime.signal,
      });
    } catch (error) {
      const cliError = error instanceof CliError ? error : new CliError(7, "network_error", "Network request failed.");
      if (cliError.exitCode !== 7 || attempt === attempts) throw cliError;
      lastError = cliError;
      await runtime.sleep(Math.min(500 * 2 ** (attempt - 1), 8_000));
      continue;
    }
    if (!response.ok) {
      const wait = retryAfterMs(response);
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        throw new CliError(3, "credential_rejected", "The store rejected this credential (expired, revoked, or for another store).", { status: 401 }, {
          status: 401,
          hint: authHint(profile, audience),
        });
      }
      const failure = await responseError(response, `The MCP endpoint answered HTTP ${response.status}.`);
      const enriched = new CliError(failure.exitCode, failure.errorCode, failure.message, failure.details, {
        status: response.status,
        retryable: RETRYABLE_STATUS.has(response.status),
        ...(wait === undefined ? {} : { retryAfterMs: wait }),
        ...(response.status === 404 ? { hint: "This server has no agent MCP endpoint yet: update the store's API." } : {}),
      });
      if (!options.retry || !RETRYABLE_STATUS.has(response.status) || attempt === attempts) throw enriched;
      lastError = enriched;
      await runtime.sleep(wait ?? Math.min(500 * 2 ** (attempt - 1), 8_000));
      continue;
    }
    const messages = parseMcpBody(await readBounded(response), response.headers.get("content-type"));
    const message = messages.find((candidate) => isRecord(candidate) && candidate.id === id) as Record<string, unknown> | undefined;
    if (!message) throw new CliError(8, "invalid_server_response", "The MCP server sent no response for the request.");
    if (isRecord(message.error)) {
      const code = typeof message.error.code === "number" ? message.error.code : 0;
      const text = typeof message.error.message === "string" ? message.error.message.slice(0, 1000) : "MCP request failed.";
      throw new CliError(code === -32602 || code === -32600 ? 5 : 8, code === -32601 ? "mcp_method_not_found" : "mcp_error", text, { jsonRpcCode: code });
    }
    if (!isRecord(message.result)) throw new CliError(8, "invalid_server_response", "The MCP response has no result.");
    return message.result;
  }
  throw lastError ?? new CliError(7, "network_error", "Network request failed.");
}

/** A tool's structured result and whether the tool reported an error. */
export interface ToolResult {
  isError: boolean;
  value: Record<string, unknown>;
  links: Array<{ uri: string; name?: string; mimeType?: string }>;
}

const MAX_DIALOG_ROUNDS = 3;

/** The approval dialog a 2026-07-28 server asks for: `inputRequests.confirm`. */
function confirmDialogOf(result: Record<string, unknown>): { message: string } | null {
  if (result.resultType !== "input_required" || !isRecord(result.inputRequests)) return null;
  const request = result.inputRequests.confirm;
  if (!isRecord(request) || request.method !== "elicitation/create" || !isRecord(request.params)) return null;
  return { message: typeof request.params.message === "string" ? request.params.message.slice(0, 600) : "Approve this change?" };
}

export async function callTool(
  runtime: Runtime,
  profile: ResolvedProfile,
  audience: Audience,
  name: string,
  args: Record<string, unknown>,
  options: ToolCallOptions = {},
): Promise<ToolResult> {
  const { confirm, ...requestOptions } = options;
  const capabilities = confirm ? { elicitation: { form: {} } } : {};
  let retryParams: Record<string, unknown> = {};
  let result: Record<string, unknown> | undefined;
  for (let round = 0; round <= MAX_DIALOG_ROUNDS; round += 1) {
    result = await mcpRequest(runtime, profile, audience, "tools/call", { name, arguments: args, ...retryParams }, { ...requestOptions, capabilities });
    const dialog = confirmDialogOf(result);
    if (!dialog) break;
    if (!confirm || typeof result.requestState !== "string" || round === MAX_DIALOG_ROUNDS) {
      throw new CliError(8, "invalid_server_response", "The server asked for a dialog the CLI did not offer.");
    }
    // The person's answer, read from the terminal: the request is repeated
    // with it and the server's request state, byte for byte.
    const approved = await confirm(dialog.message);
    retryParams = {
      inputResponses: { confirm: approved ? { action: "accept", content: { confirm: true } } : { action: "decline" } },
      requestState: result.requestState,
    };
  }
  result = result!;
  const content = Array.isArray(result.content) ? result.content.filter(isRecord) : [];
  let value = isRecord(result.structuredContent) ? result.structuredContent : undefined;
  if (!value) {
    const text = content.find((item) => item.type === "text" && typeof item.text === "string")?.text as string | undefined;
    try {
      value = text ? JSON.parse(text) as Record<string, unknown> : undefined;
    } catch {
      value = undefined;
    }
  }
  if (!isRecord(value)) {
    if (result.resultType === "input_required" || isRecord(result.inputRequests)) {
      throw new CliError(8, "invalid_server_response", "The server asked for a dialog the CLI did not offer.");
    }
    throw new CliError(8, "invalid_server_response", `${name} returned no structured result.`);
  }
  const links = content
    .filter((item) => item.type === "resource_link" && typeof item.uri === "string")
    .map((item) => ({
      uri: item.uri as string,
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
    }));
  return { isError: result.isError === true || value.ok === false, value, links };
}

/** The tool error envelope as a CLI error, keeping code, status, retryable, hint and current. */
export function toolError(value: Record<string, unknown>, fallbackCode = "operation_failed"): CliError {
  const error = isRecord(value.error) ? value.error : {};
  const status = typeof error.status === "number" ? error.status : undefined;
  const code = typeof error.code === "string" ? error.code : fallbackCode;
  const message = typeof error.message === "string" ? error.message : "The operation failed.";
  const envelope: CliErrorEnvelope = {
    ...(status === undefined ? {} : { status }),
    ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
    ...(typeof error.hint === "string" ? { hint: error.hint } : {}),
    ...(error.current !== undefined ? { current: error.current } : {}),
    ...(typeof error.field === "string" ? { field: error.field } : {}),
    ...(typeof error.requestId === "string" ? { requestId: error.requestId } : {}),
    ...(typeof error.retryAfterMs === "number" ? { retryAfterMs: error.retryAfterMs } : {}),
  };
  const confirmation = isRecord(value.confirmation) ? value.confirmation : undefined;
  if (code === "confirmation_required") {
    return new CliError(10, code, message, confirmation ? { confirmation } : undefined, envelope);
  }
  // The person said no in the dialog: nothing was written, the same exit as an unapproved change.
  if (code === "confirmation_declined") return new CliError(10, code, message, undefined, envelope);
  const exitCode = code === "operation_not_found" ? 5 : status === undefined ? 8 : exitCodeForHttpStatus(status);
  return new CliError(exitCode, code, message, undefined, envelope);
}
