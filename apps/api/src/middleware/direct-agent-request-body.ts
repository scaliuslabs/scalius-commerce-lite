import type { Context } from "hono";
import type { AgentOperationManifestEntry } from "../openapi/agent-operation-manifest";
import {
  AgentPayloadTooLargeError,
  AgentRequestLengthMismatchError,
  bufferBoundedAgentRequest,
} from "../agent-access/limits";
import { ApiError } from "../utils/api-error";

/**
 * Enforces the reviewed manifest byte ceiling before route validation parses
 * a direct PAT/CLI request. The bounded replacement is the only downstream
 * body source, so JSON validators and raw octet-stream routes do not read the
 * original stream twice.
 */
export async function enforceDirectAgentRequestBodyLimit(
  c: Context,
  operation: AgentOperationManifestEntry,
): Promise<void> {
  if (c.req.raw.body === null) return;
  try {
    const bounded = await bufferBoundedAgentRequest(
      c.req.raw,
      operation.maxRequestBytes,
    );
    c.req.raw = bounded;
    c.req.bodyCache = {};
  } catch (error) {
    if (error instanceof AgentPayloadTooLargeError) {
      throw new ApiError(
        413,
        "PAYLOAD_TOO_LARGE",
        `Agent request body exceeds the ${operation.maxRequestBytes} byte operation limit`,
      );
    }
    if (error instanceof AgentRequestLengthMismatchError) {
      throw new ApiError(
        400,
        "INVALID_REQUEST_BODY",
        "Agent request body does not match the declared Content-Length",
      );
    }
    throw error;
  }
}
