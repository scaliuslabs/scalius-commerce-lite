// SHA-256 digests and HMAC-SHA-256 signatures as lowercase hex, through Web
// Crypto (Workers, browsers and Node alike). Text is hashed as UTF-8.

const encoder = new TextEncoder();

/** Bytes as lowercase hex, two digits each. */
export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** SHA-256 of UTF-8 text, or of raw bytes, as lowercase hex. */
export async function sha256Hex(input: string | ArrayBuffer): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", typeof input === "string" ? encoder.encode(input) : input));
}

/** HMAC-SHA-256 of UTF-8 text keyed by the UTF-8 secret, as lowercase hex. */
export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}
