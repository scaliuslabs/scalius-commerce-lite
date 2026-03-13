// src/lib/meta/crypto-utils.ts

/**
 * Hashes a string using SHA-256.
 * @param input The string to hash.
 * @returns The SHA-256 hash as a hex string.
 */
export async function sha256(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  
  /**
   * Normalizes and hashes an email address for Meta CAPI.
   * @param email The email address.
   * @returns The hashed email.
   */
  export async function hashEmail(email: string): Promise<string> {
    const normalized = email.trim().toLowerCase();
    return sha256(normalized);
  }
  
  /**
   * Normalizes and hashes a phone number for Meta CAPI.
   * @param phone The phone number.
   * @returns The hashed phone number.
   */
  export async function hashPhone(phone: string): Promise<string> {
    // Removes all non-digit characters
    const normalized = phone.replace(/\D/g, "");
    return sha256(normalized);
  }