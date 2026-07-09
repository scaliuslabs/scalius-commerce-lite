import { UnauthorizedError, ValidationError } from "@scalius/core/errors";
import { ASSISTANT_SESSION_CREDENTIAL_PREFIX } from "@scalius/core/modules/assistant";
import { z } from "zod/v4";

export const STOREFRONT_ASSISTANT_AUTHORITY_BASE_PATH =
  "/api/v1/internal/storefront-assistant";
export const STOREFRONT_ASSISTANT_SESSION_COOKIE =
  "scalius_storefront_assistant";
export const STOREFRONT_ASSISTANT_COOKIE_PATH_PREFIX =
  "/api/assistant/conversations/";
export const STOREFRONT_ASSISTANT_AUDIENCE =
  "scalius-storefront-browser-v1";
export const STOREFRONT_ASSISTANT_SESSION_TTL_SECONDS = 8 * 60 * 60;
export const STOREFRONT_ASSISTANT_MAX_BODY_BYTES = 2 * 1024;
export const STOREFRONT_ASSISTANT_MAX_COOKIE_BYTES = 2 * 1024;

export const STOREFRONT_ASSISTANT_AUTHORITY_PATHS = Object.freeze({
  sessionCreate:
    `${STOREFRONT_ASSISTANT_AUTHORITY_BASE_PATH}/session/create`,
  sessionResolve:
    `${STOREFRONT_ASSISTANT_AUTHORITY_BASE_PATH}/session/resolve`,
  sessionRevoke:
    `${STOREFRONT_ASSISTANT_AUTHORITY_BASE_PATH}/session/revoke`,
} as const);

export const STOREFRONT_ASSISTANT_SUBJECT_PATTERN =
  /^storefront_subject_[A-Za-z0-9_-]{43}$/;
export const STOREFRONT_ASSISTANT_CONVERSATION_PATTERN =
  /^conv_[A-Za-z0-9_-]{22,64}$/;

const authorityPathSet = new Set<string>(
  Object.values(STOREFRONT_ASSISTANT_AUTHORITY_PATHS),
);

export const storefrontAssistantSessionCreateSchema = z.object({
  conversationId: z.string().regex(STOREFRONT_ASSISTANT_CONVERSATION_PATTERN),
}).strict();

export const storefrontAssistantSessionBoundSchema = z.object({
  conversationId: z.string().regex(STOREFRONT_ASSISTANT_CONVERSATION_PATTERN),
}).strict();

export function isExactInternalStorefrontAssistantRequest(
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

export function hasForbiddenStorefrontAssistantAuthorityHeader(
  headers: Headers,
): boolean {
  for (const [name] of headers) {
    const normalized = name.toLowerCase();
    if (
      normalized === "authorization" ||
      normalized === "proxy-authorization" ||
      normalized === "x-scalius-assistant-session-credential" ||
      normalized.startsWith("x-scalius-conversation-")
    ) {
      return true;
    }
  }
  return false;
}

function isStrongAssistantCredential(value: string): boolean {
  if (!value.startsWith(ASSISTANT_SESSION_CREDENTIAL_PREFIX)) return false;
  const payload = value.slice(ASSISTANT_SESSION_CREDENTIAL_PREFIX.length);
  return /^[A-Za-z0-9_-]{43}$/.test(payload);
}

export function readStorefrontAssistantSessionCredential(
  request: Request,
): string {
  const cookieHeader = request.headers.get("Cookie") ?? "";
  if (
    !cookieHeader ||
    new TextEncoder().encode(cookieHeader).byteLength >
      STOREFRONT_ASSISTANT_MAX_COOKIE_BYTES
  ) {
    throw new UnauthorizedError("Storefront assistant session is required.");
  }

  const values = cookieHeader.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return [];
    const name = part.slice(0, separator).trim();
    if (name !== STOREFRONT_ASSISTANT_SESSION_COOKIE) return [];
    return [part.slice(separator + 1).trim()];
  });
  if (values.length !== 1 || !isStrongAssistantCredential(values[0] ?? "")) {
    throw new UnauthorizedError("Storefront assistant session is unavailable.");
  }
  return values[0]!;
}

export function storefrontAssistantCookiePath(conversationId: string): string {
  if (!STOREFRONT_ASSISTANT_CONVERSATION_PATTERN.test(conversationId)) {
    throw new ValidationError("Storefront assistant conversation is malformed.");
  }
  return `${STOREFRONT_ASSISTANT_COOKIE_PATH_PREFIX}${conversationId}`;
}

export function storefrontAssistantSessionCookie(
  credential: string,
  conversationId: string,
): string {
  if (!isStrongAssistantCredential(credential)) {
    throw new ValidationError("Storefront assistant credential is malformed.");
  }
  const path = storefrontAssistantCookiePath(conversationId);
  return `${STOREFRONT_ASSISTANT_SESSION_COOKIE}=${credential}; Max-Age=${STOREFRONT_ASSISTANT_SESSION_TTL_SECONDS}; Path=${path}; HttpOnly; SameSite=Lax; Secure`;
}

export function clearStorefrontAssistantSessionCookie(
  conversationId: string,
): string {
  const path = storefrontAssistantCookiePath(conversationId);
  return `${STOREFRONT_ASSISTANT_SESSION_COOKIE}=; Max-Age=0; Path=${path}; HttpOnly; SameSite=Lax; Secure`;
}

export async function parseStorefrontAssistantJson<T>(
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
      parsedLength > STOREFRONT_ASSISTANT_MAX_BODY_BYTES
    ) {
      throw new ValidationError("Storefront assistant request is too large.");
    }
  }

  const text = await readBoundedText(
    request,
    STOREFRONT_ASSISTANT_MAX_BODY_BYTES,
  );
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ValidationError("Storefront assistant request is invalid JSON.");
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError("Storefront assistant request is invalid.");
  }
  return result.data;
}

async function readBoundedText(
  request: Request,
  maxBytes: number,
): Promise<string> {
  if (!request.body) {
    throw new ValidationError("Storefront assistant request body is required.");
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
        throw new ValidationError("Storefront assistant request is too large.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(
      "Storefront assistant request is not valid UTF-8.",
    );
  } finally {
    reader.releaseLock();
  }

  if (!text) {
    throw new ValidationError("Storefront assistant request body is required.");
  }
  return text;
}
