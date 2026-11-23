// Key material for digital goods (Wave B §3, §11.1).
//
// Durable licence-key material (the dedupe hash and the ciphertext) and an
// order line's delivery message derive only from CREDENTIAL_ENCRYPTION_KEY,
// read strictly: a missing key refuses the import, the reveal and the
// delivery message; it never falls back to SCALIUS_SECRET, whose rotation
// would orphan every stored key. Both are sealed by one envelope (HKDF-SHA256
// per purpose, AES-256-GCM, `v1:<iv>:<sealed>`), each under its own purpose
// key and bound to the row it belongs to. Download tickets are short-lived
// (10 minutes), so they derive from SCALIUS_SECRET.
//
// Nothing here logs, and no plaintext leaves these functions except as the
// return value of a `decrypt`.
import {
    DIGITAL_DOWNLOAD_TICKET_PURPOSE,
    LICENCE_KEY_CIPHER_PURPOSE,
    LICENCE_KEY_HASH_PURPOSE,
    ORDER_LINE_MESSAGE_CIPHER_PURPOSE,
} from "@scalius/shared/digital";
import { deriveRuntimeSecret, readMasterSecret } from "@scalius/shared/runtime-secrets";
import { ServiceUnavailableError } from "@scalius/core/errors";
import { bytesToHex, sha256Hex } from "@scalius/shared/hash";

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

/** The installed CREDENTIAL_ENCRYPTION_KEY as bytes, or a 503 (strict: no fallback). */
function credentialKeyBytes(credentialKey: string | undefined, unavailable: string): Uint8Array<ArrayBuffer> {
    const trimmed = credentialKey?.trim() ?? "";
    if (!trimmed) throw new ServiceUnavailableError(unavailable);
    let bytes: Uint8Array<ArrayBuffer>;
    try {
        bytes = bytesFromBase64(trimmed);
    } catch {
        throw new ServiceUnavailableError(unavailable);
    }
    if (bytes.length < 16) throw new ServiceUnavailableError(unavailable);
    return bytes;
}

async function derivePurposeBits(credentialKey: string | undefined, purpose: string, unavailable = LICENCE_KEYS_UNAVAILABLE): Promise<ArrayBuffer> {
    const ikm = await crypto.subtle.importKey("raw", credentialKeyBytes(credentialKey, unavailable), "HKDF", false, ["deriveBits"]);
    return crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: encoder.encode(HKDF_SALT), info: encoder.encode(purpose) },
        ikm,
        256,
    );
}

/** Seals and opens text under one purpose key; `boundTo` is the AES-GCM associated data (the row the text belongs to). */
export interface SecretSealer {
    encrypt(plaintext: string, boundTo: string): Promise<string>;
    decrypt(ciphertext: string, boundTo: string): Promise<string>;
}

/**
 * The one envelope: AES-256-GCM under the purpose's HKDF key, a fresh 96-bit
 * IV per seal, `v1:<iv>:<sealed>` in base64. A ciphertext copied to another
 * row (other associated data) or sealed under another purpose does not open.
 */
async function secretSealer(credentialKey: string | undefined, purpose: string, words: { unavailable: string; unreadable: string }): Promise<SecretSealer> {
    const { unreadable } = words;
    const aesKey = await crypto.subtle.importKey("raw", await derivePurposeBits(credentialKey, purpose, words.unavailable), "AES-GCM", false, ["encrypt", "decrypt"]);
    return {
        async encrypt(plaintext, boundTo) {
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const sealed = await crypto.subtle.encrypt(
                { name: "AES-GCM", iv, additionalData: encoder.encode(boundTo) },
                aesKey,
                encoder.encode(plaintext),
            );
            return `v1:${base64FromBytes(iv)}:${base64FromBytes(new Uint8Array(sealed))}`;
        },
        async decrypt(ciphertext, boundTo) {
            const [version, ivB64, sealedB64] = ciphertext.split(":");
            if (version !== "v1" || !ivB64 || !sealedB64) throw new ServiceUnavailableError(unreadable);
            try {
                const plain = await crypto.subtle.decrypt(
                    { name: "AES-GCM", iv: bytesFromBase64(ivB64), additionalData: encoder.encode(boundTo) },
                    aesKey,
                    bytesFromBase64(sealedB64),
                );
                return new TextDecoder().decode(plain);
            } catch {
                throw new ServiceUnavailableError(unreadable);
            }
        },
    };
}

/** The two durable keys a pool operation needs, derived once per request. */
export interface LicenceKeyCrypto extends SecretSealer {
    hash(key: string): Promise<string>;
}

/**
 * Hash (HMAC-SHA256, dedupe per pool) and seal (the envelope, with the asset
 * id as associated data, so a ciphertext copied to another pool does not open)
 * licence keys. Throws a 503 when CREDENTIAL_ENCRYPTION_KEY is missing.
 */
export async function licenceKeyCrypto(credentialKey: string | undefined): Promise<LicenceKeyCrypto> {
    const [hashBits, sealer] = await Promise.all([
        derivePurposeBits(credentialKey, LICENCE_KEY_HASH_PURPOSE),
        secretSealer(credentialKey, LICENCE_KEY_CIPHER_PURPOSE, { unavailable: LICENCE_KEYS_UNAVAILABLE, unreadable: "A licence key could not be read." }),
    ]);
    const hmacKey = await crypto.subtle.importKey("raw", hashBits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return {
        async hash(key) {
            const mac = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(key.normalize("NFC").trim()));
            return bytesToHex(mac);
        },
        encrypt: sealer.encrypt,
        decrypt: sealer.decrypt,
    };
}

/** Raised (as a 503) when a delivery message cannot be sealed or opened. */
export const ORDER_LINE_MESSAGES_UNAVAILABLE = "Delivery messages are unavailable: the credential encryption key is not configured.";

/**
 * Seals an order line's delivery message (text and link, one plaintext) with
 * the licence keys' envelope under its own purpose key, bound to the message
 * row and its order line (`orderLineMessageBinding`). Throws a 503 when
 * CREDENTIAL_ENCRYPTION_KEY is missing.
 */
export function orderLineMessageCrypto(credentialKey: string | undefined): Promise<SecretSealer> {
    return secretSealer(credentialKey, ORDER_LINE_MESSAGE_CIPHER_PURPOSE, { unavailable: ORDER_LINE_MESSAGES_UNAVAILABLE, unreadable: "A delivery message could not be read." });
}

/** The associated data of a message: its row and its line, so a ciphertext moved to another row or line does not open. */
export function orderLineMessageBinding(messageId: string, orderItemId: string): string {
    return `${messageId}\u0000${orderItemId}`;
}

// ---------------------------------------------------------------------------
// Download tickets

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
