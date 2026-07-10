const INSTANCE_VERSION = "v1";
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MINIMUM_SIGNING_KEY_LENGTH = 32;

export type AgentSurface = "admin" | "storefront";

export interface ThreadIdentity {
  tenantId: string;
  principalId: string;
  threadId: string;
}

function isValidSegment(value: string): boolean {
  return SEGMENT_PATTERN.test(value);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function importSigningKey(signingKey: string): Promise<CryptoKey | null> {
  if (new TextEncoder().encode(signingKey).byteLength < MINIMUM_SIGNING_KEY_LENGTH) {
    return null;
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function encodePayload(surface: AgentSurface, identity: ThreadIdentity): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([surface, identity.tenantId, identity.principalId, identity.threadId]),
  );
}

export function isValidThreadIdentity(identity: ThreadIdentity): boolean {
  return [identity.tenantId, identity.principalId, identity.threadId]
    .every(isValidSegment);
}

export async function createThreadInstanceId(
  surface: AgentSurface,
  identity: ThreadIdentity,
  signingKey: string,
): Promise<string> {
  if (!isValidThreadIdentity(identity)) {
    throw new Error("Invalid thread identity");
  }
  const key = await importSigningKey(signingKey);
  if (!key) throw new Error("Thread signing key must contain at least 32 bytes");
  const payload = encodePayload(surface, identity);
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    Uint8Array.from(payload).buffer,
  ));
  return `${INSTANCE_VERSION}.${encodeBase64Url(signature)}`;
}

export async function verifyThreadInstanceId(
  instanceId: string,
  expectedSurface: AgentSurface,
  expectedIdentity: ThreadIdentity,
  signingKey: string,
): Promise<boolean> {
  const parts = instanceId.split(".");
  if (
    parts.length !== 2 ||
    parts[0] !== INSTANCE_VERSION ||
    !isValidThreadIdentity(expectedIdentity)
  ) {
    return false;
  }
  const signature = decodeBase64Url(parts[1] ?? "");
  const key = await importSigningKey(signingKey);
  if (!signature || !key) return false;
  return crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(signature).buffer,
    Uint8Array.from(encodePayload(expectedSurface, expectedIdentity)).buffer,
  );
}
