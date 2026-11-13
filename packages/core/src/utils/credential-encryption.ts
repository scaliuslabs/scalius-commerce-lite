// Application-level AES-GCM encryption for sensitive credentials stored in D1.
//
// Two stored formats:
//
//   v1  `enc:<iv>:<ciphertext>`        AES-256-GCM under the installed key itself,
//                                      no associated data. Still read; written
//                                      only by callers that have not moved to v2.
//   v2  `v2:<key id>:<iv>:<ciphertext>` AES-256-GCM under a subkey derived
//                                      (HKDF) from an installed key for this
//                                      purpose only, with associated data naming
//                                      the value's owner (table, row, field): a
//                                      ciphertext moved to another row or field
//                                      does not decrypt. The key id says which
//                                      installed key wrote it, so a second key
//                                      can be installed beside the first and
//                                      values move to it as they are saved.
//
// Keys are passed as a `CredentialKeys` ring: the first writes, every one
// reads. Today the ring is the one installed CREDENTIAL_ENCRYPTION_KEY.

import { bytesToHex, hmacSha256Hex } from "@scalius/shared/hash";

export const ENCRYPTED_CREDENTIAL_PREFIX = "enc:";

/** The installed credential keys (base64), the writing key first. */
export type CredentialKeys = string | readonly string[];

/** Whose value a v2 ciphertext is: it decrypts only for the same owner. */
export interface CredentialOwner {
  table: string;
  row: string;
  field: string;
}

const V2_PREFIX = "v2:";
const SUBKEY_SALT = "scalius-commerce/credential-keys/v2";
const V2_FORMAT = /^v2:([0-9a-f]{8}):([A-Za-z0-9+/]{16}):([A-Za-z0-9+/]+={0,2})$/;
const encoder = new TextEncoder();

/** The purposes an installed credential key is used for, each under its own subkey. */
export type CredentialKeyPurpose = "credential-encryption" | "otp-hmac" | "otp-rate-limit" | "key-id";

function keyList(keys: CredentialKeys | undefined): string[] {
  return (typeof keys === "string" ? [keys] : [...(keys ?? [])]).map((key) => key.trim()).filter(Boolean);
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

function bytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * 32 bytes derived (HKDF-SHA256) from an installed key for one purpose. The
 * key's text is the input keying material, so any installed value works.
 */
export async function deriveCredentialSubkey(installedKey: string, purpose: CredentialKeyPurpose): Promise<Uint8Array<ArrayBuffer>> {
  const root = await crypto.subtle.importKey("raw", encoder.encode(installedKey.trim()), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(SUBKEY_SALT), info: encoder.encode(purpose) },
    root,
    256,
  );
  return new Uint8Array(bits);
}

/** Whether an installed key can write: base64 (padded or not) of at least 16 bytes, as the pepper requires. */
function isUsableCredentialKey(key: string): boolean {
  try {
    return base64Bytes(key).length >= 16;
  } catch {
    return false;
  }
}

/** An installed key's id: 8 hex digits, derived, so it reveals nothing of the key. */
export async function credentialKeyId(keyBase64: string): Promise<string> {
  return bytesToHex(await deriveCredentialSubkey(keyBase64, "key-id")).slice(0, 8);
}

/**
 * HMAC-SHA256 (hex) under the installed key's OTP subkey: code and identifier
 * hashes for one-time codes. Never the encryption key's own bytes.
 */
export async function otpHmacSha256Hex(keyBase64: string, message: string): Promise<string> {
  return hmacSha256Hex(bytesToHex(await deriveCredentialSubkey(keyBase64, "otp-hmac")), message);
}

/** HMAC-SHA256 (hex) under the installed key's rate-limit subkey: one-time-code limiter subjects. */
export async function rateLimitHmacSha256Hex(installedKey: string, message: string): Promise<string> {
  return hmacSha256Hex(bytesToHex(await deriveCredentialSubkey(installedKey, "otp-rate-limit")), message);
}

function ownerData(owner: CredentialOwner): Uint8Array<ArrayBuffer> {
  return encoder.encode(`scalius-credential\0${owner.table}\0${owner.row}\0${owner.field}`);
}

async function encryptionKey(keyBase64: string, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await deriveCredentialSubkey(keyBase64, "credential-encryption"), "AES-GCM", false, [usage]);
}

/** Whether a stored value is a v2 envelope. */
export function isCredentialEnvelopeV2(value: string): boolean {
  return V2_FORMAT.test(value.trim());
}

/** The id of the key that wrote a v2 envelope, or null for anything else. */
export function credentialEnvelopeKeyId(value: string): string | null {
  return V2_FORMAT.exec(value.trim())?.[1] ?? null;
}

/** Encrypts a credential for its owner under the writing key: `v2:<key id>:<iv>:<ciphertext>`. */
export async function encryptCredential(
  plaintext: string | Uint8Array<ArrayBuffer>,
  keys: CredentialKeys,
  owner: CredentialOwner,
): Promise<string> {
  const [writer] = keyList(keys);
  if (!writer) throw new Error("No credential key is installed");
  // The same rule as the password pepper: any base64 of 16 bytes or more. The
  // subkey is derived from the key's text, so its length is not the AES key's.
  if (!isUsableCredentialKey(writer)) {
    throw new Error("The installed credential key is not base64 of at least 16 bytes");
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: ownerData(owner) },
    await encryptionKey(writer, "encrypt"),
    typeof plaintext === "string" ? encoder.encode(plaintext) : plaintext,
  );
  return `${V2_PREFIX}${await credentialKeyId(writer)}:${bytesBase64(iv)}:${bytesBase64(new Uint8Array(ciphertext))}`;
}

/** The bytes a v2 envelope holds, for its owner only (a value encrypted as bytes, not text). */
export async function decryptCredentialBytes(stored: string, keys: CredentialKeys, owner: CredentialOwner): Promise<Uint8Array> {
  const v2 = V2_FORMAT.exec(stored.trim());
  if (!v2) throw new Error("Not a v2 credential envelope");
  const [, keyId, iv, ciphertext] = v2;
  for (const key of keyList(keys)) {
    if (await credentialKeyId(key) !== keyId) continue;
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64Bytes(iv!), additionalData: ownerData(owner) },
      await encryptionKey(key, "decrypt"),
      base64Bytes(ciphertext!),
    ));
  }
  throw new Error("No installed key has this credential's key id");
}

/**
 * Decrypts a stored credential: a v2 envelope with the installed key its id
 * names, for this owner only; a v1 value with each installed key in turn.
 */
export async function decryptCredential(
  stored: string,
  keys: CredentialKeys,
  owner: CredentialOwner | undefined,
): Promise<string> {
  const value = stored.trim();
  const ring = keyList(keys);
  if (V2_FORMAT.test(value)) {
    if (!owner) throw new Error("A v2 credential needs its owner to decrypt");
    return new TextDecoder().decode(await decryptCredentialBytes(value, keys, owner));
  }
  const v1 = value.startsWith(ENCRYPTED_CREDENTIAL_PREFIX) ? value.slice(ENCRYPTED_CREDENTIAL_PREFIX.length) : value;
  let failure: unknown = new Error("No credential key is installed");
  for (const key of ring) {
    try {
      return await decryptCredentials(v1, key);
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns base64-encoded "iv:ciphertext" string.
 */
export async function encryptCredentials(
  plaintext: string,
  keyBase64: string,
): Promise<string> {
  const keyBytes = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );
  const ivB64 = btoa(String.fromCharCode(...iv));
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
  return `${ivB64}:${ctB64}`;
}

/**
 * Decrypt an "iv:ciphertext" string using AES-256-GCM.
 */
export async function decryptCredentials(
  encrypted: string,
  keyBase64: string,
): Promise<string> {
  const [ivB64, ctB64] = encrypted.split(":");
  if (!ivB64 || !ctB64) throw new Error("Invalid encrypted format");
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(ctB64), (c) => c.charCodeAt(0));
  const keyBytes = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

export interface StrictCredentialReadResult {
  value: string;
  encrypted: boolean;
  error: string | null;
}

export function encodeEncryptedCredential(encrypted: string): string {
  return encrypted.startsWith(ENCRYPTED_CREDENTIAL_PREFIX)
    ? encrypted
    : `${ENCRYPTED_CREDENTIAL_PREFIX}${encrypted}`;
}

export function isLikelyEncryptedCredential(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith(ENCRYPTED_CREDENTIAL_PREFIX) || isCredentialEnvelopeV2(trimmed)) return true;

  const [iv, ciphertext, extra] = trimmed.split(":");
  if (!iv || !ciphertext || extra !== undefined) return false;
  return iv.length === 16 && ciphertext.length >= 24 && isBase64ish(iv) && isBase64ish(ciphertext);
}

/**
 * Reads a stored credential that may be plain text (legacy), v1 or v2. A
 * failure is reported, never thrown, and never contains credential material.
 * Pass the owner to read v2 envelopes.
 */
export async function readStoredCredentialStrict(
  storedValue: string | null | undefined,
  keys: CredentialKeys | undefined,
  label = "Credential",
  owner?: CredentialOwner,
): Promise<StrictCredentialReadResult> {
  const trimmed = storedValue?.trim() ?? "";
  if (!trimmed) {
    return { value: "", encrypted: false, error: null };
  }

  if (!isLikelyEncryptedCredential(trimmed)) {
    return { value: trimmed, encrypted: false, error: null };
  }

  if (keyList(keys).length === 0) {
    return {
      value: "",
      encrypted: true,
      error: `${label} is encrypted but CREDENTIAL_ENCRYPTION_KEY is not configured.`,
    };
  }

  try {
    return {
      value: await decryptCredential(trimmed, keys!, owner),
      encrypted: true,
      error: null,
    };
  } catch {
    return {
      value: "",
      encrypted: true,
      error: `${label} could not be decrypted with the configured credential key.`,
    };
  }
}

function isBase64ish(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}
