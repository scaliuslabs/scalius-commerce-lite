// Application-level AES-GCM encryption for sensitive credentials stored in D1.

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

/**
 * Try to decrypt. If decryption fails (plaintext data), return as-is.
 * Enables gradual migration from plaintext to encrypted.
 */
export async function decryptCredentialsGraceful(
  value: string,
  keyBase64: string | undefined,
): Promise<string> {
  if (!keyBase64) return value;
  try {
    return await decryptCredentials(value, keyBase64);
  } catch {
    return value; // Not encrypted yet
  }
}
