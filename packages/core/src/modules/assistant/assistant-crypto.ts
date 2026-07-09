import { ServiceUnavailableError, ValidationError } from "@scalius/core/errors";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const ASSISTANT_ARGUMENTS_ENCRYPTION_PREFIX = "aenc:v1:";
export const ASSISTANT_CANONICAL_JSON_MAX_BYTES = 64 * 1024;
export const ASSISTANT_SESSION_CREDENTIAL_PREFIX = "session_asst_";
export const ASSISTANT_APPROVAL_CREDENTIAL_PREFIX = "approval_asst_";

export interface AssistantCanonicalJsonLimits {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxObjectKeys?: number;
  maxArrayItems?: number;
  maxStringLength?: number;
}

const DEFAULT_CANONICAL_LIMITS: Required<AssistantCanonicalJsonLimits> = {
  maxBytes: ASSISTANT_CANONICAL_JSON_MAX_BYTES,
  maxDepth: 12,
  maxNodes: 2_000,
  maxObjectKeys: 256,
  maxArrayItems: 500,
  maxStringLength: 16_000,
};

const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Canonicalizes a bounded JSON value for hashing and encryption.
 *
 * This deliberately accepts JSON data only: no Dates, accessors, class instances,
 * sparse arrays, undefined, symbols, bigint, cycles, or non-finite numbers.
 */
export function canonicalizeAssistantJson(
  value: unknown,
  limits: AssistantCanonicalJsonLimits = {},
): string {
  const resolved = resolveCanonicalLimits(limits);
  const state = { nodes: 0, ancestors: new WeakSet<object>() };
  const canonical = canonicalizeValue(value, 0, resolved, state);

  if (textEncoder.encode(canonical).byteLength > resolved.maxBytes) {
    throw new ValidationError(
      `Assistant JSON exceeds the ${resolved.maxBytes}-byte storage limit.`,
    );
  }

  return canonical;
}

export async function hashAssistantArguments(argumentsValue: unknown): Promise<string> {
  return sha256Hex(canonicalizeAssistantJson(argumentsValue));
}

export function createAssistantSessionCredential(): string {
  return `${ASSISTANT_SESSION_CREDENTIAL_PREFIX}${randomBase64Url(32)}`;
}

export async function createAssistantApprovalCredential(
  credentialKey: string,
  binding: {
    actionId: string;
    argumentsHash: string;
    approvedBy: string;
    approvedAt: Date;
    expiresAt: Date;
  },
): Promise<string> {
  const secret = requireHmacSecret(
    credentialKey,
    "Assistant approval credential key",
  );
  const actionId = requireOpaqueText(binding.actionId, "Action ID", 160);
  const approvedBy = requireOpaqueText(binding.approvedBy, "Approving actor ID", 160);
  if (!/^[a-f0-9]{64}$/.test(binding.argumentsHash)) {
    throw new ValidationError("Assistant arguments hash is malformed.");
  }
  if (
    !Number.isFinite(binding.approvedAt.getTime()) ||
    !Number.isFinite(binding.expiresAt.getTime()) ||
    binding.expiresAt <= binding.approvedAt
  ) {
    throw new ValidationError("Assistant approval credential timestamps are invalid.");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(textEncoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(textEncoder.encode(canonicalizeAssistantJson({
      version: "assistant-approval-credential:v1",
      actionId,
      argumentsHash: binding.argumentsHash,
      approvedBy,
      approvedAt: binding.approvedAt.getTime(),
      expiresAt: binding.expiresAt.getTime(),
    }))),
  );
  return `${ASSISTANT_APPROVAL_CREDENTIAL_PREFIX}${bytesToBase64Url(signature)}`;
}

export async function hashAssistantSessionCredential(credential: string): Promise<string> {
  return hashOpaqueCredential("session", credential);
}

export async function hashAssistantApprovalCredential(credential: string): Promise<string> {
  return hashOpaqueCredential("approval", credential);
}

export async function hashAssistantExecutionIdempotencyKey(
  actionId: string,
  idempotencyKey: string,
): Promise<string> {
  const normalizedActionId = requireOpaqueText(actionId, "Action ID", 160);
  const normalizedKey = requireOpaqueText(idempotencyKey, "Idempotency key", 160);
  return sha256Hex(
    canonicalizeAssistantJson({
      version: "assistant-execution-idempotency:v1",
      actionId: normalizedActionId,
      idempotencyKey: normalizedKey,
    }),
  );
}

export async function hashAssistantRateLimitBucket(
  scope: string,
  bucket: string,
  hashKey: string,
): Promise<string> {
  const normalizedScope = requireOpaqueText(scope, "Rate-limit scope", 160);
  const normalizedBucket = bucket.trim();
  if (!normalizedBucket || normalizedBucket.length > 1_000) {
    throw new ValidationError("Rate-limit identity must contain between 1 and 1000 characters.");
  }

  const secret = requireHmacSecret(hashKey, "Assistant rate-limit hash key");
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(textEncoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(textEncoder.encode(canonicalizeAssistantJson({
      version: "assistant-rate-limit:v1",
      scope: normalizedScope,
      bucket: normalizedBucket,
    }))),
  );
  return bytesToHex(signature);
}

export async function encryptAssistantArguments(
  canonicalArguments: string,
  encryptionKey: string,
  binding: { actionId: string; argumentsHash: string },
): Promise<string> {
  const key = await importAssistantEncryptionKey(encryptionKey, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(buildArgumentsAdditionalData(binding)),
    },
    key,
    toArrayBuffer(textEncoder.encode(canonicalArguments)),
  );

  return `${ASSISTANT_ARGUMENTS_ENCRYPTION_PREFIX}${bytesToBase64Url(iv)}:${bytesToBase64Url(ciphertext)}`;
}

export async function decryptAssistantArguments(
  encryptedArguments: string,
  encryptionKey: string,
  binding: { actionId: string; argumentsHash: string },
): Promise<string> {
  if (!encryptedArguments.startsWith(ASSISTANT_ARGUMENTS_ENCRYPTION_PREFIX)) {
    throw new ServiceUnavailableError("Assistant action arguments are not in the supported encrypted format.");
  }

  const encoded = encryptedArguments.slice(ASSISTANT_ARGUMENTS_ENCRYPTION_PREFIX.length);
  const [ivValue, ciphertextValue, extra] = encoded.split(":");
  if (!ivValue || !ciphertextValue || extra !== undefined) {
    throw new ServiceUnavailableError("Assistant action arguments are unreadable.");
  }

  try {
    const iv = base64UrlToBytes(ivValue);
    const ciphertext = base64UrlToBytes(ciphertextValue);
    if (iv.byteLength !== 12 || ciphertext.byteLength < 16) {
      throw new Error("Invalid AES-GCM payload.");
    }

    const key = await importAssistantEncryptionKey(encryptionKey, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(buildArgumentsAdditionalData(binding)),
      },
      key,
      toArrayBuffer(ciphertext),
    );
    return textDecoder.decode(plaintext);
  } catch (error) {
    if (error instanceof ServiceUnavailableError) throw error;
    throw new ServiceUnavailableError("Assistant action arguments could not be decrypted.");
  }
}

export function constantTimeAssistantHashEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(textEncoder.encode(value))),
  );
}

function canonicalizeValue(
  value: unknown,
  depth: number,
  limits: Required<AssistantCanonicalJsonLimits>,
  state: { nodes: number; ancestors: WeakSet<object> },
): string {
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) {
    throw new ValidationError(`Assistant JSON exceeds the ${limits.maxNodes}-node limit.`);
  }
  if (depth > limits.maxDepth) {
    throw new ValidationError(`Assistant JSON exceeds the maximum depth of ${limits.maxDepth}.`);
  }

  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ValidationError("Assistant JSON numbers must be finite.");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "string") {
    if (value.length > limits.maxStringLength) {
      throw new ValidationError(
        `Assistant JSON strings cannot exceed ${limits.maxStringLength} characters.`,
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new ValidationError("Assistant arguments must contain JSON values only.");
  }

  if (state.ancestors.has(value)) {
    throw new ValidationError("Assistant JSON cannot contain cycles.");
  }
  state.ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      if (value.length > limits.maxArrayItems) {
        throw new ValidationError(
          `Assistant JSON arrays cannot exceed ${limits.maxArrayItems} items.`,
        );
      }

      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new ValidationError("Assistant JSON cannot contain sparse arrays.");
        }
        items.push(canonicalizeValue(value[index], depth + 1, limits, state));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ValidationError("Assistant JSON objects must be plain objects.");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new ValidationError("Assistant JSON objects cannot contain symbol keys.");
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length > limits.maxObjectKeys) {
      throw new ValidationError(
        `Assistant JSON objects cannot exceed ${limits.maxObjectKeys} keys.`,
      );
    }

    const entries = keys.sort().map((key) => {
      if (key.length > 256 || FORBIDDEN_OBJECT_KEYS.has(key)) {
        throw new ValidationError(`Assistant JSON contains an unsupported object key: ${key}.`);
      }
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) {
        throw new ValidationError("Assistant JSON objects cannot contain accessors.");
      }
      return `${JSON.stringify(key)}:${canonicalizeValue(descriptor.value, depth + 1, limits, state)}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    state.ancestors.delete(value);
  }
}

function resolveCanonicalLimits(
  limits: AssistantCanonicalJsonLimits,
): Required<AssistantCanonicalJsonLimits> {
  const resolved = { ...DEFAULT_CANONICAL_LIMITS, ...limits };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ValidationError(`Assistant JSON limit ${name} must be a positive integer.`);
    }
  }
  return resolved;
}

async function hashOpaqueCredential(
  kind: "session" | "approval",
  credential: string,
): Promise<string> {
  const normalized = credential.trim();
  const expectedPrefix = kind === "session"
    ? ASSISTANT_SESSION_CREDENTIAL_PREFIX
    : ASSISTANT_APPROVAL_CREDENTIAL_PREFIX;
  if (
    !normalized.startsWith(expectedPrefix) ||
    !new RegExp(`^${expectedPrefix}[A-Za-z0-9_-]{43}$`).test(normalized)
  ) {
    throw new ValidationError("Assistant credential is malformed.");
  }
  return sha256Hex(`assistant-${kind}-credential:v1:${normalized}`);
}

async function importAssistantEncryptionKey(
  encryptionKey: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const encodedKey = requireDedicatedSecret(
    encryptionKey,
    "Assistant argument encryption key",
  );

  try {
    const keyBytes = Uint8Array.from(atob(encodedKey), (character) => character.charCodeAt(0));
    if (keyBytes.byteLength !== 32) throw new Error("Expected an AES-256 key.");
    return await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(keyBytes),
      "AES-GCM",
      false,
      usages,
    );
  } catch {
    throw new ServiceUnavailableError(
      "Assistant argument encryption key must be a valid 32-byte base64 value.",
    );
  }
}

function buildArgumentsAdditionalData(binding: {
  actionId: string;
  argumentsHash: string;
}): Uint8Array {
  const actionId = requireOpaqueText(binding.actionId, "Action ID", 160);
  if (!/^[a-f0-9]{64}$/.test(binding.argumentsHash)) {
    throw new ValidationError("Assistant arguments hash is malformed.");
  }
  return textEncoder.encode(
    `assistant-action-arguments:v1:${actionId}:${binding.argumentsHash}`,
  );
}

function requireDedicatedSecret(value: string, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new ServiceUnavailableError(`${label} is not configured.`);
  }
  return normalized;
}

function requireHmacSecret(value: string, label: string): string {
  const normalized = requireDedicatedSecret(value, label);
  if (textEncoder.encode(normalized).byteLength < 32) {
    throw new ServiceUnavailableError(`${label} must contain at least 32 bytes.`);
  }
  return normalized;
}

function requireOpaqueText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxLength ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(normalized)
  ) {
    throw new ValidationError(`${label} is malformed.`);
  }
  return normalized;
}

function randomBase64Url(byteLength: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function bytesToBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url value.");
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
