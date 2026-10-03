// RSA as Nagad's envelope uses it: PKCS#1 v1.5 encryption
// (RSA/ECB/PKCS1Padding) for `sensitiveData` and SHA256withRSA
// (RSASSA-PKCS1-v1_5) signatures.
//
// Web Crypto signs and verifies RSASSA-PKCS1-v1_5 natively, but it has no
// PKCS#1 v1.5 encryption, and the plugin runs in a Worker sandbox without
// `node:crypto`. So the keys are imported with Web Crypto (which validates
// them), their numbers are read back through a JWK export, and the two
// encryption operations are done here with BigInt arithmetic (RFC 8017,
// sections 7.2.1 and 7.2.2).

const RSASSA_SHA256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** Nagad's messages are about 200 bytes; a key below 2048 bits cannot carry them in one block. */
export const MIN_MODULUS_BITS = 2048;

/** PKCS#1 v1.5 type 2 padding: 0x00 0x02, at least 8 random non-zero bytes, 0x00, then the message. */
const PADDING_OVERHEAD = 11;
const MIN_PADDING_STRING = 8;

export type RsaErrorReason =
  | "unreadable"
  /** A PKCS#1 (`BEGIN RSA ...`) key where PKCS#8 or SPKI is expected. */
  | "pkcs1"
  | "too_small"
  | "message_too_long"
  | "decryption_failed";

export class RsaError extends Error {
  readonly reason: RsaErrorReason;

  constructor(reason: RsaErrorReason, message: string) {
    super(message);
    this.name = "RsaError";
    this.reason = reason;
  }
}

export interface RsaPublicNumbers {
  readonly modulus: bigint;
  readonly exponent: bigint;
  /** The modulus length in bytes (k): every block is exactly this long. */
  readonly length: number;
}

/** The CRT form of a private key: two half-size exponentiations instead of one full one. */
export interface RsaPrivateNumbers extends RsaPublicNumbers {
  readonly p: bigint;
  readonly q: bigint;
  readonly dp: bigint;
  readonly dq: bigint;
  readonly qi: bigint;
}

export interface RsaPublicKey extends RsaPublicNumbers {
  readonly verifyKey: CryptoKey;
}

export interface RsaPrivateKey extends RsaPrivateNumbers {
  readonly signKey: CryptoKey;
}

// ── Encoding ────────────────────────────────────────────────────────────────

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Standard base64; whitespace (line breaks in pasted keys or wrapped answers) is ignored. */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const compact = text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) throw new RsaError("unreadable", "The value is not base64.");
  let binary: string;
  try {
    binary = atob(compact);
  } catch {
    throw new RsaError("unreadable", "The value is not base64.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt(`0x${bytesToHex(bytes)}`);
}

/** Big-endian, left-padded to exactly `length` bytes (I2OSP). */
function bigIntToBytes(value: bigint, length: number): Uint8Array<ArrayBuffer> {
  const hex = value.toString(16).padStart(length * 2, "0");
  if (hex.length > length * 2) throw new RsaError("decryption_failed", "The integer is too large for the block.");
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function byteLength(value: bigint): number {
  return Math.ceil(value.toString(16).length / 2);
}

// ── Arithmetic ──────────────────────────────────────────────────────────────

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let square = base % modulus;
  let remaining = exponent;
  while (remaining > 0n) {
    if ((remaining & 1n) === 1n) result = (result * square) % modulus;
    square = (square * square) % modulus;
    remaining >>= 1n;
  }
  return result;
}

/** m = c^d mod n through the Chinese remainder theorem (RFC 8017, 5.1.2). */
function privateOperation(key: RsaPrivateNumbers, ciphertext: bigint): bigint {
  const modP = modPow(ciphertext, key.dp, key.p);
  const modQ = modPow(ciphertext, key.dq, key.q);
  const difference = (key.qi * (modP - modQ)) % key.p;
  const h = difference < 0n ? difference + key.p : difference;
  return modQ + h * key.q;
}

function nonZeroRandomBytes(count: number): Uint8Array<ArrayBuffer> {
  const bytes = crypto.getRandomValues(new Uint8Array(count));
  const spare = new Uint8Array(1);
  for (let index = 0; index < count; index += 1) {
    while (bytes[index] === 0) bytes[index] = crypto.getRandomValues(spare)[0]!;
  }
  return bytes;
}

// ── PKCS#1 v1.5 encryption ──────────────────────────────────────────────────

/** RSAES-PKCS1-v1_5 encryption: what `Cipher.getInstance("RSA/ECB/PKCS1Padding")` produces. */
export function encryptPkcs1v15(key: RsaPublicNumbers, message: Uint8Array): Uint8Array<ArrayBuffer> {
  const length = key.length;
  if (message.length > length - PADDING_OVERHEAD) {
    throw new RsaError("message_too_long", `The message is longer than ${length - PADDING_OVERHEAD} bytes.`);
  }
  const block = new Uint8Array(length);
  block[1] = 0x02;
  block.set(nonZeroRandomBytes(length - message.length - 3), 2);
  // block[length - message.length - 1] stays 0x00: the separator.
  block.set(message, length - message.length);
  return bigIntToBytes(modPow(bytesToBigInt(block), key.exponent, key.modulus), length);
}

/**
 * RSAES-PKCS1-v1_5 decryption with strict padding checks. Every failure is
 * the same error, so a caller cannot tell which check failed.
 */
export function decryptPkcs1v15(key: RsaPrivateNumbers, ciphertext: Uint8Array): Uint8Array<ArrayBuffer> {
  const failed = () => new RsaError("decryption_failed", "The ciphertext does not decrypt with this key.");
  if (ciphertext.length !== key.length) throw failed();
  const value = bytesToBigInt(ciphertext);
  if (value >= key.modulus) throw failed();
  const block = bigIntToBytes(privateOperation(key, value), key.length);
  if (block[0] !== 0x00 || block[1] !== 0x02) throw failed();
  const separator = block.indexOf(0x00, 2);
  if (separator < 2 + MIN_PADDING_STRING) throw failed();
  return block.slice(separator + 1);
}

// ── Signatures ──────────────────────────────────────────────────────────────

/** SHA256withRSA. */
export async function signSha256(key: RsaPrivateKey, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.sign(RSASSA_SHA256, key.signKey, data));
}

export async function verifySha256(key: RsaPublicKey, signature: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<boolean> {
  return crypto.subtle.verify(RSASSA_SHA256, key.verifyKey, signature, data);
}

// ── Keys ────────────────────────────────────────────────────────────────────

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/;

/**
 * The DER bytes of a pasted key: a PEM block with the expected label, or the
 * bare base64 body. Keys copied out of env files sometimes carry literal
 * `\n` escapes; base64 has no backslash, so they are safe to drop.
 */
function derOf(text: string, label: "PUBLIC KEY" | "PRIVATE KEY"): Uint8Array<ArrayBuffer> {
  const unescaped = text.replace(/\\[rn]/g, "\n");
  const block = PEM_BLOCK.exec(unescaped);
  if (block && block[1] !== label) {
    const pkcs1 = block[1] === `RSA ${label}`;
    throw new RsaError(pkcs1 ? "pkcs1" : "unreadable", `Expected a ${label} block, got ${pkcs1 ? "a PKCS#1 key" : "another kind of PEM block"}.`);
  }
  return base64ToBytes(block ? block[2]! : unescaped);
}

function jwkInteger(value: string | undefined): bigint {
  if (!value) throw new RsaError("unreadable", "The key is missing an RSA parameter.");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return bytesToBigInt(base64ToBytes(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
}

function publicNumbersOf(jwk: JsonWebKey): RsaPublicNumbers {
  const modulus = jwkInteger(jwk.n);
  if (modulus.toString(2).length < MIN_MODULUS_BITS) {
    throw new RsaError("too_small", `The key is shorter than ${MIN_MODULUS_BITS} bits.`);
  }
  return { modulus, exponent: jwkInteger(jwk.e), length: byteLength(modulus) };
}

async function importOrFail(work: () => Promise<CryptoKey>): Promise<CryptoKey> {
  try {
    return await work();
  } catch {
    throw new RsaError("unreadable", "The key is not a valid RSA key.");
  }
}

/** An X.509 SubjectPublicKeyInfo key (`-----BEGIN PUBLIC KEY-----`), with or without its PEM lines. */
export async function importRsaPublicKey(text: string): Promise<RsaPublicKey> {
  const der = derOf(text, "PUBLIC KEY");
  const verifyKey = await importOrFail(() => crypto.subtle.importKey("spki", der, RSASSA_SHA256, true, ["verify"]));
  const jwk = await crypto.subtle.exportKey("jwk", verifyKey);
  return { ...publicNumbersOf(jwk), verifyKey };
}

/** A PKCS#8 key (`-----BEGIN PRIVATE KEY-----`), with or without its PEM lines. */
export async function importRsaPrivateKey(text: string): Promise<RsaPrivateKey> {
  const der = derOf(text, "PRIVATE KEY");
  const signKey = await importOrFail(() => crypto.subtle.importKey("pkcs8", der, RSASSA_SHA256, true, ["sign"]));
  const jwk = await crypto.subtle.exportKey("jwk", signKey);
  // Multi-prime keys need more than the two-prime CRT above.
  if (jwk.oth) throw new RsaError("unreadable", "Multi-prime RSA keys are not supported.");
  return {
    ...publicNumbersOf(jwk),
    p: jwkInteger(jwk.p),
    q: jwkInteger(jwk.q),
    dp: jwkInteger(jwk.dp),
    dq: jwkInteger(jwk.dq),
    qi: jwkInteger(jwk.qi),
    signKey,
  };
}
