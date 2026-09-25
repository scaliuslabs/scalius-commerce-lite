// Gift-card code material (Wave B §4.1, §14 decisions 10-11). A code is found
// by an HMAC of its canonical form (`code_hash`, unique) and shown again from
// an AES-GCM ciphertext. Both keys are HKDF-derived from the installed
// CREDENTIAL_ENCRYPTION_KEY, never SCALIUS_SECRET: rotating the master secret
// must not orphan a single live card. The key is read strictly: a missing key
// means "gift cards are unavailable", never a weaker fallback.
import {
    GIFT_CARD_CODE_CIPHER_PURPOSE,
    GIFT_CARD_CODE_HASH_PURPOSE,
    generateGiftCardCode,
    normalizeGiftCardCode,
} from "@scalius/shared/gift-card-code";
import { ServiceUnavailableError } from "../../errors";

const HKDF_SALT = "scalius-commerce/gift-cards/v1";
const CIPHERTEXT_VERSION = "gc1";
const IV_BYTES = 12;
const encoder = new TextEncoder();

/** The one message every surface shows when the durable key is missing. */
export const GIFT_CARDS_UNAVAILABLE_MESSAGE = "Gift cards are unavailable right now.";

export class GiftCardsUnavailableError extends ServiceUnavailableError {
    constructor() {
        super(GIFT_CARDS_UNAVAILABLE_MESSAGE);
        this.name = "GiftCardsUnavailableError";
    }
}

/** The installed CREDENTIAL_ENCRYPTION_KEY, or a fail-closed error. */
export function requireGiftCardKey(credentialEncryptionKey: string | null | undefined): string {
    const key = typeof credentialEncryptionKey === "string" ? credentialEncryptionKey.trim() : "";
    if (key.length < 16) throw new GiftCardsUnavailableError();
    return key;
}

async function hkdfBits(credentialEncryptionKey: string, purpose: string): Promise<ArrayBuffer> {
    const material = await crypto.subtle.importKey(
        "raw",
        encoder.encode(requireGiftCardKey(credentialEncryptionKey)),
        "HKDF",
        false,
        ["deriveBits"],
    );
    return crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: encoder.encode(HKDF_SALT), info: encoder.encode(purpose) },
        material,
        256,
    );
}

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

/** One set of derived keys for a batch of operations (derive once per request). */
export interface GiftCardKeys {
    hashKey: CryptoKey;
    cipherKey: CryptoKey;
}

export async function deriveGiftCardKeys(credentialEncryptionKey: string | null | undefined): Promise<GiftCardKeys> {
    const key = requireGiftCardKey(credentialEncryptionKey);
    const [hashBits, cipherBits] = await Promise.all([
        hkdfBits(key, GIFT_CARD_CODE_HASH_PURPOSE),
        hkdfBits(key, GIFT_CARD_CODE_CIPHER_PURPOSE),
    ]);
    const [hashKey, cipherKey] = await Promise.all([
        crypto.subtle.importKey("raw", hashBits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
        crypto.subtle.importKey("raw", cipherBits, "AES-GCM", false, ["encrypt", "decrypt"]),
    ]);
    return { hashKey, cipherKey };
}

/** `code_hash` for a canonical code (base64url HMAC-SHA256). */
export async function hashGiftCardCode(keys: GiftCardKeys, canonicalCode: string): Promise<string> {
    const signature = await crypto.subtle.sign("HMAC", keys.hashKey, encoder.encode(canonicalCode));
    return base64Url(new Uint8Array(signature));
}

/** `code_ciphertext`: `gc1:<iv>:<ciphertext>` (base64url), AAD-bound to the purpose. */
export async function encryptGiftCardCode(keys: GiftCardKeys, canonicalCode: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(GIFT_CARD_CODE_CIPHER_PURPOSE) },
        keys.cipherKey,
        encoder.encode(canonicalCode),
    );
    return `${CIPHERTEXT_VERSION}:${base64Url(iv)}:${base64Url(new Uint8Array(sealed))}`;
}

/** The canonical code behind a stored ciphertext; throws `GiftCardsUnavailableError` when unreadable. */
export async function decryptGiftCardCode(keys: GiftCardKeys, ciphertext: string): Promise<string> {
    const [version, ivPart, sealedPart, extra] = ciphertext.split(":");
    if (version !== CIPHERTEXT_VERSION || !ivPart || !sealedPart || extra !== undefined) {
        throw new GiftCardsUnavailableError();
    }
    try {
        const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: fromBase64Url(ivPart), additionalData: encoder.encode(GIFT_CARD_CODE_CIPHER_PURPOSE) },
            keys.cipherKey,
            fromBase64Url(sealedPart),
        );
        const code = normalizeGiftCardCode(new TextDecoder().decode(plain));
        if (!code) throw new Error("not a code");
        return code;
    } catch {
        throw new GiftCardsUnavailableError();
    }
}

/** A fresh 80-bit code (Crockford base32) from the platform CSPRNG. */
export function newGiftCardCode(): string {
    return generateGiftCardCode((length) => crypto.getRandomValues(new Uint8Array(length)));
}

/** Everything a new `gift_cards` row stores about its code. */
export interface SealedGiftCardCode {
    /** The canonical code: returned to staff once at manual issue, never stored or logged. */
    code: string;
    codeHash: string;
    codeCiphertext: string;
    codeLast4: string;
}

export async function sealNewGiftCardCode(keys: GiftCardKeys): Promise<SealedGiftCardCode> {
    const code = newGiftCardCode();
    const [codeHash, codeCiphertext] = await Promise.all([
        hashGiftCardCode(keys, code),
        encryptGiftCardCode(keys, code),
    ]);
    return { code, codeHash, codeCiphertext, codeLast4: code.slice(-4) };
}

/** A deterministic `gc_` id from a request key (manual issue idempotency). */
export async function giftCardIdFromRequestKey(scope: string, requestKey: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${scope}:${requestKey}`));
    return `gc_${base64Url(new Uint8Array(digest)).slice(0, 24)}`;
}

export const giftCardBase64Url = { encode: base64Url, decode: fromBase64Url };
