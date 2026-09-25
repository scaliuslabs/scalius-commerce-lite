// The checkout apply handle (Wave B §4.3): after a buyer proves a code once,
// the storefront carries an opaque, short-lived handle instead of the code.
// It is AES-GCM sealed `{giftCardId, exp}` under a SCALIUS_SECRET-derived key
// (short-lived, so rotation only drops in-flight checkouts). Holding a handle
// grants nothing but "apply this card to an order I place within 2 hours";
// it never reveals the code or the balance beyond what apply returned.
import { GIFT_CARD_APPLY_HANDLE_PURPOSE } from "@scalius/shared/gift-card-code";
import { deriveRuntimeSecret } from "@scalius/shared/runtime-secrets";
import { giftCardBase64Url } from "./crypto";

export const GIFT_CARD_APPLY_HANDLE_TTL_SECONDS = 2 * 60 * 60;
const HANDLE_PREFIX = "gch_";
const IV_BYTES = 12;
/** Longest handle accepted as input; anything longer is not one. */
export const GIFT_CARD_APPLY_HANDLE_MAX_LENGTH = 200;
export const GIFT_CARD_APPLY_HANDLE_PATTERN = /^gch_[A-Za-z0-9_-]{40,196}$/;

const encoder = new TextEncoder();

async function handleKey(masterSecret: string): Promise<CryptoKey> {
    const secret = await deriveRuntimeSecret(masterSecret, GIFT_CARD_APPLY_HANDLE_PURPOSE);
    const raw = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
    return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealGiftCardApplyHandle(
    masterSecret: string,
    giftCardId: string,
    nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ handle: string; expiresAt: number }> {
    const expiresAt = nowSeconds + GIFT_CARD_APPLY_HANDLE_TTL_SECONDS;
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(GIFT_CARD_APPLY_HANDLE_PURPOSE) },
        await handleKey(masterSecret),
        encoder.encode(JSON.stringify({ g: giftCardId, e: expiresAt })),
    );
    const bytes = new Uint8Array(IV_BYTES + sealed.byteLength);
    bytes.set(iv);
    bytes.set(new Uint8Array(sealed), IV_BYTES);
    return { handle: `${HANDLE_PREFIX}${giftCardBase64Url.encode(bytes)}`, expiresAt };
}

/** The card id a live handle names, or null (malformed, forged, expired). Never throws on input. */
export async function openGiftCardApplyHandle(
    masterSecret: string,
    handle: unknown,
    nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string | null> {
    if (typeof handle !== "string" || handle.length > GIFT_CARD_APPLY_HANDLE_MAX_LENGTH) return null;
    if (!GIFT_CARD_APPLY_HANDLE_PATTERN.test(handle)) return null;
    try {
        const bytes = giftCardBase64Url.decode(handle.slice(HANDLE_PREFIX.length));
        if (bytes.length <= IV_BYTES) return null;
        const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: bytes.slice(0, IV_BYTES), additionalData: encoder.encode(GIFT_CARD_APPLY_HANDLE_PURPOSE) },
            await handleKey(masterSecret),
            bytes.slice(IV_BYTES),
        );
        const parsed = JSON.parse(new TextDecoder().decode(plain)) as { g?: unknown; e?: unknown };
        if (typeof parsed.g !== "string" || !parsed.g.startsWith("gc_")) return null;
        if (typeof parsed.e !== "number" || parsed.e <= nowSeconds) return null;
        return parsed.g;
    } catch {
        return null;
    }
}
