import { dispatch, type DispatchReceipt } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import {
  admitScaliusComputerCancellation,
  admitScaliusComputerResult,
  type ScaliusComputerResultContinuation,
  type VerifiedScaliusComputerHandoff,
} from "@scalius/shared/assistant-computer-handoff";
import { Hono } from "hono";
import adminCopilot from "./agents/admin-copilot";
import type { AdminScaliusEnv } from "./scalius";
import {
  authorizeAgentRequest,
  authorizeThreadInstanceRequest,
  type CanaryAuthEnv,
} from "./auth";

const SERVICE_NAME = "scalius-admin-agent-flue-canary";
const AGENT_NAME = "admin-copilot";
const HANDOFF_CONSUME_URL =
  "http://api.internal/api/v1/internal/admin-assistant/flue/computer-handoff/consume";
const HANDOFF_CONFIRM_URL =
  "http://api.internal/api/v1/internal/admin-assistant/flue/computer-handoff/confirm";
const HANDOFF_BEGIN_URL =
  "http://api.internal/api/v1/internal/admin-assistant/flue/computer-handoff/begin";
const HANDOFF_FAIL_URL =
  "http://api.internal/api/v1/internal/admin-assistant/flue/computer-handoff/fail";
const HANDOFF_UNCERTAIN_URL =
  "http://api.internal/api/v1/internal/admin-assistant/flue/computer-handoff/uncertain";
const ADMISSION_BEGIN_URL =
  "http://api.internal/api/v1/internal/admin-assistant/flue/admission/begin";
const ADMISSION_FINISH_URL =
  "http://api.internal/api/v1/internal/admin-assistant/flue/admission/finish";
const MAX_AUTHORITY_RESPONSE_BYTES = 4_096;
const AUTHORITY_TIMEOUT_MS = 5_000;
const CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const ADMISSION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

interface AgentAdmissionLease {
  admissionId: string;
  admissionClaimToken: string;
  generation: number;
}

type HandoffTerminalState = "cancelled" | "dispatched";

interface ConsumeComputerHandoffInput {
  handoff: VerifiedScaliusComputerHandoff;
  state: HandoffTerminalState;
}

type ConsumeComputerHandoffOutcome =
  | {
    ok: true;
    status: "claimed";
    state: "cancelled";
    requestId: string;
  }
  | {
    ok: true;
    status: "claimed";
    state: "dispatched";
    requestId: string;
    dispatchClaimToken: string;
  }
  | {
    ok: true;
    status: "replayed";
    state: HandoffTerminalState;
    requestId: string;
  }
  | { ok: false; reason: "conflict" | "uncertain" | "unavailable" };

interface ConfirmComputerHandoffInput {
  handoff: VerifiedScaliusComputerHandoff;
  dispatchClaimToken: string;
}

export interface AdminCanaryAppDependencies {
  dispatchComputerResult?: (
    instanceId: string,
    continuation: ScaliusComputerResultContinuation,
    generation: number,
  ) => Promise<DispatchReceipt>;
  consumeComputerHandoff?: (
    input: ConsumeComputerHandoffInput,
  ) => Promise<ConsumeComputerHandoffOutcome>;
  confirmComputerHandoff?: (
    input: ConfirmComputerHandoffInput,
  ) => Promise<boolean>;
  beginComputerHandoff?: (
    input: ConfirmComputerHandoffInput,
  ) => Promise<boolean>;
  failComputerHandoff?: (
    input: ConfirmComputerHandoffInput,
  ) => Promise<boolean>;
  markComputerHandoffUncertain?: (
    input: ConfirmComputerHandoffInput,
  ) => Promise<boolean>;
  beginAgentAdmission?: (
    instanceId: string,
  ) => Promise<AgentAdmissionLease | "blocked" | null>;
  finishAgentAdmission?: (
    instanceId: string,
    lease: AgentAdmissionLease,
  ) => Promise<boolean>;
}

export function createAdminCanaryApp(dependencies: AdminCanaryAppDependencies = {}) {
  const app = new Hono<{ Bindings: CanaryAuthEnv & AdminScaliusEnv }>();
  const dispatchComputerResult = dependencies.dispatchComputerResult ??
    ((instanceId, continuation, generation) =>
      dispatch(adminCopilot, {
        id: instanceId,
        input: continuation,
        generation,
      }));

  app.get("/health", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true, service: SERVICE_NAME, runtime: "flue-cloudflare", version: "0.1.0" });
  });

  app.post("/computer/results/:id", async (c) => {
    c.header("Cache-Control", "no-store");
    const instanceId = c.req.param("id");
    const authorization = await authorizeThreadInstanceRequest(c.req.raw, c.env, "admin", instanceId);
    const signingKey = c.env.COMPUTER_TICKET_SIGNING_KEY;
    if (!authorization.authorized || !signingKey || signingKey.length < 32) {
      return c.json({ error: "Not found" }, 404);
    }
    const admission = await admitScaliusComputerResult({
      request: c.req.raw,
      surface: "admin",
      agentName: AGENT_NAME,
      instanceId,
      signingKey,
    });
    if (!admission.ok) {
      const status = admission.code === "OVERSIZE" ? 413 : 400;
      return c.json({ error: "Computer result was rejected", code: admission.code }, status);
    }
    const deliveryLease = await beginAgentAdmission(
      c.env.API,
      instanceId,
      dependencies.beginAgentAdmission,
    );
    if (deliveryLease === "blocked") {
      return c.json({ error: "Computer result was stopped before admission" }, 409);
    }
    if (!deliveryLease) {
      return c.json({ error: "Computer admission authority is unavailable" }, 503);
    }
    try {
      const consumed = await consumeComputerHandoff(
        c.env.API,
        { handoff: admission.handoff, state: "dispatched" },
        dependencies.consumeComputerHandoff,
      );
      if (!consumed.ok) {
        return consumed.reason === "conflict"
          ? c.json({ error: "Computer result was cancelled" }, 409)
          : c.json({ error: "Computer handoff state is unavailable" }, 503);
      }
      if (consumed.status === "replayed") {
        return c.json({
          accepted: true,
          authoritative: false,
          status: "queued_for_agent_interpretation",
          requestId: admission.continuation.requestId,
        }, 202);
      }
      if (consumed.state !== "dispatched") {
        return c.json({ error: "Computer handoff state is unavailable" }, 503);
      }
      const dispatchClaim = {
        handoff: admission.handoff,
        dispatchClaimToken: consumed.dispatchClaimToken,
      };
      const begun = await transitionComputerHandoff(
        c.env.API,
        dispatchClaim,
        HANDOFF_BEGIN_URL,
        "started",
        dependencies.beginComputerHandoff,
      );
      if (!begun) {
        return c.json({ error: "Computer result was stopped before dispatch" }, 409);
      }
      let dispatchReturned = false;
      let terminalized = false;
      try {
        const receipt = await dispatchComputerResult(
          instanceId,
          admission.continuation,
          deliveryLease.generation,
        );
        dispatchReturned = true;
        const confirmed = await transitionComputerHandoff(
          c.env.API,
          dispatchClaim,
          HANDOFF_CONFIRM_URL,
          "confirmed",
          dependencies.confirmComputerHandoff,
        );
        if (!confirmed) {
          return c.json({ error: "Computer handoff state is unavailable" }, 503);
        }
        terminalized = true;
        return c.json({
          accepted: true,
          authoritative: false,
          status: "queued_for_agent_interpretation",
          requestId: admission.continuation.requestId,
          dispatchId: receipt.dispatchId,
        }, 202);
      } catch {
        return c.json({ error: "Computer result could not be queued" }, 503);
      } finally {
        if (!terminalized) {
          await transitionComputerHandoff(
            c.env.API,
            dispatchClaim,
            dispatchReturned ? HANDOFF_UNCERTAIN_URL : HANDOFF_FAIL_URL,
            dispatchReturned ? "uncertain" : "failed",
            dispatchReturned
              ? dependencies.markComputerHandoffUncertain
              : dependencies.failComputerHandoff,
          );
        }
      }
    } finally {
      await finishAgentAdmission(
        c.env.API,
        instanceId,
        deliveryLease,
        dependencies.finishAgentAdmission,
      );
    }
  });

  app.post("/computer/cancel/:id", async (c) => {
    c.header("Cache-Control", "no-store");
    const instanceId = c.req.param("id");
    const authorization = await authorizeThreadInstanceRequest(
      c.req.raw,
      c.env,
      "admin",
      instanceId,
    );
    const signingKey = c.env.COMPUTER_TICKET_SIGNING_KEY;
    if (!authorization.authorized || !signingKey || signingKey.length < 32) {
      return c.json({ error: "Not found" }, 404);
    }
    const admission = await admitScaliusComputerCancellation({
      request: c.req.raw,
      surface: "admin",
      agentName: AGENT_NAME,
      instanceId,
      signingKey,
    });
    if (!admission.ok) {
      const status = admission.code === "OVERSIZE" ? 413 : 400;
      return c.json({ error: "Computer cancellation was rejected", code: admission.code }, status);
    }
    const consumed = await consumeComputerHandoff(
      c.env.API,
      { handoff: admission.handoff, state: "cancelled" },
      dependencies.consumeComputerHandoff,
    );
    if (!consumed.ok) {
      return consumed.reason === "conflict"
        ? c.json({ error: "Computer result already completed" }, 409)
        : c.json({ error: "Computer handoff state is unavailable" }, 503);
    }
    if (consumed.state !== "cancelled") {
      return c.json({ error: "Computer handoff state is unavailable" }, 503);
    }
    return c.json({
      accepted: true,
      status: "cancelled",
      requestId: admission.handoff.requestId,
    }, 202);
  });

  app.use("/agents/*", async (c, next) => {
    const result = await authorizeAgentRequest(c.req.raw, c.env, AGENT_NAME, "admin");
    if (!result.authorized) {
      c.header("Cache-Control", "no-store");
      return c.json({ error: "Not found" }, 404);
    }
    await next();
  });

  app.route("/", flue());
  return app;
}

export default createAdminCanaryApp();

async function consumeComputerHandoff(
  api: AdminScaliusEnv["API"],
  input: ConsumeComputerHandoffInput,
  override?: AdminCanaryAppDependencies["consumeComputerHandoff"],
): Promise<ConsumeComputerHandoffOutcome> {
  if (override) {
    try {
      return await override(input);
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }
  if (!api) return { ok: false, reason: "unavailable" };
  let response: Response;
  try {
    response = await api.fetch(HANDOFF_CONSUME_URL, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(AUTHORITY_TIMEOUT_MS),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId: input.handoff.instanceId,
        requestId: input.handoff.requestId,
        programDigest: input.handoff.programDigest,
        state: input.state,
        ticketIssuedAt: input.handoff.issuedAt,
        ticketExpiresAt: input.handoff.expiresAt,
      }),
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (response.status === 409) {
    await response.body?.cancel();
    return { ok: false, reason: "conflict" };
  }
  if (response.status === 503) {
    await response.body?.cancel();
    return { ok: false, reason: "uncertain" };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return { ok: false, reason: "unavailable" };
  }
  const value = await readBoundedJson(response, MAX_AUTHORITY_RESPONSE_BYTES);
  return parseConsumeEnvelope(value, input);
}

async function transitionComputerHandoff(
  api: AdminScaliusEnv["API"],
  input: ConfirmComputerHandoffInput,
  url: string,
  expectedStatus: "started" | "confirmed" | "failed" | "uncertain",
  override?: (input: ConfirmComputerHandoffInput) => Promise<boolean>,
): Promise<boolean> {
  if (override) {
    try {
      return await override(input);
    } catch {
      return false;
    }
  }
  if (!api || !CLAIM_TOKEN_PATTERN.test(input.dispatchClaimToken)) return false;
  let response: Response;
  try {
    response = await api.fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(AUTHORITY_TIMEOUT_MS),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId: input.handoff.instanceId,
        requestId: input.handoff.requestId,
        programDigest: input.handoff.programDigest,
        dispatchClaimToken: input.dispatchClaimToken,
      }),
    });
  } catch {
    return false;
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return false;
  }
  const value = await readBoundedJson(response, MAX_AUTHORITY_RESPONSE_BYTES);
  if (!isRecord(value) || !hasOnlyKeys(value, ["success", "data"]) || value.success !== true) {
    return false;
  }
  const data = value.data;
  if (!isRecord(data) || data.requestId !== input.handoff.requestId) return false;
  if (expectedStatus === "started") {
    return hasOnlyKeys(data, ["status", "requestId"]) && data.status === "started";
  }
  return hasOnlyKeys(data, ["status", "state", "requestId"]) &&
    (data.status === expectedStatus || data.status === "replayed") &&
    data.state === "dispatched";
}

async function beginAgentAdmission(
  api: AdminScaliusEnv["API"],
  instanceId: string,
  override?: AdminCanaryAppDependencies["beginAgentAdmission"],
): Promise<AgentAdmissionLease | "blocked" | null> {
  if (override) return override(instanceId);
  const result = await callAdmissionAuthority(api, ADMISSION_BEGIN_URL, { instanceId });
  if (result?.status === 409) return "blocked";
  const data = result?.data;
  if (!isRecord(data) || data.status !== "started" ||
      typeof data.admissionId !== "string" || !ADMISSION_ID_PATTERN.test(data.admissionId) ||
      typeof data.admissionClaimToken !== "string" || !CLAIM_TOKEN_PATTERN.test(data.admissionClaimToken) ||
      typeof data.generation !== "number" || !Number.isSafeInteger(data.generation) || data.generation <= 0) {
    return null;
  }
  return {
    admissionId: data.admissionId,
    admissionClaimToken: data.admissionClaimToken,
    generation: data.generation,
  };
}

async function finishAgentAdmission(
  api: AdminScaliusEnv["API"],
  instanceId: string,
  lease: AgentAdmissionLease,
  override?: AdminCanaryAppDependencies["finishAgentAdmission"],
): Promise<boolean> {
  if (override) return override(instanceId, lease);
  const data = (await callAdmissionAuthority(
    api,
    ADMISSION_FINISH_URL,
    {
      instanceId,
      admissionId: lease.admissionId,
      admissionClaimToken: lease.admissionClaimToken,
    },
  ))?.data;
  return isRecord(data) && (data.status === "finished" || data.status === "replayed");
}

async function callAdmissionAuthority(
  api: AdminScaliusEnv["API"],
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: unknown } | null> {
  if (!api) return null;
  try {
    const response = await api.fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(AUTHORITY_TIMEOUT_MS),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await readBoundedJson(response, MAX_AUTHORITY_RESPONSE_BYTES);
    return {
      status: response.status,
      data: response.ok && isRecord(value) && hasOnlyKeys(value, ["success", "data"]) && value.success === true
        ? value.data
        : null,
    };
  } catch {
    return null;
  }
}

function parseConsumeEnvelope(
  value: unknown,
  input: ConsumeComputerHandoffInput,
): ConsumeComputerHandoffOutcome {
  if (!isRecord(value) || !hasOnlyKeys(value, ["success", "data"]) || value.success !== true) {
    return { ok: false, reason: "unavailable" };
  }
  const data = value.data;
  if (
    !isRecord(data) ||
    data.requestId !== input.handoff.requestId ||
    data.state !== input.state
  ) {
    return { ok: false, reason: "unavailable" };
  }
  if (data.status === "replayed" && hasOnlyKeys(data, ["status", "state", "requestId"])) {
    return {
      ok: true,
      status: "replayed",
      state: input.state,
      requestId: input.handoff.requestId,
    };
  }
  if (data.status !== "claimed") return { ok: false, reason: "unavailable" };
  if (
    input.state === "cancelled" &&
    hasOnlyKeys(data, ["status", "state", "requestId"])
  ) {
    return {
      ok: true,
      status: "claimed",
      state: "cancelled",
      requestId: input.handoff.requestId,
    };
  }
  if (
    input.state === "dispatched" &&
    hasOnlyKeys(data, ["status", "state", "requestId", "dispatchClaimToken"]) &&
    typeof data.dispatchClaimToken === "string" &&
    CLAIM_TOKEN_PATTERN.test(data.dispatchClaimToken)
  ) {
    return {
      ok: true,
      status: "claimed",
      state: "dispatched",
      requestId: input.handoff.requestId,
      dispatchClaimToken: data.dispatchClaimToken,
    };
  }
  return { ok: false, reason: "unavailable" };
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
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
    return JSON.parse(new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const expected = new Set(required);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => expected.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
