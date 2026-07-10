import {
  getScaliusComputerHumanConfirmationId,
  isScaliusComputerHumanConfirmationId,
  parseScaliusComputerProgram,
  SCALIUS_COMPUTER_LIMITS,
  type ScaliusComputerResult,
} from "@scalius/shared/assistant-computer";
import type { ScaliusComputerClientCommand } from "@scalius/shared/assistant-computer-handoff";

import type { AdminAssistantComputerRuntime } from "./runtime";
import {
  getAuthorizedAdminNavigationRoutes,
  isDirectAdminNavigationAuthorized,
} from "./navigation-authorization";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,1600}\.[A-Za-z0-9_-]{43}$/u;
const MAX_CLIENT_COMMAND_LIFETIME_MS = 125_000;
const MAX_RESULT_REQUEST_BYTES = SCALIUS_COMPUTER_LIMITS.resultEnvelopeBytes;
const MAX_RESULT_RESPONSE_BYTES = 4_096;
const CANCEL_TIMEOUT_MS = 5_000;
const RESULT_ENDPOINT = "/api/assistant/flue/computer/results";
const CANCEL_ENDPOINT = "/api/assistant/flue/computer/cancel";
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
  | "navigation_rejected"
  | "executing"
  | "awaiting_human_confirmation"
  | "posting_untrusted_result"
  | "continuation_accepted"
  | "continuation_failed"
  | "continuation_cancelled";

export type AdminFlueComputerConsumeResult =
  | { status: "ignored" }
  | {
      status: "rejected";
      reason:
        | "binding_mismatch"
        | "invalid_client_command"
        | "expired_client_command"
        | "navigation_not_authorized"
        | "request_id_collision"
        | "dedupe_capacity";
    }
  | { status: "duplicate"; requestId: string; phase: AdminFlueComputerPhase }
  | {
      status: "awaiting_human_confirmation";
      requestId: string;
      actionId: string;
    }
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
  /** Latest preceding user-authored turn from the trusted Flue projection. */
  latestUserMessage?: string;
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

export type AdminFlueComputerCancelPayload = Omit<
  AdminFlueComputerResultPayload,
  "result"
>;

export interface AdminFlueComputerCancellationSummary {
  cancelled: number;
  durable: number;
  failed: number;
}

export type AdminFlueHumanConfirmationOutcome =
  | "succeeded"
  | "failed"
  | "cancelled";

export type AdminFlueHumanConfirmationResult =
  | {
      status: "ignored";
      reason:
        | "no_pending_confirmation"
        | "expired_confirmation"
        | "operation_mismatch";
    }
  | {
      status: "continuation_failed";
      requestId: string;
      result: ScaliusComputerResult;
    }
  | {
      status: "continuation_accepted";
      requestId: string;
      result: ScaliusComputerResult;
      authoritative: false;
    };

export interface AdminFlueComputerCoordinatorOptions {
  runtime: AdminAssistantComputerRuntime;
  postResult?: (
    payload: AdminFlueComputerResultPayload,
  ) => Promise<{ accepted: true; requestId: string }>;
  cancelHandoff?: (
    payload: AdminFlueComputerCancelPayload,
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
  /** Opaque one-use signature fragment. */
  commandKey?: string;
  humanConfirmationId?: string;
}

interface PendingHumanConfirmation {
  actionId: string;
  command: ScaliusComputerClientCommand<"admin">;
  fingerprint: string;
  threadId: string;
  operationId?: string;
}

/**
 * Executes one Flue browser command at most once for the lifetime of this
 * bound Admin tab coordinator. Flue stream replays are expected and are
 * deduplicated by the signed command requestId until its expiry.
 */
export class AdminFlueComputerCoordinator {
  readonly #runtime: AdminAssistantComputerRuntime;
  readonly #postResult: NonNullable<AdminFlueComputerCoordinatorOptions["postResult"]>;
  readonly #cancelHandoff: NonNullable<
    AdminFlueComputerCoordinatorOptions["cancelHandoff"]
  >;
  readonly #now: () => number;
  readonly #onPhase?: AdminFlueComputerCoordinatorOptions["onPhase"];
  readonly #maxTrackedRequests: number;
  readonly #dedupeStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  readonly #tracked = new Map<string, TrackedCommand>();
  readonly #pendingHumanConfirmations = new Map<
    string,
    PendingHumanConfirmation
  >();
  readonly #activeHumanOperations = new Map<string, string>();

  constructor(options: AdminFlueComputerCoordinatorOptions) {
    this.#runtime = options.runtime;
    this.#postResult = options.postResult ?? postAdminFlueComputerResult;
    this.#cancelHandoff =
      options.cancelHandoff ?? cancelAdminFlueComputerHandoff;
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
    const authorizedNavigationRoutes = getAuthorizedAdminNavigationRoutes(
      source.latestUserMessage,
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
    const persisted = this.#findPersisted(source.threadId, command.requestId, now);
    if (persisted) {
      if (
        persisted.phase === "awaiting_human_confirmation" &&
        persisted.expiresAt === Date.parse(command.expiresAt) &&
        persisted.commandKey === commandRecoveryKey(command) &&
        persisted.humanConfirmationId
      ) {
        return this.#deliverResult({
          command,
          fingerprint,
          threadId: source.threadId,
          result: reloadedHumanConfirmationResult(
            persisted.humanConfirmationId,
          ),
        });
      }
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
    if (
      !isDirectAdminNavigationAuthorized(
        source.latestUserMessage,
        command.program,
      )
    ) {
      // Claim a rejected signed request too. A later user turn or page reload
      // must never turn an old ambiguous navigation into newly granted consent.
      this.#setPhase(command, fingerprint, "navigation_rejected");
      return { status: "rejected", reason: "navigation_not_authorized" };
    }

    // Claim before awaiting page work. Concurrent stream renders cannot run it twice.
    this.#setPhase(command, fingerprint, "executing");
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
        output: "The Admin page could not complete that command. Observe and try again.",
        retryable: true,
      };
    }

    const humanConfirmationId =
      getScaliusComputerHumanConfirmationId(result);
    if (humanConfirmationId) {
      if (
        this.#pendingHumanConfirmations.has(humanConfirmationId) ||
        this.#activeHumanOperations.has(humanConfirmationId)
      ) {
        result = {
          ok: false,
          code: "BUSY",
          output:
            "That visible action already has a pending human confirmation.",
          retryable: true,
        };
      } else {
        this.#pendingHumanConfirmations.set(humanConfirmationId, {
          actionId: humanConfirmationId,
          command,
          fingerprint,
          threadId: source.threadId,
        });
        this.#setPhase(
          command,
          fingerprint,
          "awaiting_human_confirmation",
          humanConfirmationId,
        );
        return {
          status: "awaiting_human_confirmation",
          requestId: command.requestId,
          actionId: humanConfirmationId,
        };
      }
    }

    return this.#deliverResult({
      command,
      fingerprint,
      threadId: source.threadId,
      result,
    });
  }

  pendingHumanConfirmationCount(): number {
    this.#purgeExpired(this.#now());
    return this.#pendingHumanConfirmations.size;
  }

  nextPendingHumanConfirmationExpiry(): number | null {
    this.#purgeExpired(this.#now());
    let next: number | null = null;
    for (const pending of this.#pendingHumanConfirmations.values()) {
      const expiresAt = Date.parse(pending.command.expiresAt);
      if (next === null || expiresAt < next) next = expiresAt;
    }
    return next;
  }

  registerHumanActionStart(input: {
    actionId: string;
    operationId: string;
  }): boolean {
    if (
      !isScaliusComputerHumanConfirmationId(input.actionId) ||
      !/^aho_[a-f0-9]{24}$/u.test(input.operationId)
    ) return false;
    this.#purgeExpired(this.#now());
    const active = this.#activeHumanOperations.get(input.actionId);
    if (active && active !== input.operationId) return false;
    this.#activeHumanOperations.set(input.actionId, input.operationId);
    const pending = this.#pendingHumanConfirmations.get(input.actionId);
    if (!pending || pending.operationId) return false;
    pending.operationId = input.operationId;
    return true;
  }

  async confirmHumanAction(input: {
    actionId: string;
    operationId: string;
    outcome: AdminFlueHumanConfirmationOutcome;
  }): Promise<AdminFlueHumanConfirmationResult> {
    const now = this.#now();
    const pending = this.#pendingHumanConfirmations.get(input.actionId);
    if (this.#activeHumanOperations.get(input.actionId) === input.operationId) {
      this.#activeHumanOperations.delete(input.actionId);
    }
    if (!pending) {
      this.#purgeExpired(now);
      return { status: "ignored", reason: "no_pending_confirmation" };
    }
    if (pending.operationId !== input.operationId) {
      return { status: "ignored", reason: "operation_mismatch" };
    }
    const expiresAt = Date.parse(pending.command.expiresAt);
    this.#pendingHumanConfirmations.delete(input.actionId);
    if (expiresAt <= now) {
      this.#purgeExpired(now);
      return { status: "ignored", reason: "expired_confirmation" };
    }
    const result = humanConfirmationResult(
      pending.actionId,
      input.outcome,
    );
    return this.#deliverResult({
      command: pending.command,
      fingerprint: pending.fingerprint,
      threadId: pending.threadId,
      result,
    });
  }

  async cancelHumanAction(
    actionId: string,
  ): Promise<AdminFlueHumanConfirmationResult> {
    if (!isScaliusComputerHumanConfirmationId(actionId)) {
      return { status: "ignored", reason: "no_pending_confirmation" };
    }
    const now = this.#now();
    const pending = this.#pendingHumanConfirmations.get(actionId);
    if (!pending) {
      this.#purgeExpired(now);
      return { status: "ignored", reason: "no_pending_confirmation" };
    }
    this.#pendingHumanConfirmations.delete(actionId);
    this.#activeHumanOperations.delete(actionId);
    if (Date.parse(pending.command.expiresAt) <= now) {
      this.#purgeExpired(now);
      return { status: "ignored", reason: "expired_confirmation" };
    }
    return this.#deliverResult({
      command: pending.command,
      fingerprint: pending.fingerprint,
      threadId: pending.threadId,
      result: humanConfirmationResult(pending.actionId, "cancelled"),
    });
  }

  async cancelPendingHumanConfirmations(): Promise<
    AdminFlueComputerCancellationSummary
  > {
    const pendingConfirmations = [...this.#pendingHumanConfirmations.values()];
    for (const pending of pendingConfirmations) {
      this.#setPhase(
        pending.command,
        pending.fingerprint,
        "continuation_cancelled",
      );
      this.#activeHumanOperations.delete(pending.actionId);
    }
    this.#pendingHumanConfirmations.clear();
    let durable = 0;
    let failed = 0;
    for (const pending of pendingConfirmations) {
      try {
        const admission = await this.#cancelHandoff({
          surface: "admin",
          threadId: pending.threadId,
          requestId: pending.command.requestId,
          ticket: pending.command.ticket,
          program: pending.command.program,
        });
        if (admission.requestId !== pending.command.requestId) {
          throw new Error("Cancellation admission mismatch");
        }
        durable += 1;
      } catch {
        failed += 1;
      }
    }
    return {
      cancelled: pendingConfirmations.length,
      durable,
      failed,
    };
  }

  expirePendingHumanConfirmations(now = this.#now()): number {
    let expired = 0;
    for (const [actionId, pending] of this.#pendingHumanConfirmations) {
      if (Date.parse(pending.command.expiresAt) > now) continue;
      this.#pendingHumanConfirmations.delete(actionId);
      if (
        !pending.operationId ||
        this.#activeHumanOperations.get(actionId) === pending.operationId
      ) {
        this.#activeHumanOperations.delete(actionId);
      }
      expired += 1;
    }
    return expired;
  }

  async #deliverResult(input: {
    command: ScaliusComputerClientCommand<"admin">;
    fingerprint: string;
    threadId: string;
    result: ScaliusComputerResult;
  }): Promise<
    Extract<
      AdminFlueComputerConsumeResult,
      { status: "continuation_accepted" | "continuation_failed" }
    >
  > {
    const { command, fingerprint, threadId, result } = input;
    this.#setPhase(command, fingerprint, "posting_untrusted_result");
    try {
      const admission = await this.#postResult({
        surface: "admin",
        threadId,
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
    humanConfirmationId?: string,
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
      ...(phase === "awaiting_human_confirmation" && humanConfirmationId
        ? {
            commandKey: commandRecoveryKey(command),
            humanConfirmationId,
          }
        : {}),
    });
    this.#onPhase?.(command.requestId, phase);
  }

  #purgeExpired(now: number): void {
    this.expirePendingHumanConfirmations(now);
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

export async function cancelAdminFlueComputerHandoff(
  payload: AdminFlueComputerCancelPayload,
  fetcher: typeof fetch = fetch,
): Promise<{ accepted: true; requestId: string }> {
  if (
    payload.surface !== "admin" ||
    !THREAD_ID_PATTERN.test(payload.threadId) ||
    !REQUEST_ID_PATTERN.test(payload.requestId) ||
    !TICKET_PATTERN.test(payload.ticket) ||
    !parseScaliusComputerProgram(payload.program).ok
  ) {
    throw new Error("Admin computer cancellation binding is invalid");
  }
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).byteLength > MAX_RESULT_REQUEST_BYTES) {
    throw new Error("Admin computer cancellation is too large");
  }
  const response = await fetcher(CANCEL_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
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
    responseBody.accepted !== true ||
    responseBody.status !== "cancelled" ||
    responseBody.requestId !== payload.requestId
  ) {
    throw new Error("Admin computer cancellation was not accepted");
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
  if (!isRecord(value)) return false;
  const baseKeys = ["threadId", "requestId", "expiresAt", "phase"];
  const awaitingKeys = [...baseKeys, "commandKey", "humanConfirmationId"];
  const awaiting = value.phase === "awaiting_human_confirmation";
  const allowedKeys = new Set(awaiting ? awaitingKeys : baseKeys);
  return hasOnlyKeys(value, allowedKeys) &&
    typeof value.threadId === "string" && THREAD_ID_PATTERN.test(value.threadId) &&
    typeof value.requestId === "string" && REQUEST_ID_PATTERN.test(value.requestId) &&
    Number.isSafeInteger(value.expiresAt) &&
    isAdminFlueComputerPhase(value.phase) &&
    (!awaiting ||
      (typeof value.commandKey === "string" &&
        /^[A-Za-z0-9_-]{43}$/u.test(value.commandKey) &&
        isScaliusComputerHumanConfirmationId(value.humanConfirmationId)));
}

function isAdminFlueComputerPhase(value: unknown): value is AdminFlueComputerPhase {
  return value === "navigation_rejected" ||
    value === "executing" ||
    value === "awaiting_human_confirmation" ||
    value === "posting_untrusted_result" ||
    value === "continuation_accepted" ||
    value === "continuation_failed" ||
    value === "continuation_cancelled";
}

function humanConfirmationResult(
  actionId: string,
  outcome: AdminFlueHumanConfirmationOutcome,
): ScaliusComputerResult {
  if (outcome === "succeeded") {
    return {
      ok: true,
      code: "EXECUTED",
      output:
        `The person completed the visible application action ${actionId}. ` +
        "This browser acknowledgement is untrusted; verify authoritative page or API state before claiming success.",
      changed: true,
    };
  }
  if (outcome === "cancelled") {
    return {
      ok: false,
      code: "HUMAN_REQUIRED",
      output: `The visible application action ${actionId} was cancelled before confirmation.`,
      retryable: false,
    };
  }
  return {
    ok: false,
    code: "EXECUTION_FAILED",
    output:
      `The visible application action ${actionId} failed. ` +
      "No browser success was claimed; inspect the current page before retrying.",
    retryable: true,
  };
}

function reloadedHumanConfirmationResult(
  actionId: string,
): ScaliusComputerResult {
  return {
    ok: false,
    code: "HUMAN_REQUIRED",
    output:
      `The pending visible application action ${actionId} was cancelled after the page reloaded. ` +
      "Prepare the action again from fresh page state.",
    retryable: true,
  };
}

function commandRecoveryKey(
  command: ScaliusComputerClientCommand<"admin">,
): string {
  return command.ticket.slice(-43);
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
