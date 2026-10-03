// src/integrations/meta/crypto-utils.ts
// Meta CAPI identifiers are normalized, then SHA-256 hashed (lowercase hex).
import { sha256Hex } from "@scalius/shared/hash";

/** Normalizes and hashes an email address for Meta CAPI. */
export async function hashEmail(email: string): Promise<string> {
  return sha256Hex(email.trim().toLowerCase());
}

/** Normalizes (digits only) and hashes a phone number for Meta CAPI. */
export async function hashPhone(phone: string): Promise<string> {
  return sha256Hex(phone.replace(/\D/g, ""));
}
