// The state of one "Continue with <app>" sign-in, kept in a signed cookie
// between the start and the callback. The platform makes the `state`, the
// `nonce` and the PKCE verifier; the browser holds them only in an httpOnly
// cookie scoped to the identity routes, HMAC-signed under a key derived at use
// from SCALIUS_SECRET (purpose `customer-identity-state`). Nothing is stored
// server side, so the callback can run on any isolate.

import { deriveRuntimeSecret, readMasterSecret } from "@scalius/shared/runtime-secrets";

export const IDENTITY_STATE_COOKIE = "scalius_idp";
/** The cookie never leaves the identity routes. */
export const IDENTITY_STATE_COOKIE_PATH = "/api/v1/customer-auth/identity";
export const IDENTITY_STATE_TTL_SECONDS = 10 * 60;
export const IDENTITY_DEFAULT_RETURN_TO = "/account";

const STATE_KEY_PURPOSE = "customer-identity-state";
const RETURN_TO_MAX = 512;

export interface IdentityFlowState {
  /** The app provider id. */
  providerId: string;
  state: string;
  nonce: string;
  /** PKCE code verifier (RFC 7636). */
  codeVerifier: string;
  /** A same-site storefront path. */
  returnTo: string;
  /** Unix seconds. */
  expiresAt: number;
}

const encoder = new TextEncoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** 32 random bytes as base64url (43 characters). */
export function randomToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

/** The PKCE S256 challenge of a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
}

/** Compares two strings without leaking where they differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

/**
 * A storefront path the sign-in may return to: one `/` followed by a path, no
 * host, scheme, backslash, control character or dot segment. Anything else is
 * the account page.
 */
export function safeReturnTo(value: string | null | undefined): string {
  const candidate = value?.trim() ?? "";
  if (
    !candidate.startsWith("/")
    || candidate.startsWith("//")
    || candidate.length > RETURN_TO_MAX
    || /[\\\u0000-\u001f\u007f\s]/.test(candidate)
    || candidate.split("?")[0]!.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    return IDENTITY_DEFAULT_RETURN_TO;
  }
  try {
    const parsed = new URL(candidate, "https://store.invalid");
    if (parsed.origin !== "https://store.invalid") return IDENTITY_DEFAULT_RETURN_TO;
  } catch {
    return IDENTITY_DEFAULT_RETURN_TO;
  }
  return candidate;
}

async function signingKey(env: { SCALIUS_SECRET?: unknown }): Promise<CryptoKey | null> {
  const master = readMasterSecret(env);
  if (!master) return null;
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(await deriveRuntimeSecret(master, STATE_KEY_PURPOSE)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** The cookie value for a flow, or null when the master secret is not installed. */
export async function sealIdentityState(env: { SCALIUS_SECRET?: unknown }, flow: IdentityFlowState): Promise<string | null> {
  const key = await signingKey(env);
  if (!key) return null;
  const body = base64UrlEncode(encoder.encode(JSON.stringify(flow)));
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** The flow a cookie value carries; null when it is malformed, tampered with or expired. */
export async function openIdentityState(
  env: { SCALIUS_SECRET?: unknown },
  value: string | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<IdentityFlowState | null> {
  const [body, signature, ...rest] = value?.split(".") ?? [];
  if (!body || !signature || rest.length > 0) return null;
  const key = await signingKey(env);
  const given = base64UrlDecode(signature);
  if (!key || !given) return null;
  if (!await crypto.subtle.verify("HMAC", key, given, encoder.encode(body))) return null;
  const bytes = base64UrlDecode(body);
  if (!bytes) return null;
  let parsed: Partial<IdentityFlowState>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<IdentityFlowState>;
  } catch {
    return null;
  }
  if (
    typeof parsed.providerId !== "string"
    || typeof parsed.state !== "string"
    || typeof parsed.nonce !== "string"
    || typeof parsed.codeVerifier !== "string"
    || typeof parsed.returnTo !== "string"
    || typeof parsed.expiresAt !== "number"
    || parsed.expiresAt <= nowSeconds
  ) {
    return null;
  }
  return parsed as IdentityFlowState;
}

export function identityStateCookie(value: string): string {
  return `${IDENTITY_STATE_COOKIE}=${value}; Max-Age=${IDENTITY_STATE_TTL_SECONDS}; Path=${IDENTITY_STATE_COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearIdentityStateCookie(): string {
  return `${IDENTITY_STATE_COOKIE}=; Max-Age=0; Path=${IDENTITY_STATE_COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax`;
}

export function readIdentityStateCookie(cookieHeader: string | null | undefined): string | null {
  const match = cookieHeader?.match(new RegExp(`(?:^|;\\s*)${IDENTITY_STATE_COOKIE}=([^;]+)`));
  return match?.[1] ?? null;
}
