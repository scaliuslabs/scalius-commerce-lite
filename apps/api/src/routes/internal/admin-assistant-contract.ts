import { UnauthorizedError, ValidationError } from "@scalius/core/errors";
import { ASSISTANT_SESSION_CREDENTIAL_PREFIX } from "@scalius/core/modules/assistant";
import { SCALIUS_COMMAND_LIMITS } from "@scalius/shared/assistant-command";
import { z } from "zod/v4";
import { ASSISTANT_FLUE_THREAD_PATTERN } from "./flue-thread-admission";

export const ADMIN_ASSISTANT_AUTHORITY_BASE_PATH =
  "/api/v1/internal/admin-assistant";
export const ADMIN_ASSISTANT_SESSION_CREDENTIAL_HEADER =
  "x-scalius-assistant-session-credential";
export const ADMIN_ASSISTANT_MAX_BODY_BYTES = 16 * 1024;
export const ADMIN_ASSISTANT_MAX_EVENT_LIMIT = 25;
export const ADMIN_ASSISTANT_MAX_CAPABILITY_LIMIT = 50;

export const ADMIN_ASSISTANT_AUTHORITY_PATHS = Object.freeze({
  sessionCreate: `${ADMIN_ASSISTANT_AUTHORITY_BASE_PATH}/session/create`,
  sessionResume: `${ADMIN_ASSISTANT_AUTHORITY_BASE_PATH}/session/resume`,
  sessionRevoke: `${ADMIN_ASSISTANT_AUTHORITY_BASE_PATH}/session/revoke`,
  workflowCreate: `${ADMIN_ASSISTANT_AUTHORITY_BASE_PATH}/workflows/create`,
  eventsList: `${ADMIN_ASSISTANT_AUTHORITY_BASE_PATH}/events/list`,
  capabilitiesSearch:
    `${ADMIN_ASSISTANT_AUTHORITY_BASE_PATH}/capabilities/search`,
  capabilitiesDescribe:
    `${ADMIN_ASSISTANT_AUTHORITY_BASE_PATH}/capabilities/describe`,
  flueAdmit: `${ADMIN_ASSISTANT_AUTHORITY_BASE_PATH}/flue/admit`,
  flueCommand: `${ADMIN_ASSISTANT_AUTHORITY_BASE_PATH}/flue/command`,
} as const);

const authorityPathSet = new Set<string>(
  Object.values(ADMIN_ASSISTANT_AUTHORITY_PATHS),
);
const opaqueIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const capabilityIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/);

export const adminAssistantSessionCreateSchema = z.object({
  conversationKey: opaqueIdSchema,
}).strict();

export const adminAssistantEmptyBodySchema = z.object({}).strict();

export const adminAssistantFlueAdmitSchema = z.object({
  threadId: z.string().regex(ASSISTANT_FLUE_THREAD_PATTERN),
}).strict();

export const adminAssistantFlueCommandSchema = z.object({
  instanceId: z.string().regex(/^v1\.[A-Za-z0-9_-]{43}$/u),
  program: z.string().max(SCALIUS_COMMAND_LIMITS.programChars),
}).strict();

export const adminAssistantWorkflowCreateSchema = z.object({
  clientRequestId: opaqueIdSchema,
  capabilityId: capabilityIdSchema,
  parentWorkflowId: opaqueIdSchema.nullable().optional(),
}).strict();

export const adminAssistantEventListSchema = z.object({
  afterSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(ADMIN_ASSISTANT_MAX_EVENT_LIMIT).default(20),
}).strict();

export const adminAssistantCapabilitySearchSchema = z.object({
  query: z.string().trim().max(120).default(""),
  limit: z.number().int().min(1).max(ADMIN_ASSISTANT_MAX_CAPABILITY_LIMIT).default(20),
  readOnly: z.boolean().optional(),
  implementation: z.enum([
    "typed-command",
    "browser-adapter",
    "secure-manual",
  ]).optional(),
}).strict();

export const adminAssistantCapabilityDescribeSchema = z.object({
  capabilityId: capabilityIdSchema,
}).strict();

export function isExactInternalAdminAssistantRequest(
  request: Request,
): boolean {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }

  return request.method === "POST" &&
    url.protocol === "http:" &&
    url.hostname === "api.internal" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    authorityPathSet.has(url.pathname);
}

export function readAdminAssistantSessionCredential(request: Request): string {
  const credential = request.headers
    .get(ADMIN_ASSISTANT_SESSION_CREDENTIAL_HEADER)
    ?.trim();
  const payload = credential?.startsWith(ASSISTANT_SESSION_CREDENTIAL_PREFIX)
    ? credential.slice(ASSISTANT_SESSION_CREDENTIAL_PREFIX.length)
    : "";
  if (!credential || !/^[A-Za-z0-9_-]{43}$/.test(payload)) {
    throw new UnauthorizedError(
      "A valid assistant session credential is required.",
    );
  }
  return credential;
}

export async function parseAdminAssistantJson<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  const contentType = request.headers.get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new ValidationError("Expected an application/json request body.");
  }

  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > ADMIN_ASSISTANT_MAX_BODY_BYTES
    ) {
      throw new ValidationError("Assistant request body is too large.");
    }
  }

  const text = await readBoundedText(request, ADMIN_ASSISTANT_MAX_BODY_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ValidationError("Assistant request body is invalid JSON.");
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError("Assistant request body is invalid.");
  }
  return result.data;
}

async function readBoundedText(
  request: Request,
  maxBytes: number,
): Promise<string> {
  if (!request.body) {
    throw new ValidationError("Assistant request body is required.");
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new ValidationError("Assistant request body is too large.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("Assistant request body is not valid UTF-8.");
  } finally {
    reader.releaseLock();
  }

  if (!text) {
    throw new ValidationError("Assistant request body is required.");
  }
  return text;
}
