// VAPID (RFC 8292) keys and Authorization header for Web Push.
// The key pair comes from the master secret, so no new secret is installed.

import { deriveRuntimeSecret } from "@scalius/shared/runtime-secrets";

export type WebPushErrorCode =
  | "invalid_key"
  | "invalid_subscriber_key"
  | "invalid_subject"
  | "payload_too_large"
  | "encryption_failed";

/** Typed failure. The message never contains keys, endpoints or payloads. */
export class WebPushError extends Error {
  constructor(
    readonly code: WebPushErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WebPushError";
  }
}

export interface VapidKeys {
  /** Base64url of the 65-byte uncompressed point. The browser's applicationServerKey. */
  publicKey: string;
  /** ECDSA P-256 signing key. */
  privateKey: CryptoKey;
}

const encoder = new TextEncoder();

/** The P-256 group order. A valid private scalar is in [1, n - 1]. */
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_PRIME = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const P256_GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

const JWT_LIFETIME_SECONDS = 12 * 60 * 60;

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new WebPushError("invalid_key", "Value is not base64url.");
  }
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function validScalar(bytes: Uint8Array): boolean {
  const d = bytesToBigInt(bytes);
  return bytes.length === 32 && d > 0n && d < P256_ORDER;
}

/** PKCS#8 PrivateKeyInfo for a P-256 key that holds only the private scalar. */
function pkcs8FromScalar(d: Uint8Array): Uint8Array {
  const prefix = [
    0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02,
    0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x27, 0x30, 0x25,
    0x02, 0x01, 0x01, 0x04, 0x20,
  ];
  const out = new Uint8Array(prefix.length + 32);
  out.set(prefix);
  out.set(d, prefix.length);
  return out;
}

const mod = (a: bigint, m = P256_PRIME): bigint => ((a % m) + m) % m;

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  for (let e = exponent; e > 0n; e >>= 1n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
  }
  return result;
}

type Jacobian = { x: bigint; y: bigint; z: bigint };

// P-256 has a = -3, which allows the short doubling formula.
function jacobianDouble(p: Jacobian): Jacobian {
  const delta = mod(p.z * p.z);
  const gamma = mod(p.y * p.y);
  const beta = mod(p.x * gamma);
  const alpha = mod(3n * (p.x - delta) * (p.x + delta));
  const x = mod(alpha * alpha - 8n * beta);
  const z = mod((p.y + p.z) ** 2n - gamma - delta);
  const y = mod(alpha * (4n * beta - x) - 8n * gamma * gamma);
  return { x, y, z };
}

/** Adds the generator G (affine) to a point. `null` is the point at infinity. */
function addGenerator(p: Jacobian | null): Jacobian | null {
  if (!p) return { x: P256_GX, y: P256_GY, z: 1n };
  const z1z1 = mod(p.z * p.z);
  const u2 = mod(P256_GX * z1z1);
  const s2 = mod(P256_GY * p.z * z1z1);
  const h = mod(u2 - p.x);
  const r = mod(2n * (s2 - p.y));
  if (h === 0n) return r === 0n ? jacobianDouble(p) : null;
  const hh = mod(h * h);
  const i = mod(4n * hh);
  const j = mod(h * i);
  const v = mod(p.x * i);
  const x = mod(r * r - j - 2n * v);
  const y = mod(r * (v - x) - 2n * p.y * j);
  const z = mod((p.z + h) ** 2n - z1z1 - hh);
  return { x, y, z };
}

/**
 * Computes the public point d * G with BigInt math. Used only if the runtime
 * refuses a PKCS#8 key without a public key. Not constant time, which is fine
 * here: the point is public data and runs once per call.
 */
export function publicPointFromScalar(d: Uint8Array): { x: Uint8Array; y: Uint8Array } {
  if (!validScalar(d)) throw new WebPushError("invalid_key", "Invalid VAPID private scalar.");
  const k = bytesToBigInt(d);
  let acc: Jacobian | null = null;
  for (let bit = 255n; bit >= 0n; bit -= 1n) {
    if (acc) acc = jacobianDouble(acc);
    if ((k >> bit) & 1n) acc = addGenerator(acc);
  }
  if (!acc) throw new WebPushError("invalid_key", "Invalid VAPID private scalar.");
  const zInv = modPow(acc.z, P256_PRIME - 2n);
  const zInv2 = mod(zInv * zInv);
  return {
    x: bigIntToBytes(mod(acc.x * zInv2), 32),
    y: bigIntToBytes(mod(acc.y * zInv2 * zInv), 32),
  };
}

async function scalarFromSecret(masterSecret: string): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const purpose = attempt === 0 ? "web-push-vapid" : `web-push-vapid:${attempt}`;
    const d = base64UrlDecode(await deriveRuntimeSecret(masterSecret, purpose));
    if (validScalar(d)) return d;
  }
  throw new WebPushError("invalid_key", "Could not derive a VAPID private scalar.");
}

/** Imports the scalar as a signing key and returns it with the public point (x, y). */
export async function importVapidScalar(
  d: Uint8Array,
  options: { forceFallback?: boolean } = {},
): Promise<{ privateKey: CryptoKey; x: Uint8Array; y: Uint8Array }> {
  const algorithm = { name: "ECDSA", namedCurve: "P-256" } as const;
  if (!options.forceFallback) {
    try {
      const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        pkcs8FromScalar(d) as BufferSource,
        algorithm,
        true,
        ["sign"],
      );
      const jwk = await crypto.subtle.exportKey("jwk", privateKey);
      if (jwk.x && jwk.y) {
        return { privateKey, x: base64UrlDecode(jwk.x), y: base64UrlDecode(jwk.y) };
      }
    } catch {
      // Fall through to the BigInt path below.
    }
  }
  const { x, y } = publicPointFromScalar(d);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: base64UrlEncode(d),
      x: base64UrlEncode(x),
      y: base64UrlEncode(y),
    },
    algorithm,
    true,
    ["sign"],
  );
  return { privateKey, x, y };
}

/** Derives the deployment's VAPID key pair from the master secret. */
export async function deriveVapidKeys(masterSecret: string): Promise<VapidKeys> {
  const d = await scalarFromSecret(masterSecret);
  const { privateKey, x, y } = await importVapidScalar(d);
  const point = new Uint8Array(65);
  point[0] = 0x04;
  point.set(x, 1);
  point.set(y, 33);
  return { publicKey: base64UrlEncode(point), privateKey };
}

function assertSubject(subject: string): void {
  if (subject.startsWith("mailto:") && subject.length > "mailto:".length) return;
  try {
    if (new URL(subject).protocol === "https:") return;
  } catch {
    // Not a URL.
  }
  throw new WebPushError("invalid_subject", "VAPID subject must be a mailto: or https: URL.");
}

/** Builds the `Authorization: vapid t=<jwt>, k=<key>` header value. */
export async function vapidAuthorization(
  keys: VapidKeys,
  endpoint: string,
  subject: string,
  now: number = Date.now(),
): Promise<string> {
  assertSubject(subject);
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + JWT_LIFETIME_SECONDS,
        sub: subject,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  // WebCrypto ECDSA output is r||s, the form JWS ES256 requires.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    encoder.encode(signingInput),
  );
  return `vapid t=${signingInput}.${base64UrlEncode(new Uint8Array(signature))}, k=${keys.publicKey}`;
}
