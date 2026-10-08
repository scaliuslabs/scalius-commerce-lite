// RFC 8291 Web Push message encryption with the aes128gcm coding of RFC 8188.

import { base64UrlDecode, WebPushError } from "./vapid";

const encoder = new TextEncoder();
const DEFAULT_RECORD_SIZE = 4096;
const HEADER_LENGTH = 16 + 4 + 1 + 65;
const GCM_TAG_LENGTH = 16;
/** One record: the delimiter byte plus the GCM tag. */
const RECORD_OVERHEAD = 1 + GCM_TAG_LENGTH;
/** Push services must accept 4,096 bytes of body, so the header counts against it. */
export const MAX_WEB_PUSH_PLAINTEXT = DEFAULT_RECORD_SIZE - HEADER_LENGTH - RECORD_OVERHEAD;

export interface WebPushKeys {
  /** Base64url of the browser's 65-byte public key. */
  p256dh: string;
  /** Base64url of the 16-byte auth secret. */
  auth: string;
}

export interface EncryptOptions {
  /** Test hook. Defaults to 16 random bytes. */
  salt?: Uint8Array;
  /** Test hook. Defaults to a fresh ephemeral key pair. */
  localKeyPair?: CryptoKeyPair;
  recordSize?: number;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function encryptWebPushPayload(
  keys: WebPushKeys,
  plaintext: Uint8Array,
  options: EncryptOptions = {},
): Promise<Uint8Array> {
  const uaPublic = base64UrlDecode(keys.p256dh);
  const authSecret = base64UrlDecode(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new WebPushError("invalid_key", "Subscription p256dh must be a 65-byte uncompressed point.");
  }
  if (authSecret.length !== 16) {
    throw new WebPushError("invalid_key", "Subscription auth must be 16 bytes.");
  }
  const recordSize = options.recordSize ?? DEFAULT_RECORD_SIZE;
  if (!Number.isInteger(recordSize) || recordSize <= RECORD_OVERHEAD || recordSize > 0xffffffff) {
    throw new WebPushError("encryption_failed", "Invalid record size.");
  }
  if (plaintext.length > Math.min(MAX_WEB_PUSH_PLAINTEXT, recordSize - RECORD_OVERHEAD)) {
    throw new WebPushError("payload_too_large", "Push payload is too large.");
  }
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new WebPushError("encryption_failed", "Salt must be 16 bytes.");

  try {
    const localKeyPair =
      options.localKeyPair ??
      ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits",
      ])) as CryptoKeyPair);
    const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", localKeyPair.publicKey));
    const uaKey = await crypto.subtle.importKey(
      "raw",
      uaPublic as BufferSource,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const ecdhSecret = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, localKeyPair.privateKey, 256),
    );

    const keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic);
    const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
    const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

    // One record only, so it carries the 0x02 "last record" delimiter.
    const record = concat(plaintext, new Uint8Array([0x02]));
    const aesKey = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, [
      "encrypt",
    ]);
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
        aesKey,
        record as BufferSource,
      ),
    );

    const header = new Uint8Array(HEADER_LENGTH);
    header.set(salt, 0);
    new DataView(header.buffer).setUint32(16, recordSize, false);
    header[20] = asPublic.length;
    header.set(asPublic, 21);
    return concat(header, cipher);
  } catch (error) {
    if (error instanceof WebPushError) throw error;
    throw new WebPushError("encryption_failed", "Could not encrypt the push payload.");
  }
}
