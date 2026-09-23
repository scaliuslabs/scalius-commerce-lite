/**
 * Runtime secret derivation.
 *
 * Every deployment installs exactly one master secret, `SCALIUS_SECRET`, on
 * each Worker. All other runtime secrets (session signing, JWT signing, the
 * storefront service token, the agent token
 * pepper, the customer session hash key, and the opt-in automation secrets for
 * first-admin setup, trusted front proxies, and identity handoff) are derived
 * from it with HKDF-SHA256 and a fixed purpose label. Operators derive the
 * automation secrets with the same parameters (`scripts/derive-runtime-secret.mjs`). Derived values are never installed,
 * logged, or stored; they are recomputed at Worker entry for each invocation.
 *
 * Rotation: changing `SCALIUS_SECRET` rotates every derived secret at once.
 * Admin sessions, service JWTs, and agent credential hashes become invalid;
 * encrypted provider credentials are unaffected because they use the separate
 * `CREDENTIAL_ENCRYPTION_KEY`.
 */

export const MASTER_SECRET_NAME = "SCALIUS_SECRET";
export const MASTER_SECRET_MIN_LENGTH = 32;

const HKDF_SALT = "scalius-commerce/runtime-secrets/v1";
const DERIVED_SECRET_BYTES = 32;

export const RUNTIME_SECRET_PURPOSES = {
  BETTER_AUTH_SECRET: "better-auth-session",
  JWT_SECRET: "jwt-signing",
  API_TOKEN: "service-api-token",
  AGENT_TOKEN_PEPPER: "agent-token-pepper",
  CUSTOMER_SESSION_HASH_KEY: "customer-session-hash",
  /** Gates `POST /api/v1/setup` when the Platform setting requires a token. */
  ADMIN_SETUP_TOKEN: "admin-setup",
  /** HMAC key a trusted front proxy uses to sign forwarded host/proto/IP. */
  FRONT_PROXY_SECRET: "front-proxy",
  /** HS256 key for operator-minted dashboard identity handoff tokens. */
  IDENTITY_HANDOFF_SECRET: "identity-handoff",
} as const;

export type RuntimeSecretName = keyof typeof RUNTIME_SECRET_PURPOSES;
export type DerivedRuntimeSecrets = Record<RuntimeSecretName, string>;

export interface MasterSecretEnvironment {
  SCALIUS_SECRET?: unknown;
}

const encoder = new TextEncoder();

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Returns the trimmed master secret when it is installed and long enough,
 * otherwise `null`. Callers must fail closed on `null`.
 */
export function readMasterSecret(
  env: MasterSecretEnvironment | null | undefined,
): string | null {
  const value = typeof env?.SCALIUS_SECRET === "string" ? env.SCALIUS_SECRET.trim() : "";
  return value.length >= MASTER_SECRET_MIN_LENGTH ? value : null;
}

export function describeMissingMasterSecret(): string {
  return `${MASTER_SECRET_NAME} is not installed or is shorter than ${MASTER_SECRET_MIN_LENGTH} characters. Generate one with: openssl rand -base64 48`;
}

/** Derives one 256-bit secret (base64url, 43 chars) for the given purpose. */
export async function deriveRuntimeSecret(
  master: string,
  purpose: string,
): Promise<string> {
  if (master.length < MASTER_SECRET_MIN_LENGTH) {
    throw new Error(describeMissingMasterSecret());
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(master),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(HKDF_SALT),
      info: encoder.encode(purpose),
    },
    key,
    DERIVED_SECRET_BYTES * 8,
  );
  return encodeBase64Url(new Uint8Array(bits));
}

/** Derives the complete set of runtime secrets from the master secret. */
export async function deriveRuntimeSecrets(
  master: string,
): Promise<DerivedRuntimeSecrets> {
  const names = Object.keys(RUNTIME_SECRET_PURPOSES) as RuntimeSecretName[];
  const values = await Promise.all(
    names.map((name) => deriveRuntimeSecret(master, RUNTIME_SECRET_PURPOSES[name])),
  );
  return Object.fromEntries(
    names.map((name, index) => [name, values[index]!]),
  ) as DerivedRuntimeSecrets;
}

/**
 * Convenience for Worker entry points: derives every runtime secret from the
 * environment's master secret, or returns `null` when it is not installed.
 */
export async function deriveRuntimeSecretsFromEnv(
  env: MasterSecretEnvironment | null | undefined,
): Promise<DerivedRuntimeSecrets | null> {
  const master = readMasterSecret(env);
  return master ? deriveRuntimeSecrets(master) : null;
}
