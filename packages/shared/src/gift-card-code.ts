/**
 * Gift-card codes (Wave B §4.1): 16 characters of Crockford base32 = 80 random
 * bits, shown as `XXXX-XXXX-XXXX-XXXX`. Pure: generation takes the random
 * source (`crypto.getRandomValues` in production), and hashing/encryption live
 * in core, keyed from `CREDENTIAL_ENCRYPTION_KEY` under the purposes below.
 *
 * A code is a bearer credential: never put it in URLs, logs, analytics, queue
 * or outbox payloads, or delivery receipts. Staff and logs see `last4` only.
 */

import { toLatinDigits } from "./phone-input";

/** Crockford base32: digits and letters without I, L, O, U. */
export const CROCKFORD_BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 16 symbols × 5 bits = 80 bits. */
export const GIFT_CARD_CODE_LENGTH = 16;
export const GIFT_CARD_CODE_BITS = GIFT_CARD_CODE_LENGTH * 5;
/** Random bytes one code consumes: 80 bits is exactly 10 bytes, so no bits are wasted and none are biased. */
export const GIFT_CARD_CODE_RANDOM_BYTES = GIFT_CARD_CODE_BITS / 8;

/** A canonical code: 16 Crockford symbols, uppercase, no separators. */
export const GIFT_CARD_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{16}$/;

/** HMAC purpose for the unique lookup `gift_cards.code_hash` (key derived from `CREDENTIAL_ENCRYPTION_KEY`). */
export const GIFT_CARD_CODE_HASH_PURPOSE = "gift-card-code-hash-v1";
/** AES-GCM purpose for `gift_cards.code_ciphertext` (key derived from `CREDENTIAL_ENCRYPTION_KEY`). */
export const GIFT_CARD_CODE_CIPHER_PURPOSE = "gift-card-code-v1";
/** AES-GCM purpose for the short-lived checkout apply handle (key derived from `SCALIUS_SECRET`). */
export const GIFT_CARD_APPLY_HANDLE_PURPOSE = "gift-card-apply-handle";

/** Longest raw input `normalizeGiftCardCode` looks at; anything longer is not a code. */
const MAX_INPUT_LENGTH = 64;

/**
 * A new canonical code from `randomBytes(10)`. Each 5-bit group of the 80 bits
 * picks one symbol, so every symbol is uniform (32 is a power of two: no
 * modulo bias). Throws when the source returns the wrong number of bytes.
 */
export function generateGiftCardCode(randomBytes: (length: number) => Uint8Array): string {
  const bytes = randomBytes(GIFT_CARD_CODE_RANDOM_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.length !== GIFT_CARD_CODE_RANDOM_BYTES) {
    throw new RangeError(`A gift-card code needs exactly ${GIFT_CARD_CODE_RANDOM_BYTES} random bytes.`);
  }
  let code = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      code += CROCKFORD_BASE32_ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return code;
}

/**
 * Buyer or staff input → the canonical code, or `null` when it cannot be one.
 * Uppercases; drops whitespace and dashes (any Unicode dash); reads Bangla and
 * Arabic-Indic digits as 0–9; reads `O` as `0` and `I`/`L` as `1` (Crockford's
 * decoding rule). `U` and any other symbol are invalid; the result must be
 * exactly 16 symbols.
 */
export function normalizeGiftCardCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > MAX_INPUT_LENGTH) return null;
  const code = toLatinDigits(input.normalize("NFKC"))
    .toUpperCase()
    .replace(/[\s\p{Pd}]/gu, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return GIFT_CARD_CODE_PATTERN.test(code) ? code : null;
}

export function isGiftCardCode(value: unknown): value is string {
  return typeof value === "string" && GIFT_CARD_CODE_PATTERN.test(value);
}

function canonicalOrThrow(code: string): string {
  const canonical = normalizeGiftCardCode(code);
  if (!canonical) throw new RangeError("Not a gift-card code.");
  return canonical;
}

/** `XXXX-XXXX-XXXX-XXXX` for display to the code's owner. Throws when `code` is not a code. */
export function formatGiftCardCode(code: string): string {
  const canonical = canonicalOrThrow(code);
  return canonical.match(/.{4}/g)!.join("-");
}

/** The last four symbols (`gift_cards.code_last4`), the only part staff and logs see. */
export function giftCardCodeLast4(code: string): string {
  return canonicalOrThrow(code).slice(-4);
}

const LAST4_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}$/;

/**
 * `•••• 7K2Q`. Takes a full code or the stored `code_last4`, so staff views
 * that only hold `last4` use the same helper. Throws on anything else.
 */
export function maskGiftCardCode(codeOrLast4: string): string {
  const last4 = LAST4_PATTERN.test(codeOrLast4) ? codeOrLast4 : giftCardCodeLast4(codeOrLast4);
  return `•••• ${last4}`;
}
