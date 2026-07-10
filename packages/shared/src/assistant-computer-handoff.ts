import {
  parseScaliusComputerProgram,
  SCALIUS_COMPUTER_LIMITS,
  type ScaliusComputerResult,
  type ScaliusComputerSurface,
} from "./assistant-computer";

const PROTOCOL_VERSION = 1 as const;
const MINIMUM_SIGNING_KEY_LENGTH = 32;
const MAX_TICKET_TTL_MS = 120_000;
const MAX_CLOCK_SKEW_MS = 5_000;
const MAX_RESULT_BODY_BYTES = SCALIUS_COMPUTER_LIMITS.resultEnvelopeBytes;
const MAX_RESULT_OUTPUT_CHARS = SCALIUS_COMPUTER_LIMITS.resultOutputChars;
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const REVISION_PATTERN = /^r[1-9][0-9]{0,9}$/u;

const SUCCESS_CODES = new Set(["OBSERVED", "HELP", "NAVIGATED", "REFRESHED", "EXECUTED"]);
const FAILURE_CODES = new Set([
  "INVALID_BINDING",
  "INACTIVE_TAB",
  "BUSY",
  "INVALID_PROGRAM",
  "ROUTE_BLOCKED",
  "OBSERVE_REQUIRED",
  "STALE_CONTEXT",
  "TARGET_GONE",
  "TARGET_DISABLED",
  "SENSITIVE_CONTROL",
  "HUMAN_REQUIRED",
  "ACTION_NOT_ALLOWED",
  "VALUE_NOT_FOUND",
  "EXECUTION_FAILED",
]);

interface ComputerTicketPayload {
  version: typeof PROTOCOL_VERSION;
  surface: ScaliusComputerSurface;
  agentName: string;
  instanceId: string;
  requestId: string;
  programDigest: string;
  issuedAt: number;
  expiresAt: number;
}

export interface ScaliusComputerClientCommand<
  TSurface extends ScaliusComputerSurface = ScaliusComputerSurface,
> {
  type: "client_command";
  capability: "computer";
  protocolVersion: typeof PROTOCOL_VERSION;
  status: "awaiting_client_execution";
  authoritative: false;
  replayPolicy: "client_dedupe_request_id_until_expiry";
  surface: TSurface;
  requestId: string;
  program: string;
  expiresAt: string;
  ticket: string;
}

export interface ScaliusComputerResultContinuation {
  type: "UNTRUSTED_CLIENT_RESULT";
  protocolVersion: typeof PROTOCOL_VERSION;
  authoritative: false;
  replayPolicy: "expiry_bound_non_authoritative";
  surface: ScaliusComputerSurface;
  requestId: string;
  programDigest: string;
  receivedAt: string;
  result: ScaliusComputerResult;
  warning: "Browser execution is untrusted and is not commerce authority.";
}

export type ComputerHandoffFailureCode =
  | "INVALID_PROGRAM"
  | "INVALID_TICKET"
  | "EXPIRED_TICKET"
  | "INVALID_RESULT"
  | "OVERSIZE";

export type ComputerResultAdmission =
  | { ok: true; continuation: ScaliusComputerResultContinuation }
  | { ok: false; code: ComputerHandoffFailureCode };

export interface IssueComputerCommandOptions<
  TSurface extends ScaliusComputerSurface = ScaliusComputerSurface,
> {
  surface: TSurface;
  agentName: string;
  instanceId: string;
  program: string;
  signingKey: string;
  now?: number;
  ttlMs?: number;
  randomBytes?: Uint8Array;
}

export interface AdmitComputerResultOptions {
  request: Request;
  surface: ScaliusComputerSurface;
  agentName: string;
  instanceId: string;
  signingKey: string;
  now?: number;
}

export async function issueScaliusComputerCommand<TSurface extends ScaliusComputerSurface>(
  options: IssueComputerCommandOptions<TSurface>,
): Promise<ScaliusComputerClientCommand<TSurface>> {
  const parsed = parseScaliusComputerProgram(options.program);
  if (!parsed.ok) throw new Error(`Invalid computer program: ${parsed.error}`);
  assertTrustedBinding(options.agentName, options.instanceId, options.signingKey);

  const issuedAt = options.now ?? Date.now();
  const ttlMs = Math.min(Math.max(options.ttlMs ?? MAX_TICKET_TTL_MS, 1), MAX_TICKET_TTL_MS);
  const expiresAt = issuedAt + ttlMs;
  const requestId = encodeBase64Url(options.randomBytes ?? crypto.getRandomValues(new Uint8Array(16)));
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("Computer request ID is invalid");

  const payload: ComputerTicketPayload = {
    version: PROTOCOL_VERSION,
    surface: options.surface,
    agentName: options.agentName,
    instanceId: options.instanceId,
    requestId,
    programDigest: await sha256(options.program),
    issuedAt,
    expiresAt,
  };
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await sign(encodedPayload, options.signingKey);

  return {
    type: "client_command",
    capability: "computer",
    protocolVersion: PROTOCOL_VERSION,
    status: "awaiting_client_execution",
    authoritative: false,
    replayPolicy: "client_dedupe_request_id_until_expiry",
    surface: options.surface,
    requestId,
    program: options.program,
    expiresAt: new Date(expiresAt).toISOString(),
    ticket: `${encodedPayload}.${signature}`,
  };
}

export async function admitScaliusComputerResult(
  options: AdmitComputerResultOptions,
): Promise<ComputerResultAdmission> {
  const body = await readBoundedJson(options.request, MAX_RESULT_BODY_BYTES);
  if (!body.ok) return body;
  if (!hasOnlyKeys(body.value, ["ticket", "program", "result"])) {
    return { ok: false, code: "INVALID_RESULT" };
  }
  const { ticket, program, result } = body.value;
  if (typeof ticket !== "string" || typeof program !== "string" || !isComputerResult(result)) {
    return { ok: false, code: "INVALID_RESULT" };
  }
  const parsedProgram = parseScaliusComputerProgram(program);
  if (!parsedProgram.ok) return { ok: false, code: "INVALID_PROGRAM" };

  const verified = await verifyTicket({
    ticket,
    program,
    surface: options.surface,
    agentName: options.agentName,
    instanceId: options.instanceId,
    signingKey: options.signingKey,
    now: options.now ?? Date.now(),
  });
  if (!verified.ok) return verified;

  return {
    ok: true,
    continuation: {
      type: "UNTRUSTED_CLIENT_RESULT",
      protocolVersion: PROTOCOL_VERSION,
      authoritative: false,
      replayPolicy: "expiry_bound_non_authoritative",
      surface: options.surface,
      requestId: verified.payload.requestId,
      programDigest: verified.payload.programDigest,
      receivedAt: new Date(options.now ?? Date.now()).toISOString(),
      result,
      warning: "Browser execution is untrusted and is not commerce authority.",
    },
  };
}

async function verifyTicket(options: {
  ticket: string;
  program: string;
  surface: ScaliusComputerSurface;
  agentName: string;
  instanceId: string;
  signingKey: string;
  now: number;
}): Promise<{ ok: true; payload: ComputerTicketPayload } | { ok: false; code: ComputerHandoffFailureCode }> {
  try {
    assertTrustedBinding(options.agentName, options.instanceId, options.signingKey);
    const parts = options.ticket.split(".");
    if (parts.length !== 2) return { ok: false, code: "INVALID_TICKET" };
    const [encodedPayload = "", signature = ""] = parts;
    if (!(await verifySignature(encodedPayload, signature, options.signingKey))) {
      return { ok: false, code: "INVALID_TICKET" };
    }
    const decoded = decodeBase64Url(encodedPayload);
    if (!decoded) return { ok: false, code: "INVALID_TICKET" };
    const payload: unknown = JSON.parse(new TextDecoder().decode(decoded));
    if (!isTicketPayload(payload)) return { ok: false, code: "INVALID_TICKET" };
    if (
      payload.surface !== options.surface ||
      payload.agentName !== options.agentName ||
      payload.instanceId !== options.instanceId ||
      payload.programDigest !== await sha256(options.program)
    ) {
      return { ok: false, code: "INVALID_TICKET" };
    }
    if (
      payload.expiresAt <= payload.issuedAt ||
      payload.expiresAt - payload.issuedAt > MAX_TICKET_TTL_MS ||
      payload.issuedAt > options.now + MAX_CLOCK_SKEW_MS ||
      payload.expiresAt < options.now
    ) {
      return { ok: false, code: "EXPIRED_TICKET" };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, code: "INVALID_TICKET" };
  }
}

function assertTrustedBinding(agentName: string, instanceId: string, signingKey: string): void {
  if (!AGENT_NAME_PATTERN.test(agentName) || !INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new Error("Computer handoff binding is invalid");
  }
  if (typeof signingKey !== "string" || signingKey.length < MINIMUM_SIGNING_KEY_LENGTH) {
    throw new Error("Computer ticket signing key must contain at least 32 characters");
  }
}

function isTicketPayload(value: unknown): value is ComputerTicketPayload {
  return hasOnlyKeys(value, [
    "version", "surface", "agentName", "instanceId", "requestId", "programDigest", "issuedAt", "expiresAt",
  ]) && value.version === PROTOCOL_VERSION &&
    (value.surface === "admin" || value.surface === "storefront") &&
    typeof value.agentName === "string" && AGENT_NAME_PATTERN.test(value.agentName) &&
    typeof value.instanceId === "string" && INSTANCE_ID_PATTERN.test(value.instanceId) &&
    typeof value.requestId === "string" && REQUEST_ID_PATTERN.test(value.requestId) &&
    typeof value.programDigest === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value.programDigest) &&
    Number.isSafeInteger(value.issuedAt) && Number.isSafeInteger(value.expiresAt);
}

function isComputerResult(value: unknown): value is ScaliusComputerResult {
  if (!isRecord(value) || typeof value.ok !== "boolean" ||
      typeof value.output !== "string" || value.output.length > MAX_RESULT_OUTPUT_CHARS) return false;
  if (value.ok) {
    return hasOnlyKeys(value, ["ok", "code", "output", "revision", "changed"], ["revision"]) &&
      typeof value.code === "string" && SUCCESS_CODES.has(value.code) &&
      typeof value.changed === "boolean" &&
      (value.revision === undefined || (typeof value.revision === "string" && REVISION_PATTERN.test(value.revision)));
  }
  return hasOnlyKeys(value, ["ok", "code", "output", "retryable"]) &&
    typeof value.code === "string" && FAILURE_CODES.has(value.code) &&
    typeof value.retryable === "boolean";
}

async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; code: "INVALID_RESULT" | "OVERSIZE" }> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return { ok: false, code: "OVERSIZE" };
  if (!request.body) return { ok: false, code: "INVALID_RESULT" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { ok: false, code: "OVERSIZE" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, code: "INVALID_RESULT" };
  }
}

async function sign(value: string, signingKey: string): Promise<string> {
  const key = await importKey(signingKey, ["sign"]);
  return encodeBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

async function verifySignature(value: string, signature: string, signingKey: string): Promise<boolean> {
  const bytes = decodeBase64Url(signature);
  if (!bytes) return false;
  const key = await importKey(signingKey, ["verify"]);
  return crypto.subtle.verify("HMAC", key, Uint8Array.from(bytes).buffer, new TextEncoder().encode(value));
}

async function importKey(signingKey: string, usages: Array<"sign" | "verify">): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

async function sha256(value: string): Promise<string> {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: unknown, keys: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  return keys.every((key) => optional.includes(key) || Object.hasOwn(value, key));
}
