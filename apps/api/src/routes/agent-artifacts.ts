import type { Context } from "hono";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  claimAgentArtifact,
  deleteAgentArtifactRecords,
  failClaimedAgentArtifact,
  getAgentArtifactForAuthorization,
  verifyAgentArtifactBytes,
} from "../agent-access/artifacts";
import { loadAgentAccessBackend } from "../agent-access/backend";
import { getAgentDispatchPrincipal } from "../agent-access/dispatch-context";
import { getBearerToken, parseAgentCredential } from "../agent-access/pat";
import { resolveAgentPrincipalFromBearer, resolveAgentPrincipalFromGrant } from "../agent-access/principal";
import type { AgentPrincipal } from "../agent-access/types";
import { enforceAgentRateLimit } from "../middleware/agent-request-boundary";
import { writeAgentAuditEvent } from "../agent-access/audit";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "../utils/api-error";

const app = new OpenAPIHono<{ Bindings: Env }>();
app.use("*", async (c, next) => {
  try {
    await next();
  } finally {
    c.header("Cache-Control", "private, no-store");
    c.header("Pragma", "no-cache");
    c.header("X-Content-Type-Options", "nosniff");
  }
});

async function writeArtifactAudit(
  c: Context<{ Bindings: Env }>,
  principal: AgentPrincipal,
  input: {
    artifactId?: string;
    outcome: "success" | "denied" | "failed";
    httpStatus: number;
    errorClass?: string | null;
    startedAt: number;
  },
): Promise<void> {
  try {
    await writeAgentAuditEvent(c.get("db"), {
      grantId: principal.grantId,
      credentialId: principal.credentialId,
      ownerUserId: principal.ownerUserId,
      resource: principal.resource,
      operationId: "system.agent_artifacts.download",
      risk: "read",
      outcome: input.outcome,
      httpStatus: input.httpStatus,
      errorClass: input.errorClass ?? null,
      durationMs: Date.now() - input.startedAt,
      requestId: c.req.header("X-Request-Id") ?? null,
      ...(input.artifactId ? { resourceIds: [input.artifactId] } : {}),
    });
  } catch {
    // Artifact bytes and credential material never enter audit/log payloads.
  }
}

async function deleteDownloadedArtifact(
  c: Context<{ Bindings: Env }>,
  artifact: { id: string; r2Key: string },
): Promise<void> {
  try {
    await c.env.AGENT_ARTIFACTS.delete(artifact.r2Key);
    await deleteAgentArtifactRecords(c.get("db"), [artifact.id]);
  } catch {
    // The terminal consumed row remains authoritative and scheduled cleanup
    // retries R2-first deletion. Downloaded bytes are already request-local.
  }
}

async function resolveArtifactPrincipal(c: Context<{ Bindings: Env }>): Promise<AgentPrincipal> {
  const internal = getAgentDispatchPrincipal(c.env);
  const bearer = getBearerToken(c.req.header("Authorization"));
  if (internal && (bearer || c.req.header("Cookie")?.trim())) {
    throw new ForbiddenError("Internal artifact dispatch cannot be combined with request credentials");
  }
  if (!internal && c.req.header("Cookie")?.trim()) {
    throw new ForbiddenError("Cookie and agent credentials cannot be combined");
  }
  const principal = internal
    ? await resolveAgentPrincipalFromGrant(c.get("db"), {
        grantId: internal.grantId,
        credentialId: internal.credentialId,
        resource: internal.resource,
      })
    : bearer && parseAgentCredential(bearer)
      ? await resolveAgentPrincipalFromBearer(c.get("db"), bearer, c.env.AGENT_TOKEN_PEPPER)
      : null;
  if (!principal) throw new UnauthorizedError("A live agent credential is required");
  if (internal && (
    principal.ownerUserId !== internal.ownerUserId ||
    principal.authorityRevision !== internal.authorityRevision
  )) {
    throw new UnauthorizedError("Agent artifact authority is no longer active");
  }
  return principal;
}

const downloadRoute = createRoute({
  method: "get",
  path: "/{artifactId}",
  operationId: "system.agent_artifacts.download",
  tags: ["Agent Artifacts"],
  summary: "Download a one-use authenticated agent artifact",
  request: { params: z.object({ artifactId: z.string().regex(/^aah_[A-Za-z0-9_-]{20}$/) }) },
  responses: {
    200: { description: "Authenticated artifact bytes" },
    401: { description: "Agent credential required" },
    403: { description: "Artifact authority denied" },
    404: { description: "Artifact unavailable" },
  },
});

app.openapi(downloadRoute, async (c) => {
  const startedAt = Date.now();
  const principal = await resolveArtifactPrincipal(c);
  try {
    await enforceAgentRateLimit(c, principal);
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    await writeArtifactAudit(c, principal, {
      outcome: "denied",
      httpStatus: typeof status === "number" ? status : 503,
      errorClass: error instanceof Error ? error.name : "RateLimitDenied",
      startedAt,
    });
    throw error;
  }
  const artifactId = c.req.valid("param").artifactId;
  const handle = await getAgentArtifactForAuthorization(c.get("db"), artifactId, principal);
  if (!handle) {
    await writeArtifactAudit(c, principal, {
      artifactId,
      outcome: "denied",
      httpStatus: 404,
      errorClass: "ArtifactUnavailable",
      startedAt,
    });
    throw new NotFoundError("Agent artifact is unavailable, expired, or already consumed");
  }
  const { resolveAgentOperationById } = await import("../agent-access/direct-operation");
  const sourceOperation = resolveAgentOperationById(handle.operationId);
  if (
    !sourceOperation ||
    sourceOperation.artifactOutput?.delivery !== "authenticated-handle" ||
    sourceOperation.surface !== principal.resource ||
    !sourceOperation.artifactOutput.mediaTypes.includes(handle.mediaType) ||
    handle.sizeBytes > sourceOperation.artifactOutput.maxArtifactBytes ||
    !await (await loadAgentAccessBackend()).authorizeOperation(principal, sourceOperation)
  ) {
    await writeArtifactAudit(c, principal, {
      artifactId,
      outcome: "denied",
      httpStatus: 403,
      errorClass: "ArtifactSourceOperationDenied",
      startedAt,
    });
    throw new ForbiddenError("The source operation is no longer authorized for this artifact");
  }
  const artifact = await claimAgentArtifact(c.get("db"), artifactId, principal);
  if (!artifact) {
    await writeArtifactAudit(c, principal, {
      artifactId,
      outcome: "denied",
      httpStatus: 404,
      errorClass: "ArtifactClaimDenied",
      startedAt,
    });
    throw new NotFoundError("Agent artifact is unavailable, expired, or already consumed");
  }

  let outcome: "success" | "failed" = "failed";
  let failureClass: "r2_missing" | "r2_read_failed" | "size_mismatch" | "digest_mismatch" | null = null;
  let bytes: ArrayBuffer;
  try {
    const object = await c.env.AGENT_ARTIFACTS.get(artifact.r2Key);
    if (!object || !("arrayBuffer" in object)) {
      failureClass = "r2_missing";
      throw new Error("Artifact object is unavailable");
    }
    if (object.size !== artifact.sizeBytes) {
      failureClass = "size_mismatch";
      throw new Error("Artifact size verification failed");
    }
    bytes = await object.arrayBuffer();
    const verificationFailure = await verifyAgentArtifactBytes(artifact, bytes);
    if (verificationFailure) {
      failureClass = verificationFailure;
      throw new Error(`Artifact ${verificationFailure === "size_mismatch" ? "size" : "digest"} verification failed`);
    }
    outcome = "success";
  } catch (error) {
    failureClass ??= "r2_read_failed";
    await failClaimedAgentArtifact(c.get("db"), artifact.id, failureClass).catch(() => undefined);
    throw error;
  } finally {
    await writeArtifactAudit(c, principal, {
      artifactId: artifact.id,
      outcome,
      httpStatus: outcome === "success" ? 200 : 500,
      errorClass: failureClass,
      startedAt,
    });
  }

  const safeFilename = artifact.filename.replace(/["\r\n]/g, "_");
  const response = new Response(bytes!, {
    status: 200,
    headers: {
      "Content-Type": artifact.mediaType,
      "Content-Length": String(artifact.sizeBytes),
      "Content-Disposition": `attachment; filename="${safeFilename}"`,
      "Cache-Control": "private, no-store",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
  let executionCtx: { waitUntil(promise: Promise<unknown>): void } | null = null;
  try {
    executionCtx = c.executionCtx;
  } catch {
    // Hono's local request harness has no execution context.
  }
  const cleanup = deleteDownloadedArtifact(c, artifact);
  if (executionCtx) executionCtx.waitUntil(cleanup);
  else await cleanup;
  return response;
});

export const agentArtifactRoutes = app;
