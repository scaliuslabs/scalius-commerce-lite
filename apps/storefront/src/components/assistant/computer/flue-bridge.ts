import {
  parseScaliusComputerProgram,
  SCALIUS_COMPUTER_LIMITS,
  type ScaliusComputerResult,
} from "@scalius/shared/assistant-computer";
import type { ScaliusComputerClientCommand } from "@scalius/shared/assistant-computer-handoff";

import type { StorefrontAssistantComputerRuntime } from "./runtime";
import {
  getAuthorizedStorefrontNavigationRoutes,
  type StorefrontNavigationAuthority,
} from "../storefront-navigation-authority";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const THREAD_ID_PATTERN = /^conv_[A-Za-z0-9_-]{22,64}$/u;
const TAB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,1600}\.[A-Za-z0-9_-]{43}$/u;
const MAX_CLIENT_COMMAND_LIFETIME_MS = 125_000;
const MAX_RESULT_REQUEST_BYTES = SCALIUS_COMPUTER_LIMITS.resultEnvelopeBytes;
const MAX_RESULT_RESPONSE_BYTES = 4_096;
const MAX_CANCELLATION_REQUEST_BYTES = SCALIUS_COMPUTER_LIMITS.resultEnvelopeBytes;
const MAX_DEDUPE_STORAGE_BYTES = 32_768;

export const STOREFRONT_FLUE_COMPUTER_DEDUPE_STORAGE_KEY =
  "scalius.storefront-flue.computer-dedupe.v1";

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

export type StorefrontFlueComputerPhase =
  | "executing"
  | "posting_untrusted_result"
  | "cancelled"
  | "continuation_accepted"
  | "continuation_failed";

export type StorefrontFlueComputerConsumeResult =
  | { status: "ignored" }
  | {
      status: "rejected";
      reason:
        | "binding_mismatch"
        | "invalid_client_command"
        | "expired_client_command"
        | "request_id_collision"
        | "dedupe_capacity"
        | "dedupe_unavailable";
    }
  | {
      status: "duplicate";
      requestId: string;
      phase: StorefrontFlueComputerPhase;
    }
  | {
      status: "continuation_failed";
      requestId: string;
      result: ScaliusComputerResult;
    }
  | {
      status: "cancelled";
      requestId: string;
    }
  | {
      status: "continuation_accepted";
      requestId: string;
      result: ScaliusComputerResult;
      /** This acknowledges only the untrusted continuation, not a commerce fact. */
      authoritative: false;
    };

export interface StorefrontFlueDynamicToolPart {
  type: "dynamic-tool";
  toolName: string;
  toolCallId: string;
  state: "output-available";
  input: unknown;
  output: unknown;
}

export interface StorefrontFlueComputerPartSource {
  /** Trusted Flue subscription state, never read from the tool output. */
  threadId: string;
  /** The opaque tab identity used to construct the page runtime. */
  tabId: string;
  /** Latest-user intent plus short-lived Scalius/visible-page route proof. */
  navigationAuthority?: StorefrontNavigationAuthority;
  part: unknown;
}

export interface StorefrontFlueComputerResultPayload {
  surface: "storefront";
  threadId: string;
  requestId: string;
  ticket: string;
  program: string;
  result: ScaliusComputerResult;
}

export type StorefrontFlueComputerCancellationPayload = Omit<
  StorefrontFlueComputerResultPayload,
  "result"
>;

export interface StorefrontFlueComputerCoordinatorOptions {
  runtime: StorefrontAssistantComputerRuntime;
  postResult?: (
    payload: StorefrontFlueComputerResultPayload,
    options?: { signal?: AbortSignal },
  ) => Promise<{ accepted: true; requestId: string }>;
  postCancellation?: (
    payload: StorefrontFlueComputerCancellationPayload,
    options?: { signal?: AbortSignal },
  ) => Promise<{ accepted: true; requestId: string }>;
  now?: () => number;
  onPhase?: (requestId: string, phase: StorefrontFlueComputerPhase) => void;
  maxTrackedRequests?: number;
  /** Stores opaque request lifecycle only; never programs, tickets, results, or page data. */
  dedupeStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

interface TrackedCommand {
  expiresAt: number;
  fingerprint: string;
  phase: StorefrontFlueComputerPhase;
}

interface PersistedCommandMarker {
  threadId: string;
  tabId: string;
  requestId: string;
  expiresAt: number;
  phase: StorefrontFlueComputerPhase;
}

interface ActiveCommand {
  abortController: AbortController;
  command: ScaliusComputerClientCommand<"storefront">;
  fingerprint: string;
  generation: number;
}

/**
 * Executes one signed Flue browser command at most once in one active
 * Storefront tab. Flue stream replay is expected, so the opaque request marker
 * is persisted before any page work and retained until the ticket expires.
 */
export class StorefrontFlueComputerCoordinator {
  readonly #runtime: StorefrontAssistantComputerRuntime;
  readonly #postResult: NonNullable<
    StorefrontFlueComputerCoordinatorOptions["postResult"]
  >;
  readonly #postCancellation: NonNullable<
    StorefrontFlueComputerCoordinatorOptions["postCancellation"]
  >;
  readonly #now: () => number;
  readonly #onPhase?: StorefrontFlueComputerCoordinatorOptions["onPhase"];
  readonly #maxTrackedRequests: number;
  readonly #dedupeStorage: Pick<
    Storage,
    "getItem" | "setItem" | "removeItem"
  > | null;
  readonly #tracked = new Map<string, TrackedCommand>();
  readonly #active = new Map<string, ActiveCommand>();
  #cancellationGeneration = 0;

  constructor(options: StorefrontFlueComputerCoordinatorOptions) {
    this.#runtime = options.runtime;
    this.#postResult =
      options.postResult ??
      ((payload, postOptions) =>
        postStorefrontFlueComputerResult(payload, fetch, postOptions));
    this.#postCancellation =
      options.postCancellation ??
      ((payload, postOptions) =>
        postStorefrontFlueComputerCancellation(payload, fetch, postOptions));
    this.#now = options.now ?? Date.now;
    this.#onPhase = options.onPhase;
    this.#maxTrackedRequests = Math.min(
      Math.max(options.maxTrackedRequests ?? 128, 8),
      256,
    );
    this.#dedupeStorage =
      options.dedupeStorage === undefined
        ? resolveSessionStorage()
        : options.dedupeStorage;
  }

  /** Stop browser work synchronously before the durable agent abort awaits. */
  cancelPending(): void {
    this.#cancellationGeneration += 1;
    this.#runtime.cancelPending();
    for (const active of this.#active.values()) {
      active.abortController.abort(
        new DOMException("Storefront computer command stopped", "AbortError"),
      );
      this.#setPhase(active.command, active.fingerprint, "cancelled");
      // The D1 handoff is first-winner authority. Delivery is intentionally
      // one-shot: an ambiguous cancellation must never be retried.
      void this.#postCancellation({
        surface: "storefront",
        threadId: this.#runtime.binding.threadId,
        requestId: active.command.requestId,
        ticket: active.command.ticket,
        program: active.command.program,
      }).catch(() => undefined);
    }
  }

  async consume(
    source: StorefrontFlueComputerPartSource,
  ): Promise<StorefrontFlueComputerConsumeResult> {
    if (!isOutputAvailableComputerPart(source.part))
      return { status: "ignored" };
    if (
      source.threadId !== this.#runtime.binding.threadId ||
      source.tabId !== this.#runtime.binding.tabId ||
      !THREAD_ID_PATTERN.test(source.threadId) ||
      !TAB_ID_PATTERN.test(source.tabId) ||
      this.#runtime.binding.surface !== "storefront"
    ) {
      return { status: "rejected", reason: "binding_mismatch" };
    }

    const now = this.#now();
    this.#purgeExpired(now);
    const parsed = parseStorefrontFlueComputerClientCommand(
      source.part.output,
      now,
    );
    if (!parsed.ok) return { status: "rejected", reason: parsed.reason };
    const command = parsed.command;
    if (!isMatchingComputerInput(source.part.input, command.program)) {
      return { status: "rejected", reason: "invalid_client_command" };
    }
    const authorizedNavigationRoutes = getAuthorizedStorefrontNavigationRoutes(
      command.program,
      source.navigationAuthority,
    );

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
    const persisted = this.#findPersisted(
      source.threadId,
      source.tabId,
      command.requestId,
      now,
    );
    if (persisted) {
      return {
        status: "duplicate",
        requestId: command.requestId,
        phase: persisted.phase,
      };
    }
    if (!this.#dedupeStorage) {
      return { status: "rejected", reason: "dedupe_unavailable" };
    }
    if (
      this.#tracked.size >= this.#maxTrackedRequests ||
      !this.#canPersistAnotherMarker(now)
    ) {
      return { status: "rejected", reason: "dedupe_capacity" };
    }

    // Persist the claim before page work. If storage is unavailable, fail
    // closed so refresh/replay cannot repeat a click or navigation.
    if (!this.#setPhase(command, fingerprint, "executing")) {
      return { status: "rejected", reason: "dedupe_unavailable" };
    }

    const active: ActiveCommand = {
      abortController: new AbortController(),
      command,
      fingerprint,
      generation: this.#cancellationGeneration,
    };
    this.#active.set(command.requestId, active);

    try {
      let result: ScaliusComputerResult;
      try {
        result = await this.#runtime.execute({
          binding: this.#runtime.binding,
          program: command.program,
          authorizedNavigationRoutes,
        });
      } catch {
        result = {
          ok: false,
          code: "EXECUTION_FAILED",
          output:
            "The Storefront page could not complete that command. Observe and try again.",
          retryable: true,
        };
      }

      if (this.#isCancelled(active)) {
        this.#setPhase(command, fingerprint, "cancelled");
        return { status: "cancelled", requestId: command.requestId };
      }

      this.#setPhase(command, fingerprint, "posting_untrusted_result");
      try {
        const admission = await this.#postResult(
          {
            surface: "storefront",
            threadId: source.threadId,
            requestId: command.requestId,
            ticket: command.ticket,
            program: command.program,
            result,
          },
          { signal: active.abortController.signal },
        );
        if (this.#isCancelled(active)) {
          this.#setPhase(command, fingerprint, "cancelled");
          return { status: "cancelled", requestId: command.requestId };
        }
        if (admission.requestId !== command.requestId) {
          throw new Error("Result admission mismatch");
        }
        this.#setPhase(command, fingerprint, "continuation_accepted");
        return {
          status: "continuation_accepted",
          requestId: command.requestId,
          result,
          authoritative: false,
        };
      } catch {
        if (this.#isCancelled(active)) {
          this.#setPhase(command, fingerprint, "cancelled");
          return { status: "cancelled", requestId: command.requestId };
        }
        // Delivery is uncertain. Never execute or post this requestId again;
        // the Agent must issue a new signed command after expiry or failure.
        this.#setPhase(command, fingerprint, "continuation_failed");
        return {
          status: "continuation_failed",
          requestId: command.requestId,
          result,
        };
      }
    } finally {
      if (this.#active.get(command.requestId) === active) {
        this.#active.delete(command.requestId);
      }
    }
  }

  #isCancelled(active: ActiveCommand): boolean {
    return (
      active.abortController.signal.aborted ||
      active.generation !== this.#cancellationGeneration
    );
  }

  #setPhase(
    command: ScaliusComputerClientCommand<"storefront">,
    fingerprint: string,
    phase: StorefrontFlueComputerPhase,
  ): boolean {
    this.#tracked.set(command.requestId, {
      expiresAt: Date.parse(command.expiresAt),
      fingerprint,
      phase,
    });
    const persisted = this.#persistMarker({
      threadId: this.#runtime.binding.threadId,
      tabId: this.#runtime.binding.tabId,
      requestId: command.requestId,
      expiresAt: Date.parse(command.expiresAt),
      phase,
    });
    this.#onPhase?.(command.requestId, phase);
    return persisted;
  }

  #purgeExpired(now: number): void {
    for (const [requestId, tracked] of this.#tracked) {
      if (tracked.expiresAt <= now) this.#tracked.delete(requestId);
    }
    this.#readPersisted(now);
  }

  #findPersisted(
    threadId: string,
    tabId: string,
    requestId: string,
    now: number,
  ): PersistedCommandMarker | undefined {
    return this.#readPersisted(now).find(
      (entry) =>
        entry.threadId === threadId &&
        entry.tabId === tabId &&
        entry.requestId === requestId,
    );
  }

  #canPersistAnotherMarker(now: number): boolean {
    return this.#readPersisted(now).length < this.#maxTrackedRequests;
  }

  #persistMarker(marker: PersistedCommandMarker): boolean {
    if (!this.#dedupeStorage) return false;
    const entries = this.#readPersisted(this.#now());
    const index = entries.findIndex(
      (entry) =>
        entry.threadId === marker.threadId &&
        entry.tabId === marker.tabId &&
        entry.requestId === marker.requestId,
    );
    if (index >= 0) entries[index] = marker;
    else entries.push(marker);
    try {
      this.#dedupeStorage.setItem(
        STOREFRONT_FLUE_COMPUTER_DEDUPE_STORAGE_KEY,
        JSON.stringify(entries.slice(-this.#maxTrackedRequests)),
      );
      return true;
    } catch {
      return false;
    }
  }

  #readPersisted(now: number): PersistedCommandMarker[] {
    const storage = this.#dedupeStorage;
    if (!storage) return [];
    let raw: string | null;
    try {
      raw = storage.getItem(STOREFRONT_FLUE_COMPUTER_DEDUPE_STORAGE_KEY);
    } catch {
      return [];
    }
    if (!raw) return [];
    if (raw.length > MAX_DEDUPE_STORAGE_BYTES) {
      removeStorageItem(storage, STOREFRONT_FLUE_COMPUTER_DEDUPE_STORAGE_KEY);
      return [];
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      removeStorageItem(storage, STOREFRONT_FLUE_COMPUTER_DEDUPE_STORAGE_KEY);
      return [];
    }
    if (!Array.isArray(value)) {
      removeStorageItem(storage, STOREFRONT_FLUE_COMPUTER_DEDUPE_STORAGE_KEY);
      return [];
    }
    const entries = value
      .filter(isPersistedCommandMarker)
      .filter((entry) => entry.expiresAt > now);
    if (entries.length !== value.length) {
      try {
        if (entries.length > 0) {
          storage.setItem(
            STOREFRONT_FLUE_COMPUTER_DEDUPE_STORAGE_KEY,
            JSON.stringify(entries),
          );
        } else {
          storage.removeItem(STOREFRONT_FLUE_COMPUTER_DEDUPE_STORAGE_KEY);
        }
      } catch {
        // Initial claim persistence is checked before any page effect.
      }
    }
    return entries.slice(-this.#maxTrackedRequests);
  }
}

export function parseStorefrontFlueComputerClientCommand(
  value: unknown,
  now = Date.now(),
):
  | { ok: true; command: ScaliusComputerClientCommand<"storefront"> }
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
    value.surface !== "storefront" ||
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
  if (
    !Number.isSafeInteger(expiresAt) ||
    new Date(expiresAt).toISOString() !== value.expiresAt
  ) {
    return { ok: false, reason: "invalid_client_command" };
  }
  if (expiresAt <= now || expiresAt > now + MAX_CLIENT_COMMAND_LIFETIME_MS) {
    return { ok: false, reason: "expired_client_command" };
  }
  return {
    ok: true,
    command: {
      type: "client_command",
      capability: "computer",
      protocolVersion: 1,
      status: "awaiting_client_execution",
      authoritative: false,
      replayPolicy: "client_dedupe_request_id_until_expiry",
      surface: "storefront",
      requestId: value.requestId,
      program: value.program,
      expiresAt: value.expiresAt,
      ticket: value.ticket,
    },
  };
}

export async function postStorefrontFlueComputerResult(
  payload: StorefrontFlueComputerResultPayload,
  fetcher: typeof fetch = fetch,
  options: { signal?: AbortSignal } = {},
): Promise<{ accepted: true; requestId: string }> {
  if (
    payload.surface !== "storefront" ||
    !THREAD_ID_PATTERN.test(payload.threadId) ||
    !REQUEST_ID_PATTERN.test(payload.requestId)
  ) {
    throw new Error("Storefront computer result binding is invalid");
  }
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).byteLength > MAX_RESULT_REQUEST_BYTES) {
    throw new Error("Storefront computer result is too large");
  }
  const endpoint = `/api/assistant/conversations/${payload.threadId}/computer/results`;
  const response = await fetcher(endpoint, {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    signal: options.signal,
    headers: { "Content-Type": "application/json" },
    body,
  });
  const responseBody = await readBoundedJsonResponse(
    response,
    MAX_RESULT_RESPONSE_BYTES,
  );
  if (
    response.status !== 202 ||
    !isRecord(responseBody) ||
    !hasOnlyKeys(
      responseBody,
      new Set(["accepted", "authoritative", "status", "requestId"]),
    ) ||
    responseBody.accepted !== true ||
    responseBody.authoritative !== false ||
    responseBody.status !== "queued_for_agent_interpretation" ||
    responseBody.requestId !== payload.requestId
  ) {
    throw new Error("Storefront computer continuation was not accepted");
  }
  return { accepted: true, requestId: payload.requestId };
}

export async function postStorefrontFlueComputerCancellation(
  payload: StorefrontFlueComputerCancellationPayload,
  fetcher: typeof fetch = fetch,
  options: { signal?: AbortSignal } = {},
): Promise<{ accepted: true; requestId: string }> {
  if (
    payload.surface !== "storefront" ||
    !THREAD_ID_PATTERN.test(payload.threadId) ||
    !REQUEST_ID_PATTERN.test(payload.requestId)
  ) {
    throw new Error("Storefront computer cancellation binding is invalid");
  }
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).byteLength > MAX_CANCELLATION_REQUEST_BYTES) {
    throw new Error("Storefront computer cancellation is too large");
  }
  const endpoint = `/api/assistant/conversations/${payload.threadId}/computer/cancel`;
  const response = await fetcher(endpoint, {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    signal: options.signal,
    headers: { "Content-Type": "application/json" },
    body,
  });
  const responseBody = await readBoundedJsonResponse(
    response,
    MAX_RESULT_RESPONSE_BYTES,
  );
  if (
    response.status !== 202 ||
    !isRecord(responseBody) ||
    !hasOnlyKeys(
      responseBody,
      new Set(["accepted", "status", "requestId"]),
    ) ||
    responseBody.accepted !== true ||
    responseBody.status !== "cancelled" ||
    responseBody.requestId !== payload.requestId
  ) {
    throw new Error("Storefront computer cancellation was not accepted");
  }
  return { accepted: true, requestId: payload.requestId };
}

function isOutputAvailableComputerPart(
  value: unknown,
): value is StorefrontFlueDynamicToolPart {
  return (
    isRecord(value) &&
    value.type === "dynamic-tool" &&
    value.toolName === "computer" &&
    value.state === "output-available" &&
    typeof value.toolCallId === "string" &&
    value.toolCallId.length > 0 &&
    value.toolCallId.length <= 160 &&
    "input" in value &&
    "output" in value
  );
}

function isMatchingComputerInput(value: unknown, program: string): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, new Set(["program"])) &&
    value.program === program
  );
}

function isPersistedCommandMarker(
  value: unknown,
): value is PersistedCommandMarker {
  return (
    isRecord(value) &&
    hasOnlyKeys(
      value,
      new Set(["threadId", "tabId", "requestId", "expiresAt", "phase"]),
    ) &&
    typeof value.threadId === "string" &&
    THREAD_ID_PATTERN.test(value.threadId) &&
    typeof value.tabId === "string" &&
    TAB_ID_PATTERN.test(value.tabId) &&
    typeof value.requestId === "string" &&
    REQUEST_ID_PATTERN.test(value.requestId) &&
    Number.isSafeInteger(value.expiresAt) &&
    isStorefrontFlueComputerPhase(value.phase)
  );
}

function isStorefrontFlueComputerPhase(
  value: unknown,
): value is StorefrontFlueComputerPhase {
  return (
    value === "executing" ||
    value === "posting_untrusted_result" ||
    value === "cancelled" ||
    value === "continuation_accepted" ||
    value === "continuation_failed"
  );
}

function resolveSessionStorage(): Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function removeStorageItem(
  storage: Pick<Storage, "removeItem">,
  key: string,
): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage is only a replay-safety marker; no page data is stored here.
  }
}

async function readBoundedJsonResponse(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    /^\d+$/u.test(contentLength) &&
    Number(contentLength) > maxBytes
  ) {
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

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return (
    Object.keys(value).every((key) => allowed.has(key)) &&
    Object.keys(value).length === allowed.size
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
