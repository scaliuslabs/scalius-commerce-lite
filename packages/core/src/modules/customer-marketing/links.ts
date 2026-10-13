// Signed links in marketing messages. Keys are derived from SCALIUS_SECRET
// with their own HKDF purposes (never the raw master secret, never stored).
//
// Double opt-in: the consent row keeps only SHA-256 of the confirmation token
// and the outbox row only a random nonce; the token is
// HMAC(opt-in key, customerId:nonce), so it exists only in the e-mail the
// notification sender builds. A newer request replaces the row's hash, which voids
// older links; confirming clears it (single use); it expires after 7 days.
//
// Unsubscribe: `u1.<customer id, base64url>.<channel>.<HMAC>`, stateless and
// long-lived (RFC 8058 links must keep working). It can only unsubscribe.
// Rotating SCALIUS_SECRET voids every outstanding link.

import { deriveRuntimeSecret, readMasterSecret } from "@scalius/shared/runtime-secrets";
import { isMarketingChannel, type MarketingChannel } from "@scalius/shared/customer-marketing";
import { ServiceUnavailableError } from "@scalius/core/errors";
import { bytesToHex, sha256Hex } from "@scalius/shared/hash";

export const MARKETING_OPT_IN_LINK_PURPOSE = "marketing-opt-in-link";
export const MARKETING_UNSUBSCRIBE_LINK_PURPOSE = "marketing-unsubscribe-link";

/** Storefront pages the links open (both reserved top-level paths). */
export const MARKETING_CONFIRM_PATH = "/newsletter/confirm";
export const MARKETING_UNSUBSCRIBE_PATH = "/newsletter/unsubscribe";

export type MarketingLinkEnv = { SCALIUS_SECRET?: unknown };

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string | null {
    try {
        const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
        const binary = atob(padded);
        return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
    } catch {
        return null;
    }
}

async function hmacKey(env: MarketingLinkEnv, purpose: string): Promise<CryptoKey> {
    const master = readMasterSecret(env as { SCALIUS_SECRET?: string });
    if (!master) throw new ServiceUnavailableError("Marketing links are unavailable right now.");
    const secret = await deriveRuntimeSecret(master, purpose);
    return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function sign(env: MarketingLinkEnv, purpose: string, message: string): Promise<string> {
    const key = await hmacKey(env, purpose);
    return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))));
}

function constantTimeEqual(left: string, right: string): boolean {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    return difference === 0;
}

/** A fresh opt-in request nonce (32 hex): stored in the outbox row, useless without the key. */
export function newOptInNonce(): string {
    return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

/** The confirmation token of one opt-in request. */
export async function deriveOptInToken(env: MarketingLinkEnv, input: { customerId: string; nonce: string }): Promise<string> {
    return sign(env, MARKETING_OPT_IN_LINK_PURPOSE, `opt-in:v1:${input.customerId}:${input.nonce}`);
}

/** What the consent row stores for a token (and how a presented token is looked up). */
export async function hashOptInToken(token: string): Promise<string> {
    return sha256Hex(token);
}

export async function signUnsubscribeToken(
    env: MarketingLinkEnv,
    input: { customerId: string; channel: MarketingChannel },
): Promise<string> {
    const id = base64Url(encoder.encode(input.customerId));
    const signature = await sign(env, MARKETING_UNSUBSCRIBE_LINK_PURPOSE, `unsubscribe:v1:${input.customerId}:${input.channel}`);
    return `u1.${id}.${input.channel}.${signature}`;
}

/** The customer and channel of a valid unsubscribe token, or null. */
export async function verifyUnsubscribeToken(
    env: MarketingLinkEnv,
    token: unknown,
): Promise<{ customerId: string; channel: MarketingChannel } | null> {
    if (typeof token !== "string" || token.length > 400) return null;
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== "u1") return null;
    const [, encodedId, channel, signature] = parts as [string, string, string, string];
    if (!isMarketingChannel(channel) || !/^[A-Za-z0-9_-]{43}$/.test(signature) || !/^[A-Za-z0-9_-]{1,200}$/.test(encodedId)) return null;
    const customerId = fromBase64Url(encodedId);
    if (!customerId || customerId.length > 128) return null;
    const expected = await sign(env, MARKETING_UNSUBSCRIBE_LINK_PURPOSE, `unsubscribe:v1:${customerId}:${channel}`);
    return constantTimeEqual(expected, signature) ? { customerId, channel } : null;
}

function storefrontLink(storefrontUrl: string, path: string, token: string): string {
    const url = new URL(path, storefrontUrl);
    url.searchParams.set("token", token);
    return url.toString();
}

/** The confirm page link, or null when the store URL is not an absolute http(s) origin. */
export function marketingConfirmUrl(storefrontUrl: string | null | undefined, token: string): string | null {
    return absoluteOrigin(storefrontUrl) ? storefrontLink(storefrontUrl!, MARKETING_CONFIRM_PATH, token) : null;
}

export function marketingUnsubscribeUrl(storefrontUrl: string | null | undefined, token: string): string | null {
    return absoluteOrigin(storefrontUrl) ? storefrontLink(storefrontUrl!, MARKETING_UNSUBSCRIBE_PATH, token) : null;
}

function absoluteOrigin(value: string | null | undefined): boolean {
    if (!value) return false;
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
    } catch {
        return false;
    }
}
