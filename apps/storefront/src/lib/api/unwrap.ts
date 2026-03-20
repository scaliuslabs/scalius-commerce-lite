// src/lib/api/unwrap.ts

/**
 * Typed helpers for unwrapping the API's `{ success: true, data: T }` envelope.
 *
 * The generated SDK types wrap responses as per-endpoint types that don't
 * reflect the inner envelope. These helpers centralize the single `as` cast
 * so individual API modules don't need `as any`.
 */

interface EnvelopedResponse<T = unknown> {
  success?: boolean;
  data?: T;
}

/**
 * Unwrap the `{ success, data }` envelope, returning `data` or `null`.
 * Checks for `success: true` before returning data.
 */
export function unwrapEnvelope<T>(response: unknown): T | null {
  const r = response as EnvelopedResponse<T>;
  if (r?.success && r.data !== undefined) {
    return r.data;
  }
  return null;
}

/**
 * Unwrap just the `.data` property without checking `success`.
 * Useful when the caller handles success/failure separately.
 */
export function unwrapData<T>(response: unknown): T | null {
  const r = response as EnvelopedResponse<T>;
  return r?.data ?? null;
}
