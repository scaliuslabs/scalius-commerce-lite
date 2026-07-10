import {
  parseScaliusCommandProgram,
  type ScaliusCommandJsonObject,
} from "./assistant-command";

export type ScaliusCommandSurface = "admin" | "storefront";

export const SCALIUS_COMMAND_API_ORIGIN = "http://api.internal" as const;
export const SCALIUS_COMMAND_API_PATHS = Object.freeze({
  admin: "/api/v1/internal/admin-assistant/flue/command",
  storefront: "/api/v1/internal/storefront-assistant/flue/command",
});
export const SCALIUS_COMMAND_MAX_RESPONSE_BYTES = 16 * 1_024;
export const SCALIUS_COMMAND_TIMEOUT_MS = 5_000;

/** Native Cloudflare HTTP service-binding surface, narrowed to the one method used here. */
export type ScaliusCommandApiBinding = Pick<Fetcher, "fetch">;

export type ScaliusCommandToolResult =
  | {
      readonly ok: true;
      readonly authoritative: true;
      readonly code: "ok";
      readonly message: "Authoritative Scalius result received.";
      readonly retryable: false;
      readonly data: ScaliusCommandJsonObject;
    }
  | {
      readonly ok: false;
      readonly authoritative: boolean;
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

export interface RunScaliusCommandOptions {
  readonly surface: ScaliusCommandSurface;
  readonly instanceId: string;
  readonly program: unknown;
  readonly api?: ScaliusCommandApiBinding;
  /** Tests may shorten the deadline; production is capped at the exported default. */
  readonly timeoutMs?: number;
}

const INSTANCE_ID_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/u;
const SAFE_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const MAX_ERROR_MESSAGE_CHARS = 300;
const MIN_TIMEOUT_MS = 10;
const MAX_RESULT_DEPTH = 10;
const MAX_RESULT_KEYS = 160;
const MAX_RESULT_KEY_CHARS = 96;
const MAX_RESULT_ARRAY_ITEMS = 100;
const MAX_RESULT_STRING_CHARS = 12_000;
const MAX_RESULT_VALUES = 600;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const FORBIDDEN_RESULT_KEYS = new Set([
  "accesstoken",
  "assistantcredential",
  "assistantsessioncredential",
  "authorization",
  "cookie",
  "cookies",
  "credential",
  "instanceid",
  "otp",
  "password",
  "principal",
  "principalid",
  "proxyauthorization",
  "receiptproof",
  "refreshtoken",
  "secret",
  "sessioncredential",
  "setcookie",
  "tenant",
  "tenantid",
  "threadid",
  "token",
]);
const UNSAFE_ERROR_TEXT =
  /(?:authorization|bearer|cookie|credential|https?:\/\/|instance[ _-]?id|otp|pass(?:code|phrase|word)|principal[ _-]?id|receipt[ _-]?proof|secret|tenant[ _-]?id|thread[ _-]?id|token)/iu;

export async function runScaliusCommand(
  options: RunScaliusCommandOptions,
): Promise<ScaliusCommandToolResult> {
  if (typeof options.program !== "string") {
    return localFailure("invalid_program", "Program must be a string.", false);
  }
  const parsed = parseScaliusCommandProgram(options.program);
  if (!parsed.ok) {
    return localFailure("invalid_program", parsed.error.message, false);
  }
  const api = options.api;
  if (
    !INSTANCE_ID_PATTERN.test(options.instanceId) ||
    (options.surface !== "admin" && options.surface !== "storefront") ||
    !api ||
    typeof api.fetch !== "function"
  ) {
    return unavailable();
  }
  const program = options.program;

  const requestedTimeout = options.timeoutMs ?? SCALIUS_COMMAND_TIMEOUT_MS;
  const timeoutMs = Math.max(
    MIN_TIMEOUT_MS,
    Math.min(
      Number.isFinite(requestedTimeout) ? Math.trunc(requestedTimeout) : SCALIUS_COMMAND_TIMEOUT_MS,
      SCALIUS_COMMAND_TIMEOUT_MS,
    ),
  );
  const abortController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        abortController.abort();
        reject(new Error("SCALIUS_COMMAND_TIMEOUT"));
      }, timeoutMs);
    });
    const operation = async () => {
      const response = await api.fetch(
        `${SCALIUS_COMMAND_API_ORIGIN}${SCALIUS_COMMAND_API_PATHS[options.surface]}`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            instanceId: options.instanceId,
            program,
          }),
          redirect: "error",
          signal: abortController.signal,
        },
      );
      return admitApiResponse(response);
    };
    const admitted = await Promise.race([operation(), timeout]);
    return admitted ?? invalidResponse();
  } catch {
    return timedOut
      ? localFailure("scalius_timeout", "Scalius did not respond in time.", true)
      : unavailable();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function admitApiResponse(response: Response): Promise<ScaliusCommandToolResult | null> {
  const mediaType = response.headers.get("content-type")
    ?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") return null;

  const source = await readBoundedResponse(response);
  if (source === null) return null;

  let body: unknown;
  try {
    body = JSON.parse(source) as unknown;
  } catch {
    return null;
  }
  if (!isPlainRecord(body)) return null;

  if (body.success === true) {
    if (!response.ok || !hasExactKeys(body, ["success", "data"]) || !isPlainRecord(body.data)) {
      return null;
    }
    if (!validateResultData(body.data)) return null;
    return {
      ok: true,
      authoritative: true,
      code: "ok",
      message: "Authoritative Scalius result received.",
      retryable: false,
      data: body.data,
    };
  }

  if (
    body.success !== false ||
    !hasExactKeys(body, ["success", "error"]) ||
    !isPlainRecord(body.error) ||
    !hasExactKeys(body.error, ["code", "message", "retryable"])
  ) return null;

  const { code, message, retryable } = body.error;
  if (
    typeof code !== "string" ||
    !SAFE_ERROR_CODE_PATTERN.test(code) ||
    !isSafeApiErrorMessage(message) ||
    typeof retryable !== "boolean"
  ) return null;
  return {
    ok: false,
    authoritative: true,
    code,
    message,
    retryable,
  };
}

async function readBoundedResponse(response: Response): Promise<string | null> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^[0-9]+$/u.test(declaredLength)) return null;
    if (Number(declaredLength) > SCALIUS_COMMAND_MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      return null;
    }
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let output = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > SCALIUS_COMMAND_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      output += decoder.decode(chunk.value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
}

function validateResultData(data: Record<string, unknown>): data is ScaliusCommandJsonObject {
  const counters = { keys: 0, values: 0 };
  return validateResultValue(data, counters, 1);
}

function validateResultValue(
  value: unknown,
  counters: { keys: number; values: number },
  depth: number,
): boolean {
  counters.values += 1;
  if (counters.values > MAX_RESULT_VALUES) return false;
  if (typeof value === "string") {
    return value.length <= MAX_RESULT_STRING_CHARS && !containsControlCharacter(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  }
  if (value === null || typeof value === "boolean") return true;
  if (depth > MAX_RESULT_DEPTH) return false;
  if (Array.isArray(value)) {
    return value.length <= MAX_RESULT_ARRAY_ITEMS &&
      value.every((item) => validateResultValue(item, counters, depth + 1));
  }
  if (!isPlainRecord(value)) return false;

  for (const [key, child] of Object.entries(value)) {
    counters.keys += 1;
    const normalizedKey = normalizeKey(key);
    if (
      counters.keys > MAX_RESULT_KEYS ||
      key.length > MAX_RESULT_KEY_CHARS ||
      containsControlCharacter(key) ||
      PROTOTYPE_KEYS.has(key.toLowerCase()) ||
      FORBIDDEN_RESULT_KEYS.has(normalizedKey) ||
      !validateResultValue(child, counters, depth + 1)
    ) return false;
  }
  return true;
}

function isSafeApiErrorMessage(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ERROR_MESSAGE_CHARS &&
    value.trim() === value &&
    !containsControlCharacter(value) &&
    !UNSAFE_ERROR_TEXT.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    [...expected].sort().every((key, index) => actual[index] === key);
}

function normalizeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) return true;
  }
  return false;
}

function unavailable(): ScaliusCommandToolResult {
  return localFailure("scalius_unavailable", "Scalius is temporarily unavailable.", true);
}

function invalidResponse(): ScaliusCommandToolResult {
  return localFailure("scalius_invalid_response", "Scalius returned an unusable response.", true);
}

function localFailure(
  code: string,
  message: string,
  retryable: boolean,
): ScaliusCommandToolResult {
  return { ok: false, authoritative: false, code, message, retryable };
}
