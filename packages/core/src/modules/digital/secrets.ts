// Key material for digital goods (Wave B §3, §11.1).
//
// Durable licence-key material (the dedupe hash and the ciphertext) derives
// only from CREDENTIAL_ENCRYPTION_KEY, read strictly: a missing key refuses
// the import, the reveal and the delivery message; it never falls back to
// SCALIUS_SECRET, whose rotation would orphan every stored key. Download
// tickets are short-lived (10 minutes), so they derive from SCALIUS_SECRET.
//
// Nothing here logs, and no plaintext key leaves these functions except as the
// return value of `decryptLicenceKey`.
import {
    DIGITAL_DOWNLOAD_TICKET_PURPOSE,
    LICENCE_KEY_CIPHER_PURPOSE,
    LICENCE_KEY_HASH_PURPOSE,
} from "@scalius/shared/digital";
import { deriveRuntimeSecret, readMasterSecret } from "@scalius/shared/runtime-secrets";
import { ServiceUnavailableError } from "@scalius/core/errors";

const encoder = new TextEncoder();
const HKDF_SALT = "scalius-commerce/digital-goods/v1";

/** Raised (as a 503) when the durable key is missing or unusable. */
export const LICENCE_KEYS_UNAVAILABLE = "Licence keys are unavailable: the credential encryption key is not configured.";

function bytesFromBase64(value: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function base64FromBytes(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function base64Url(bytes: Uint8Array): string {
    return base64FromBytes(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function hex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The installed CREDENTIAL_ENCRYPTION_KEY as bytes, or a 503 (strict: no fallback). */
function credentialKeyBytes(credentialKey: string | undefined): Uint8Array<ArrayBuffer> {
    const trimmed = credentialKey?.trim() ?? "";
    if (!trimmed) throw new ServiceUnavailableError(LICENCE_KEYS_UNAVAILABLE);
    let bytes: Uint8Array<ArrayBuffer>;
    try {
        bytes = bytesFromBase64(trimmed);
    } catch {
        throw new ServiceUnavailableError(LICENCE_KEYS_UNAVAILABLE);
    }
    if (bytes.length < 16) throw new ServiceUnavailableError(LICENCE_KEYS_UNAVAILABLE);
    return bytes;
}

async function derivePurposeBits(credentialKey: string | undefined, purpose: string): Promise<ArrayBuffer> {
    const ikm = await crypto.subtle.importKey("raw", credentialKeyBytes(credentialKey), "HKDF", false, ["deriveBits"]);
    return crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: encoder.encode(HKDF_SALT), info: encoder.encode(purpose) },
        ikm,
        256,
    );
}

/** The two durable keys a pool operation needs, derived once per request. */
export interface LicenceKeyCrypto {
    hash(key: string): Promise<string>;
    encrypt(key: string, assetId: string): Promise<string>;
    decrypt(ciphertext: string, assetId: string): Promise<string>;
}

/**
 * Hash (HMAC-SHA256, dedupe per pool) and seal (AES-256-GCM with the asset id
 * as associated data, so a ciphertext copied to another pool does not open)
 * licence keys. Throws a 503 when CREDENTIAL_ENCRYPTION_KEY is missing.
 */
export async function licenceKeyCrypto(credentialKey: string | undefined): Promise<LicenceKeyCrypto> {
    const [hashBits, cipherBits] = await Promise.all([
        derivePurposeBits(credentialKey, LICENCE_KEY_HASH_PURPOSE),
        derivePurposeBits(credentialKey, LICENCE_KEY_CIPHER_PURPOSE),
    ]);
    const hmacKey = await crypto.subtle.importKey("raw", hashBits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const aesKey = await crypto.subtle.importKey("raw", cipherBits, "AES-GCM", false, ["encrypt", "decrypt"]);
    return {
        async hash(key) {
            const mac = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(key.normalize("NFC").trim()));
            return hex(new Uint8Array(mac));
        },
        async encrypt(key, assetId) {
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const sealed = await crypto.subtle.encrypt(
                { name: "AES-GCM", iv, additionalData: encoder.encode(assetId) },
                aesKey,
                encoder.encode(key),
            );
            return `v1:${base64FromBytes(iv)}:${base64FromBytes(new Uint8Array(sealed))}`;
        },
        async decrypt(ciphertext, assetId) {
            const [version, ivB64, sealedB64] = ciphertext.split(":");
            if (version !== "v1" || !ivB64 || !sealedB64) {
                throw new ServiceUnavailableError("A licence key could not be read.");
            }
            try {
                const plain = await crypto.subtle.decrypt(
                    { name: "AES-GCM", iv: bytesFromBase64(ivB64), additionalData: encoder.encode(assetId) },
                    aesKey,
                    bytesFromBase64(sealedB64),
                );
                return new TextDecoder().decode(plain);
            } catch {
                throw new ServiceUnavailableError("A licence key could not be read.");
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Download tickets

async function sha256Hex(value: string): Promise<string> {
    return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function ticketHmacKey(env: { SCALIUS_SECRET?: unknown }): Promise<CryptoKey> {
    const master = readMasterSecret(env);
    if (!master) throw new ServiceUnavailableError("Downloads are unavailable right now.");
    const secret = await deriveRuntimeSecret(master, DIGITAL_DOWNLOAD_TICKET_PURPOSE);
    return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/**
 * `sig` = HMAC-SHA256(key from SCALIUS_SECRET, `entitlementId|exp|sha256(proof)`),
 * base64url. `proof` is the buyer's session token or receipt proof, read from
 * the httpOnly cookie by the storefront: a URL without that cookie is useless.
 */
export async function signDownloadTicket(
    env: { SCALIUS_SECRET?: unknown },
    input: { entitlementId: string; expiresAt: number; proof: string },
): Promise<string> {
    const key = await ticketHmacKey(env);
    const message = `${input.entitlementId}|${input.expiresAt}|${await sha256Hex(input.proof)}`;
    return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))));
}

/** Constant-time check of a ticket signature for this proof. */
export async function verifyDownloadTicketSignature(
    env: { SCALIUS_SECRET?: unknown },
    input: { entitlementId: string; expiresAt: number; proof: string; signature: string },
): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.signature)) return false;
    const expected = await signDownloadTicket(env, input);
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1) {
        difference |= expected.charCodeAt(index) ^ input.signature.charCodeAt(index);
    }
    return difference === 0;
}
