import {
  parseScaliusComputerProgram,
  type ScaliusComputerResult,
} from "@scalius/shared/assistant-computer";
import type { ScaliusComputerClientCommand } from "@scalius/shared/assistant-computer-handoff";

import type { AdminAssistantComputerRuntime } from "./runtime";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,1600}\.[A-Za-z0-9_-]{43}$/u;
const MAX_CLIENT_COMMAND_LIFETIME_MS = 125_000;
const MAX_RESULT_REQUEST_BYTES = 20_000;
const MAX_RESULT_RESPONSE_BYTES = 4_096;
const RESULT_ENDPOINT = "/api/assistant/flue/computer/results";
export const ADMIN_FLUE_COMPUTER_DEDUPE_STORAGE_KEY =
  "scalius.admin-flue.computer-dedupe.v1";

const CLIENT_COMMAND_KEYS = new Set([
  "type",
  "capability",
  "protocolVersion",
  "status",
  "authoritative",
  "replayPolicy",
  "surface",
  "requestId",
  "program",
  "expiresAt",
  "ticket",
]);

export type AdminFlueComputerPhase =
  | "executing"
  | "posting_untrusted_result"
  | "continuation_accepted"
  | "continuation_failed";

export type AdminFlueComputerConsumeResult =
  | { status: "ignored" }
  | {
      status: "rejected";
      reason:
        | "binding_mismatch"
        | "invalid_client_command"
        | "expired_client_command"
        | "request_id_collision"
        | "dedupe_capacity";
    }
  | { status: "duplicate"; requestId: string; phase: AdminFlueComputerPhase }
  | {
      status: "continuation_failed";
      requestId: string;
      result: ScaliusComputerResult;
    }
  | {
      status: "continuation_accepted";
      requestId: string;
      result: ScaliusComputerResult;
      /** This acknowledges only the untrusted continuation, not a commerce fact. */
      authoritative: false;
    };

export interface AdminFlueDynamicToolPart {
  type: "dynamic-tool";
  toolName: string;
  toolCallId: string;
  state: "output-available";
  input: unknown;
  output: unknown;
}

export interface AdminFlueComputerPartSource {
  /** Trusted Flue subscription state, never read from the tool output. */
  threadId: string;
  /** The tab identity used to construct the page runtime. */
  tabId: string;
  part: unknown;
}

export interface AdminFlueComputerResultPayload {
  surface: "admin";
  threadId: string;
  requestId: string;
  ticket: string;
  program: string;
  result: ScaliusComputerResult;
}

export interface AdminFlueComputerCoordinatorOptions {
  runtime: AdminAssistantComputerRuntime;
  postResult?: (
    payload: AdminFlueComputerResultPayload,
  ) => Promise<{ accepted: true; requestId: string }>;
  now?: () => number;
  onPhase?: (requestId: string, phase: AdminFlueComputerPhase) => void;
  maxTrackedRequests?: number;
  /** Stores opaque request lifecycle only; never programs, tickets, results, or page data. */
  dedupeStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

interface TrackedCommand {
  expiresAt: number;
  fingerprint: string;
  phase: AdminFlueComputerPhase;
}

interface PersistedCommandMarker {
  threadId: string;
  requestId: string;
  expiresAt: number;
  phase: AdminFlueComputerPhase;
}

/**
 * Executes one Flue browser command at most once for the lifetime of this
 * bound Admin tab coordinator. Flue stream replays are expected and are
 * deduplicated by the signed command requestId until its expiry.
 */
export class AdminFlueComputerCoordinator {
  readonly #runtime: AdminAssistantComputerRuntime;
  readonly #postResult: NonNullable<AdminFlueComputerCoordinatorOptions["postResult"]>;
  readonly #now: () => number;
  readonly #onPhase?: AdminFlueComputerCoordinatorOptions["onPhase"];
  readonly #maxTrackedRequests: number;
  readonly #dedupeStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  readonly #tracked = new Map<string, TrackedCommand>();

  constructor(options: AdminFlueComputerCoordinatorOptions) {
    this.#runtime = options.runtime;
    this.#postResult = options.postResult ?? postAdminFlueComputerResult;
    this.#now = options.now ?? Date.now;
    this.#onPhase = options.onPhase;
    this.#maxTrackedRequests = Math.min(
      Math.max(options.maxTrackedRequests ?? 128, 8),
      256,
    );
    this.#dedupeStorage = options.dedupeStorage === undefined
      ? resolveSessionStorage()
      : options.dedupeStorage;
  }

  async consume(
    source: AdminFlueComputerPartSource,
  ): Promise<AdminFlueComputerConsumeResult> {
    if (!isOutputAvailableComputerPart(source.part)) return { status: "ignored" };
    if (
      source.threadId !== this.#runtime.binding.threadId ||
      source.tabId !== this.#runtime.binding.tabId ||
      this.#runtime.binding.surface !== "admin"
    ) {
      return { status: "rejected", reason: "binding_mismatch" };
    }

    const now = this.#now();
    this.#purgeExpired(now);
    const parsed = parseAdminFlueComputerClientCommand(source.part.output, now);
    if (!parsed.ok) return { status: "rejected", reason: parsed.reason };
    const command = parsed.command;
    const fingerprint = `${command.ticket}\n${command.program}`;
    const existing = this.#tracked.get(command.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return { status: "rejected", reason: "request_id_collision" };
      }
      return {
        status: "duplicate",
        requestId: command.requestId,
        phase: existing.phase,
      };
    }
    const persisted = this.#findPersisted(source.threadId, command.requestId, now);
    if (persisted) {
      return {
        status: "duplicate",
        requestId: command.requestId,
        phase: persisted.phase,
      };
    }
    if (
      this.#tracked.size >= this.#maxTrackedRequests ||
      !this.#canPersistAnotherMarker(now)
    ) {
      return { status: "rejected", reason: "dedupe_capacity" };
    }

    // Claim before awaiting page work. Concurrent stream renders cannot run it twice.
    this.#setPhase(command, fingerprint, "executing");
    let result: ScaliusComputerResult;
    try {
      result = await this.#runtime.execute({
        binding: this.#runtime.binding,
        program: command.program,
      });
    } catch {
      result = {
        ok: false,
        code: "EXECUTION_FAILED",
        output: "The Admin page could not complete that command. Observe and try again.",
        retryable: true,
      };
    }

    this.#setPhase(command, fingerprint, "posting_untrusted_result");
    try {
      const admission = await this.#postResult({
        surface: "admin",
        threadId: source.threadId,
        requestId: command.requestId,
        ticket: command.ticket,
        program: command.program,
        result,
      });
      if (admission.requestId !== command.requestId) throw new Error("Result admission mismatch");
      this.#setPhase(command, fingerprint, "continuation_accepted");
      return {
        status: "continuation_accepted",
        requestId: command.requestId,
        result,
        authoritative: false,
      };
    } catch {
      // The delivery outcome is uncertain. Do not execute or post this requestId again;
      // a new signed command is required until server-side replay admission exists.
      this.#setPhase(command, fingerprint, "continuation_failed");
      return { status: "continuation_failed", requestId: command.requestId, result };
    }
  }

  #setPhase(
    command: ScaliusComputerClientCommand<"admin">,
    fingerprint: string,
    phase: AdminFlueComputerPhase,
  ): void {
    this.#tracked.set(command.requestId, {
      expiresAt: Date.parse(command.expiresAt),
      fingerprint,
      phase,
    });
    this.#persistMarker({
      threadId: this.#runtime.binding.threadId,
      requestId: command.requestId,
      expiresAt: Date.parse(command.expiresAt),
      phase,
    });
    this.#onPhase?.(command.requestId, phase);
  }

  #purgeExpired(now: number): void {
    for (const [requestId, tracked] of this.#tracked) {
      if (tracked.expiresAt <= now) this.#tracked.delete(requestId);
    }
    this.#readPersisted(now);
  }

  #findPersisted(
    threadId: string,
    requestId: string,
    now: number,
  ): PersistedCommandMarker | undefined {
    return this.#readPersisted(now).find(
      (entry) => entry.threadId === threadId && entry.requestId === requestId,
    );
  }

  #canPersistAnotherMarker(now: number): boolean {
    return !this.#dedupeStorage || this.#readPersisted(now).length < this.#maxTrackedRequests;
  }

  #persistMarker(marker: PersistedCommandMarker): void {
    if (!this.#dedupeStorage) return;
    const entries = this.#readPersisted(this.#now());
    const index = entries.findIndex(
      (entry) => entry.threadId === marker.threadId && entry.requestId === marker.requestId,
    );
    if (index >= 0) entries[index] = marker;
    else entries.push(marker);
    try {
      this.#dedupeStorage.setItem(
        ADMIN_FLUE_COMPUTER_DEDUPE_STORAGE_KEY,
        JSON.stringify(entries.slice(-this.#maxTrackedRequests)),
      );
    } catch {
      // Storage can disappear in privacy modes; the in-memory claim remains authoritative.
    }
  }

  #readPersisted(now: number): PersistedCommandMarker[] {
    const storage = this.#dedupeStorage;
    if (!storage) return [];
    let raw: string | null;
    try {
      raw = storage.getItem(ADMIN_FLUE_COMPUTER_DEDUPE_STORAGE_KEY);
    } catch {
      return [];
    }
    if (!raw) return [];
    if (raw.length > 32_768) {
      try { storage.removeItem(ADMIN_FLUE_COMPUTER_DEDUPE_STORAGE_KEY); } catch { /* noop */ }
      return [];
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      try { storage.removeItem(ADMIN_FLUE_COMPUTER_DEDUPE_STORAGE_KEY); } catch { /* noop */ }
      return [];
    }
    if (!Array.isArray(value)) return [];
    const entries = value.filter(isPersistedCommandMarker).filter((entry) => entry.expiresAt > now);
    if (entries.length !== value.length) {
      try {
        if (entries.length > 0) {
          storage.setItem(ADMIN_FLUE_COMPUTER_DEDUPE_STORAGE_KEY, JSON.stringify(entries));
        } else {
          storage.removeItem(ADMIN_FLUE_COMPUTER_DEDUPE_STORAGE_KEY);
        }
      } catch {
        // The in-memory map still protects this coordinator instance.
      }
    }
    return entries.slice(-this.#maxTrackedRequests);
  }
}

export function parseAdminFlueComputerClientCommand(
  value: unknown,
  now = Date.now(),
):
  | { ok: true; command: ScaliusComputerClientCommand<"admin"> }
  | {
      ok: false;
      reason: "invalid_client_command" | "expired_client_command";
    } {
  if (!isRecord(value) || !hasOnlyKeys(value, CLIENT_COMMAND_KEYS)) {
    return { ok: false, reason: "invalid_client_command" };
  }
  if (
    value.type !== "client_command" ||
    value.capability !== "computer" ||
    value.protocolVersion !== 1 ||
    value.status !== "awaiting_client_execution" ||
    value.authoritative !== false ||
    value.replayPolicy !== "client_dedupe_request_id_until_expiry" ||
    value.surface !== "admin" ||
    typeof value.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(value.requestId) ||
    typeof value.program !== "string" ||
    !parseScaliusComputerProgram(value.program).ok ||
    typeof value.expiresAt !== "string" ||
    typeof value.ticket !== "string" ||
    !TICKET_PATTERN.test(value.ticket)
  ) {
    return { ok: false, reason: "invalid_client_command" };
  }
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isSafeInteger(expiresAt) || new Date(expiresAt).toISOString() !== value.expiresAt) {
    return { ok: false, reason: "invalid_client_command" };
  }
  if (expiresAt <= now || expiresAt > now + MAX_CLIENT_COMMAND_LIFETIME_MS) {
    return { ok: false, reason: "expired_client_command" };
  }
  return { ok: true, command: value as unknown as ScaliusComputerClientCommand<"admin"> };
}

export async function postAdminFlueComputerResult(
  payload: AdminFlueComputerResultPayload,
  fetcher: typeof fetch = fetch,
): Promise<{ accepted: true; requestId: string }> {
  if (
    payload.surface !== "admin" ||
    !THREAD_ID_PATTERN.test(payload.threadId) ||
    !REQUEST_ID_PATTERN.test(payload.requestId)
  ) {
    throw new Error("Admin computer result binding is invalid");
  }
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).byteLength > MAX_RESULT_REQUEST_BYTES) {
    throw new Error("Admin computer result is too large");
  }
  const response = await fetcher(RESULT_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body,
  });
  const responseBody = await readBoundedJsonResponse(response, MAX_RESULT_RESPONSE_BYTES);
  if (
    response.status !== 202 ||
    !isRecord(responseBody) ||
    responseBody.accepted !== true ||
    responseBody.requestId !== payload.requestId
  ) {
    throw new Error("Admin computer continuation was not accepted");
  }
  return { accepted: true, requestId: payload.requestId };
}

function isOutputAvailableComputerPart(value: unknown): value is AdminFlueDynamicToolPart {
  return isRecord(value) &&
    value.type === "dynamic-tool" &&
    value.toolName === "computer" &&
    value.state === "output-available" &&
    typeof value.toolCallId === "string" &&
    value.toolCallId.length > 0 &&
    value.toolCallId.length <= 160 &&
    "output" in value;
}

function isPersistedCommandMarker(value: unknown): value is PersistedCommandMarker {
  return isRecord(value) &&
    hasOnlyKeys(value, new Set(["threadId", "requestId", "expiresAt", "phase"])) &&
    typeof value.threadId === "string" && THREAD_ID_PATTERN.test(value.threadId) &&
    typeof value.requestId === "string" && REQUEST_ID_PATTERN.test(value.requestId) &&
    Number.isSafeInteger(value.expiresAt) &&
    isAdminFlueComputerPhase(value.phase);
}

function isAdminFlueComputerPhase(value: unknown): value is AdminFlueComputerPhase {
  return value === "executing" ||
    value === "posting_untrusted_result" ||
    value === "continuation_accepted" ||
    value === "continuation_failed";
}

function resolveSessionStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

async function readBoundedJsonResponse(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key)) &&
    Object.keys(value).length === allowed.size;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
