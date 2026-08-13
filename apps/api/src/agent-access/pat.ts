const CREDENTIAL_ID_PATTERN = /^agc_[A-Za-z0-9_-]{20}$/;
const TOKEN_PATTERN = /^(sc_pat|sc_cli)_(agc_[A-Za-z0-9_-]{20})_([A-Za-z0-9_-]{43})$/;

export type AgentCredentialKind = "pat" | "cli";

export interface ParsedAgentCredential {
  kind: AgentCredentialKind;
  credentialId: string;
  secret: string;
}

export interface IssuedAgentCredential {
  credentialId: string;
  kind: AgentCredentialKind;
  token: string;
  tokenHash: string;
  tokenHint: string;
}

const encoder = new TextEncoder();

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function encodeHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertPepper(pepper: string | null | undefined): string {
  const normalized = pepper?.trim() ?? "";
  if (normalized.length < 32) {
    throw new Error("AGENT_TOKEN_PEPPER must contain at least 32 characters");
  }
  return normalized;
}

async function importHmacKey(pepper: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(assertPepper(pepper)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function hmacAgentOpaqueValue(
  label: string,
  value: string,
  pepper: string,
): Promise<string> {
  const key = await importHmacKey(pepper);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${label}\0${value}`),
  );
  return encodeHex(new Uint8Array(signature));
}

export function parseAgentCredential(token: string): ParsedAgentCredential | null {
  const match = TOKEN_PATTERN.exec(token.trim());
  if (!match) return null;
  return {
    kind: match[1] === "sc_cli" ? "cli" : "pat",
    credentialId: match[2]!,
    secret: match[3]!,
  };
}

export function getBearerToken(authorization: string | null | undefined): string | null {
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization?.trim() ?? "");
  return match?.[1] ?? null;
}

export async function hashAgentCredential(
  parsed: ParsedAgentCredential,
  pepper: string,
): Promise<string> {
  const key = await importHmacKey(pepper);
  const payload = `${parsed.kind}\0${parsed.credentialId}\0${parsed.secret}`;
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return encodeHex(new Uint8Array(signature));
}

export function constantTimeEqual(left: string, right: string): boolean {
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

export async function verifyAgentCredentialHash(
  parsed: ParsedAgentCredential,
  expectedHash: string,
  pepper: string,
): Promise<boolean> {
  return constantTimeEqual(
    await hashAgentCredential(parsed, pepper),
    expectedHash.trim().toLowerCase(),
  );
}

export async function issueAgentCredential(
  kind: AgentCredentialKind,
  credentialId: string,
  pepper: string,
): Promise<IssuedAgentCredential> {
  if (!CREDENTIAL_ID_PATTERN.test(credentialId)) {
    throw new Error("Agent credential ID has an invalid format");
  }
  const secret = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const parsed: ParsedAgentCredential = { kind, credentialId, secret };
  const prefix = kind === "cli" ? "sc_cli" : "sc_pat";
  return {
    credentialId,
    kind,
    token: `${prefix}_${credentialId}_${secret}`,
    tokenHash: await hashAgentCredential(parsed, pepper),
    tokenHint: `${prefix}_${credentialId}_${secret.slice(0, 4)}…${secret.slice(-4)}`,
  };
}

export function getAgentTokenSafeHint(token: string): string | null {
  const parsed = parseAgentCredential(token);
  if (!parsed) return null;
  const prefix = parsed.kind === "cli" ? "sc_cli" : "sc_pat";
  return `${prefix}_${parsed.credentialId}_${parsed.secret.slice(0, 4)}…${parsed.secret.slice(-4)}`;
}
