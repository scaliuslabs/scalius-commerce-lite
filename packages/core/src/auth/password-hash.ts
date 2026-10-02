/**
 * Password hashes: self-describing, versioned, and sized to the plan.
 *
 * Better Auth hashes with scrypt (N=16384, r=16, p=1: 32 MiB of memory and
 * about 80 ms of CPU in workerd, measured). Workers Free allows 10 ms of CPU
 * for a whole request, so a sign-in could never succeed there. This module
 * replaces the hash and verify functions with one format that carries its own
 * parameters, so the cost is chosen per plan (`planLimits().password`) and a
 * store that moves between plans keeps working:
 *
 *   $sc1$pbkdf2-sha256$i=30000,k=1$<salt>$<hash>        Free: WebCrypto, native, ~4 ms
 *   $sc1$scrypt$N=16384,r=16,p=1,k=1$<salt>$<hash>      Paid: memory-hard, as strong as before
 *   <32 hex>:<128 hex>                                  Better Auth's own scrypt hash (verified, then upgraded)
 *
 * `sc1` is the format version; `k=1` says the password was keyed with the
 * deployment's pepper first. The pepper is HMAC-SHA256 of the NFKC-normalised
 * password under a key derived (HKDF) from CREDENTIAL_ENCRYPTION_KEY, which
 * lives in the Worker and never in D1: a copy of the database alone does not
 * let anyone test a single guess, whatever the iteration count. (It is the key
 * that is not touched when SCALIUS_SECRET rotates; losing it already costs every
 * stored provider credential.)
 *
 * A successful verify reports `needsRehash` when the stored hash does not match
 * what this deployment would write now (another algorithm or cost, no pepper,
 * or Better Auth's format), and the caller rewrites it with the password it
 * just checked: a Paid store upgrades a Free hash at the next login, and a
 * store that dropped to Free stops paying for scrypt after one login.
 */
import { scrypt as nodeScrypt } from "node:crypto";
import { verifyPassword as verifyBetterAuthPassword } from "better-auth/crypto";
import { planLimits, type PasswordHashSpec } from "@scalius/shared/plan-limits";

export const PASSWORD_HASH_PREFIX = "$sc1$";
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const PEPPER_INFO = "scalius/password-pepper/v1";
const PEPPER_SALT = "scalius-commerce/password/v1";

/** Parameter bounds a stored hash must respect: a damaged row must not allocate gigabytes. */
const MAX_PBKDF2_ITERATIONS = 5_000_000;
const MAX_SCRYPT_MEMORY_BYTES = 128 * 1024 * 1024;

const BETTER_AUTH_HASH = /^[0-9a-f]{32}:[0-9a-f]{128}$/;

export interface PasswordHashOptions {
  /** What a new hash costs; defaults to this deployment's plan profile. */
  spec?: PasswordHashSpec;
  /** CREDENTIAL_ENCRYPTION_KEY (base64): the pepper's source. Without it hashes are made, and only accepted, unkeyed. */
  pepperKey?: string | undefined;
}

export interface PasswordVerdict {
  valid: boolean;
  /** The password was right but the stored hash is not what this deployment writes now. */
  needsRehash: boolean;
}

type StoredParams = (
  | { algorithm: "pbkdf2-sha256"; iterations: number }
  | { algorithm: "scrypt"; N: number; r: number; p: number }
) & { keyed: boolean };

const encoder = new TextEncoder();

/** WebCrypto's BufferSource wants an ArrayBuffer-backed view, not an ArrayBufferLike one. */
type Bytes = Uint8Array<ArrayBuffer>;

function toBase64Url(bytes: Bytes): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(text: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function constantTimeEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

/** The pepper: HKDF-SHA256 of the credential key. Null when no usable key is configured. */
async function derivePepper(keyBase64: string | undefined): Promise<Bytes | null> {
  if (!keyBase64) return null;
  let keyBytes: Bytes;
  try {
    keyBytes = Uint8Array.from(atob(keyBase64), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
  if (keyBytes.length < 16) return null;
  const key = await crypto.subtle.importKey("raw", keyBytes, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(PEPPER_SALT), info: encoder.encode(PEPPER_INFO) },
    key,
    256,
  ));
}

/** What the KDF is fed: the NFKC-normalised password, keyed with the pepper when there is one. */
async function kdfInput(password: string, pepper: Bytes | null): Promise<Bytes> {
  const normalized = encoder.encode(password.normalize("NFKC"));
  if (!pepper) return normalized;
  const key = await crypto.subtle.importKey("raw", pepper, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, normalized));
}

function scryptBytes(input: Bytes, salt: Bytes, params: { N: number; r: number; p: number }): Promise<Bytes> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      input,
      salt,
      HASH_BYTES,
      { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2 },
      (error, derived) => (error ? reject(error) : resolve(new Uint8Array(derived))),
    );
  });
}

async function derive(params: StoredParams, input: Bytes, salt: Bytes): Promise<Bytes> {
  if (params.algorithm === "scrypt") return scryptBytes(input, salt, params);
  const key = await crypto.subtle.importKey("raw", input, "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: params.iterations },
    key,
    HASH_BYTES * 8,
  ));
}

function formatParams(params: StoredParams): { name: string; text: string } {
  const keyed = params.keyed ? ",k=1" : "";
  return params.algorithm === "scrypt"
    ? { name: "scrypt", text: `N=${params.N},r=${params.r},p=${params.p}${keyed}` }
    : { name: "pbkdf2-sha256", text: `i=${params.iterations}${keyed}` };
}

function paramMap(text: string): Map<string, number> | null {
  const map = new Map<string, number>();
  for (const part of text.split(",")) {
    const [name, value, extra] = part.split("=");
    if (!name || value === undefined || extra !== undefined || !/^\d{1,9}$/.test(value)) return null;
    map.set(name, Number(value));
  }
  return map;
}

function parseStored(stored: string): { params: StoredParams; salt: Bytes; hash: Bytes } | null {
  if (!stored.startsWith(PASSWORD_HASH_PREFIX)) return null;
  const [algorithm, paramText, saltText, hashText, ...rest] = stored.slice(PASSWORD_HASH_PREFIX.length).split("$");
  if (rest.length > 0 || !algorithm || !paramText || !saltText || !hashText) return null;
  const values = paramMap(paramText);
  const salt = fromBase64Url(saltText);
  const hash = fromBase64Url(hashText);
  if (!values || !salt || !hash || salt.length < 8 || hash.length < 16) return null;
  const keyed = values.get("k") === 1;
  if (algorithm === "pbkdf2-sha256") {
    const iterations = values.get("i");
    if (!iterations || iterations < 1 || iterations > MAX_PBKDF2_ITERATIONS) return null;
    return { params: { algorithm, iterations, keyed }, salt, hash };
  }
  if (algorithm === "scrypt") {
    const N = values.get("N");
    const r = values.get("r");
    const p = values.get("p");
    if (!N || !r || !p || N < 2 || (N & (N - 1)) !== 0 || r > 64 || p > 16) return null;
    if (128 * N * r > MAX_SCRYPT_MEMORY_BYTES) return null;
    return { params: { algorithm, N, r, p, keyed }, salt, hash };
  }
  return null;
}

function sameSpec(params: StoredParams, spec: PasswordHashSpec): boolean {
  if (params.algorithm !== spec.algorithm) return false;
  return params.algorithm === "scrypt" && spec.algorithm === "scrypt"
    ? params.N === spec.N && params.r === spec.r && params.p === spec.p
    : params.algorithm === "pbkdf2-sha256" && spec.algorithm === "pbkdf2-sha256" && params.iterations === spec.iterations;
}

/** A new hash of `password`, in the format and at the cost of `options.spec` (default: this plan's). */
export async function hashPassword(password: string, options: PasswordHashOptions = {}): Promise<string> {
  const spec = options.spec ?? planLimits().password;
  const pepper = await derivePepper(options.pepperKey);
  const params: StoredParams = spec.algorithm === "scrypt"
    ? { algorithm: "scrypt", N: spec.N, r: spec.r, p: spec.p, keyed: pepper !== null }
    : { algorithm: "pbkdf2-sha256", iterations: spec.iterations, keyed: pepper !== null };
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(params, await kdfInput(password, pepper), salt);
  const { name, text } = formatParams(params);
  return `${PASSWORD_HASH_PREFIX}${name}$${text}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/** Whether `stored` is a hash this module (or Better Auth) wrote, whatever its parameters. */
export function isPasswordHash(stored: string): boolean {
  return parseStored(stored) !== null || BETTER_AUTH_HASH.test(stored);
}

/**
 * Checks `password` against `stored`. Better Auth's own scrypt hashes verify
 * with Better Auth's function and always ask for a rewrite.
 */
export async function verifyPassword(stored: string, password: string, options: PasswordHashOptions = {}): Promise<PasswordVerdict> {
  const spec = options.spec ?? planLimits().password;
  const parsed = parseStored(stored);
  if (!parsed) {
    if (!BETTER_AUTH_HASH.test(stored)) return { valid: false, needsRehash: false };
    const valid = await verifyBetterAuthPassword({ hash: stored, password }).catch(() => false);
    return { valid, needsRehash: valid };
  }
  const pepper = await derivePepper(options.pepperKey);
  // A keyed hash needs the key: without it nothing can be proven.
  if (parsed.params.keyed && !pepper) return { valid: false, needsRehash: false };
  const derived = await derive(parsed.params, await kdfInput(password, parsed.params.keyed ? pepper : null), parsed.salt);
  const valid = constantTimeEqual(derived, parsed.hash);
  return {
    valid,
    needsRehash: valid && (!sameSpec(parsed.params, spec) || parsed.params.keyed !== (pepper !== null)),
  };
}
