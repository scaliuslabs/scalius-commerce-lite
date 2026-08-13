import { getDb } from "@scalius/database/client";
import type {
  AgentArtifactOutput,
  AgentOperationManifestEntry,
} from "../openapi/agent-operation-manifest";
import {
  createAgentArtifact,
  deleteAgentArtifactRecords,
  expireAgentArtifactHandles,
  listAgentArtifactCleanupCandidates,
  sha256Hex,
} from "./artifacts";
import type { AgentPrincipal } from "./types";

const ARTIFACT_ID_PATTERN = /^aah_[A-Za-z0-9_-]{20}$/;
const SAFE_FILENAME_PATTERN = /^[\x20-\x7E]{1,160}$/;
const ARTIFACT_CLEANUP_PAGE_SIZE = 100;
const ARTIFACT_CLEANUP_MAX_CANDIDATES = 2_000;

function hasUnsafeFilenameCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return character === "/" || character === "\\" || code < 32 || code === 127;
  });
}

export class AgentArtifactDeliveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AgentArtifactDeliveryError";
  }
}

export interface AgentArtifactResult {
  artifactId: string;
  uri: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  expiresInSeconds: 300;
}

function parseArtifactMediaType(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function parseArtifactFilename(
  header: string | null,
  expectedDisposition: AgentArtifactOutput["disposition"],
): string {
  if (!header) {
    throw new AgentArtifactDeliveryError(
      "invalid_artifact_response",
      "Artifact response is missing Content-Disposition",
      502,
    );
  }
  const [rawDisposition, ...parameters] = header.split(";");
  if (rawDisposition?.trim().toLowerCase() !== expectedDisposition) {
    throw new AgentArtifactDeliveryError(
      "invalid_artifact_response",
      "Artifact response disposition does not match its contract",
      502,
    );
  }
  const filenameParameter = parameters.find((parameter) =>
    /^\s*filename\s*=/i.test(parameter)
  );
  let filename = filenameParameter?.replace(/^\s*filename\s*=\s*/i, "").trim() ?? "";
  if (filename.startsWith('"') && filename.endsWith('"')) {
    filename = filename.slice(1, -1);
  }
  if (
    !SAFE_FILENAME_PATTERN.test(filename) ||
    hasUnsafeFilenameCharacter(filename) ||
    filename.includes('"')
  ) {
    throw new AgentArtifactDeliveryError(
      "invalid_artifact_response",
      "Artifact response filename is invalid",
      502,
    );
  }
  return filename;
}

export async function stageAgentArtifact(
  operation: AgentOperationManifestEntry,
  response: Response,
  principal: AgentPrincipal,
  env: Env,
): Promise<AgentArtifactResult> {
  const policy = operation.artifactOutput;
  if (
    !policy ||
    policy.delivery !== "authenticated-handle" ||
    operation.exposure !== "execute" ||
    operation.batch !== "forbidden" ||
    operation.sensitiveOutput ||
    operation.oneTimeSecretOutput
  ) {
    throw new AgentArtifactDeliveryError(
      "invalid_artifact_policy",
      "Operation artifact policy is invalid",
      500,
    );
  }
  const mediaType = parseArtifactMediaType(response.headers.get("Content-Type"));
  if (!policy.mediaTypes.includes(mediaType)) {
    throw new AgentArtifactDeliveryError(
      "invalid_artifact_response",
      "Artifact response media type does not match its contract",
      502,
    );
  }
  const filename = parseArtifactFilename(
    response.headers.get("Content-Disposition"),
    policy.disposition,
  );
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null) {
    const value = Number(declaredLength);
    if (!Number.isSafeInteger(value) || value < 1 || value > policy.maxArtifactBytes) {
      throw new AgentArtifactDeliveryError(
        "invalid_artifact_response",
        "Artifact response length is invalid",
        502,
      );
    }
  }
  const r2Key = `agent-artifacts/${principal.grantId}/${crypto.randomUUID()}`;
  if (!response.body) {
    throw new AgentArtifactDeliveryError(
      "invalid_artifact_response",
      "Artifact response is empty",
      502,
    );
  }
  let total = 0;
  const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > policy.maxArtifactBytes) {
        controller.error(new AgentArtifactDeliveryError(
          "artifact_too_large",
          "Artifact exceeds its declared size limit",
          502,
        ));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  const [r2Body, digestBody] = bounded.tee();
  let bytes: ArrayBuffer;
  try {
    const [, buffered] = await Promise.all([
      env.AGENT_ARTIFACTS.put(r2Key, r2Body, {
        httpMetadata: {
          contentType: mediaType,
          contentDisposition: `attachment; filename="${filename}"`,
        },
      }),
      new Response(digestBody).arrayBuffer(),
    ]);
    bytes = buffered;
  } catch (error) {
    try {
      await env.AGENT_ARTIFACTS.delete(r2Key);
    } catch {
      // Best-effort cleanup of a failed or partial write.
    }
    if (error instanceof AgentArtifactDeliveryError) throw error;
    throw new AgentArtifactDeliveryError(
      "artifact_storage_failed",
      "Artifact storage is temporarily unavailable",
      502,
    );
  }
  if (bytes.byteLength < 1 || bytes.byteLength !== total) {
    try {
      await env.AGENT_ARTIFACTS.delete(r2Key);
    } catch {
      // Best-effort cleanup of an invalid generated artifact.
    }
    throw new AgentArtifactDeliveryError(
      "invalid_artifact_response",
      "Artifact response length is invalid",
      502,
    );
  }
  if (declaredLength !== null && bytes.byteLength !== Number(declaredLength)) {
    try {
      await env.AGENT_ARTIFACTS.delete(r2Key);
    } catch {
      // Best-effort cleanup of a truncated or overlong generated artifact.
    }
    throw new AgentArtifactDeliveryError(
      "invalid_artifact_response",
      "Artifact response length does not match Content-Length",
      502,
    );
  }
  const sha256 = await sha256Hex(bytes);
  try {
    const handle = await createAgentArtifact(getDb(env), {
      grantId: principal.grantId,
      credentialId: principal.credentialId,
      resource: principal.resource,
      operationId: operation.operationId,
      mediaType,
      filename,
      sizeBytes: bytes.byteLength,
      sha256,
      r2Key,
    }, env);
    if (!ARTIFACT_ID_PATTERN.test(handle.artifactId)) {
      throw new Error("Artifact service returned an invalid handle");
    }
    return {
      artifactId: handle.artifactId,
      uri: `${new URL(handle.downloadUrl).origin}/api/v1/mcp/${principal.resource}/artifacts/${handle.artifactId}`,
      filename,
      mediaType,
      sizeBytes: bytes.byteLength,
      sha256,
      expiresInSeconds: 300,
    };
  } catch (error) {
    try {
      await env.AGENT_ARTIFACTS.delete(r2Key);
    } catch {
      // An unreferenced object contains only generated artifact bytes and is
      // unreachable. Bucket lifecycle cleanup remains a secondary safety net.
    }
    if (error instanceof AgentArtifactDeliveryError) throw error;
    throw new AgentArtifactDeliveryError(
      "artifact_handle_failed",
      "Artifact handle creation is temporarily unavailable",
      502,
    );
  }
}

export async function purgeExpiredAgentArtifacts(env: Env): Promise<void> {
  const db = getDb(env);
  await expireAgentArtifactHandles(db);
  let attempted = 0;
  let cursor: { expiresAt: Date; id: string } | undefined;
  while (attempted < ARTIFACT_CLEANUP_MAX_CANDIDATES) {
    const page = await listAgentArtifactCleanupCandidates(
      db,
      {
        limit: Math.min(
          ARTIFACT_CLEANUP_PAGE_SIZE,
          ARTIFACT_CLEANUP_MAX_CANDIDATES - attempted,
        ),
        ...(cursor ? { after: cursor } : {}),
      },
    );
    if (page.length === 0) break;
    const objectDeletedIds: string[] = [];
    for (const candidate of page) {
      attempted += 1;
      cursor = { expiresAt: candidate.expiresAt, id: candidate.id };
      // Relational authority is removed only after the object is gone. A
      // failed R2 delete leaves the row for the next scheduled retry.
      try {
        await env.AGENT_ARTIFACTS.delete(candidate.r2Key);
        objectDeletedIds.push(candidate.id);
      } catch {
        // Retain this authoritative row for the next bounded cleanup pass
        // while continuing so one unavailable object cannot starve later rows.
      }
    }
    for (let offset = 0; offset < objectDeletedIds.length; offset += 90) {
      await deleteAgentArtifactRecords(db, objectDeletedIds.slice(offset, offset + 90));
    }
    if (page.length < ARTIFACT_CLEANUP_PAGE_SIZE) break;
  }
}
