// Signed links to an attached buyer upload, and the visitor key of the
// staged cap. Both derive from SCALIUS_SECRET (HKDF, own labels): a link is
// short-lived (5 minutes), so a secret rotation only ends links in flight.
//
// A link is a bearer URL: whoever holds it reads the file until it expires.
// It is handed only to staff and the owning app, never logged, and every
// failure of it is the same 404.
import { BUYER_UPLOAD_ID_PATTERN, BUYER_UPLOAD_LINK_PURPOSE, BUYER_UPLOAD_LINK_TTL_SECONDS } from "@scalius/shared/buyer-uploads";
import { hmacSha256Hex } from "@scalius/shared/hash";
import { deriveRuntimeSecret, encodeBase64Url, readMasterSecret } from "@scalius/shared/runtime-secrets";
import { ServiceUnavailableError } from "../../errors";

const encoder = new TextEncoder();
const VISITOR_PURPOSE = "buyer-upload-visitor";
type SecretEnv = { SCALIUS_SECRET?: unknown };

async function derived(env: SecretEnv, purpose: string): Promise<string> {
    const master = readMasterSecret(env);
    if (!master) throw new ServiceUnavailableError("Uploads are unavailable right now.");
    return deriveRuntimeSecret(master, purpose);
}

async function sign(env: SecretEnv, uploadId: string, expiresAt: number): Promise<string> {
    const key = await crypto.subtle.importKey("raw", encoder.encode(await derived(env, BUYER_UPLOAD_LINK_PURPOSE)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return encodeBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${uploadId}|${expiresAt}`))));
}

/** The API path of a signed link and when it ends (unix seconds). */
export async function signBuyerUploadLink(
    env: SecretEnv,
    uploadId: string,
    now: number = Math.floor(Date.now() / 1000),
): Promise<{ path: string; expiresAt: number }> {
    const expiresAt = now + BUYER_UPLOAD_LINK_TTL_SECONDS;
    return { path: `/api/v1/orders/uploads/${uploadId}/${expiresAt}/${await sign(env, uploadId, expiresAt)}`, expiresAt };
}

/** Constant-time check of a link: well formed, unexpired and signed by this store. */
export async function verifyBuyerUploadLink(
    env: SecretEnv,
    input: { uploadId: string; expiresAt: number; signature: string },
    now: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
    if (!BUYER_UPLOAD_ID_PATTERN.test(input.uploadId) || !/^[A-Za-z0-9_-]{43}$/u.test(input.signature)) return false;
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < now || input.expiresAt > now + BUYER_UPLOAD_LINK_TTL_SECONDS) return false;
    const expected = await sign(env, input.uploadId, input.expiresAt);
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1) {
        difference |= expected.charCodeAt(index) ^ input.signature.charCodeAt(index);
    }
    return difference === 0;
}

/** A keyed hash of the visitor's address: the staged cap counts by it, and the address is never stored. */
export async function buyerUploadVisitorKey(env: SecretEnv, address: string): Promise<string> {
    return hmacSha256Hex(await derived(env, VISITOR_PURPOSE), address);
}
