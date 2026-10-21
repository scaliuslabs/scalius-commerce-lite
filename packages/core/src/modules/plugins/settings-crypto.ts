// Sealing of plugin `secret` settings. The key is HKDF-derived from the
// installed CREDENTIAL_ENCRYPTION_KEY for this one purpose (the gift-card and
// licence-key pattern), never from SCALIUS_SECRET, so rotating the master
// secret orphans nothing. AES-256-GCM with the plugin id and setting key as
// associated data: a ciphertext copied to another plugin or field does not
// open. Read strictly: a missing key fails closed, never falls back.

import { PluginError } from "./errors";

const HKDF_SALT = "scalius-commerce/plugin-settings/v1";
const HKDF_PURPOSE = "plugin-settings-secret";
export const PLUGIN_SECRET_PREFIX = "ps1:";
const IV_BYTES = 12;
const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function associatedData(pluginId: string, field: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${HKDF_PURPOSE}\u0000${pluginId}\u0000${field}`);
}

/** The settings key for one request; throws `settings_key_unavailable` without the installed key. */
export async function derivePluginSettingsKey(credentialEncryptionKey: string | null | undefined): Promise<CryptoKey> {
  const material = typeof credentialEncryptionKey === "string" ? credentialEncryptionKey.trim() : "";
  if (material.length < 16) {
    throw new PluginError(
      "settings_key_unavailable",
      "Plugin secrets are unavailable: the credential encryption key is not configured.",
    );
  }
  const ikm = await crypto.subtle.importKey("raw", encoder.encode(material), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(HKDF_SALT), info: encoder.encode(HKDF_PURPOSE) },
    ikm,
    256,
  );
  return crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function isSealedPluginSecret(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PLUGIN_SECRET_PREFIX) && value.split(":").length === 3;
}

export async function sealPluginSecret(key: CryptoKey, pluginId: string, field: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associatedData(pluginId, field) },
    key,
    encoder.encode(plaintext),
  );
  return `${PLUGIN_SECRET_PREFIX}${base64Url(iv)}:${base64Url(new Uint8Array(sealed))}`;
}

/** The plaintext, or null when the ciphertext is malformed, moved or sealed under another key. */
export async function openPluginSecret(key: CryptoKey, pluginId: string, field: string, ciphertext: string): Promise<string | null> {
  if (!isSealedPluginSecret(ciphertext)) return null;
  const [, ivPart, sealedPart] = ciphertext.split(":");
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(ivPart!), additionalData: associatedData(pluginId, field) },
      key,
      fromBase64Url(sealedPart!),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
