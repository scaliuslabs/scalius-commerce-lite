// An abandoned checkout's recovery link: `<store>/<presence>/cart/recover/<token>`,
// the token `cr1.<row id>.<expiry, base 36 seconds>.<HMAC>` under its own key
// derived from SCALIUS_SECRET (never stored, rotating the secret voids every
// link). It names the snapshot row, never the checkout session (a receipt
// proof) or a contact or cart value, and it only puts the snapshot's lines
// back in a cart, which the store prices and checks again. It works until it
// expires, a week after the snapshot's last save, or until the row is gone
// (the order that completed it, or the retention cleanup).

import { deriveRuntimeSecret, readMasterSecret } from "@scalius/shared/runtime-secrets";

export const CHECKOUT_RECOVERY_LINK_PURPOSE = "checkout-recovery-link";
/** The storefront page the link opens (under the buyer's market presence). */
export const CHECKOUT_RECOVERY_PATH = "/cart/recover";
/** How long a link works after the snapshot's last save. */
export const CHECKOUT_RECOVERY_LINK_SECONDS = 7 * 24 * 60 * 60;

const ROW_ID = /^ab_ch_[A-Za-z0-9_-]{1,64}$/;
const TOKEN = /^cr1\.(ab_ch_[A-Za-z0-9_-]{1,64})\.([0-9a-z]{1,10})\.([A-Za-z0-9_-]{43})$/;
const encoder = new TextEncoder();

export type CheckoutRecoveryEnv = { SCALIUS_SECRET?: unknown };

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signature(env: CheckoutRecoveryEnv, message: string): Promise<string | null> {
  const master = readMasterSecret(env as { SCALIUS_SECRET?: string });
  if (!master) return null;
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(await deriveRuntimeSecret(master, CHECKOUT_RECOVERY_LINK_PURPOSE)),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))));
}

/** The token of one snapshot's link, expiring at `expiresAt` (seconds), or null without a master secret. */
export async function signCheckoutRecoveryToken(env: CheckoutRecoveryEnv, input: { id: string; expiresAt: number }): Promise<string | null> {
  if (!ROW_ID.test(input.id)) return null;
  const expiry = Math.floor(input.expiresAt).toString(36);
  const signed = await signature(env, `checkout-recovery:v1:${input.id}:${expiry}`);
  return signed ? `cr1.${input.id}.${expiry}.${signed}` : null;
}

/** The snapshot row a valid, unexpired token names, or null. */
export async function verifyCheckoutRecoveryToken(env: CheckoutRecoveryEnv, token: unknown, nowSeconds: number): Promise<{ id: string } | null> {
  if (typeof token !== "string" || token.length > 200) return null;
  const match = TOKEN.exec(token);
  if (!match) return null;
  const [, id, expiry, presented] = match as unknown as [string, string, string, string];
  if (Number.parseInt(expiry, 36) <= nowSeconds) return null;
  const expected = await signature(env, `checkout-recovery:v1:${id}:${expiry}`);
  if (!expected || expected.length !== presented.length) return null;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ presented.charCodeAt(index);
  return difference === 0 ? { id } : null;
}

/** The link on the store, under the buyer's market presence; null without an absolute http(s) store URL. */
export function checkoutRecoveryUrl(storefrontUrl: string | null | undefined, presence: string | null, token: string): string | null {
  let origin: URL;
  try {
    origin = new URL(String(storefrontUrl ?? ""));
  } catch {
    return null;
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") return null;
  return new URL(`${presence ? `/${presence}` : ""}${CHECKOUT_RECOVERY_PATH}/${token}`, origin).toString();
}

/** A snapshot's link and its expiry (a week after its last save), or null when the store cannot sign one. */
export async function checkoutRecoveryLink(
  runtime: { env: CheckoutRecoveryEnv; storefrontUrl: string | null | undefined },
  snapshot: { id: string; updatedAt: Date; presence: string | null },
): Promise<{ url: string; expiresAt: Date } | null> {
  const expiresAt = Math.floor(snapshot.updatedAt.getTime() / 1000) + CHECKOUT_RECOVERY_LINK_SECONDS;
  const token = await signCheckoutRecoveryToken(runtime.env, { id: snapshot.id, expiresAt });
  const url = token ? checkoutRecoveryUrl(runtime.storefrontUrl, snapshot.presence, token) : null;
  return url ? { url, expiresAt: new Date(expiresAt * 1000) } : null;
}
