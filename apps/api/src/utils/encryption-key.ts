import { ServiceUnavailableError } from "./api-error";

/**
 * Runtime key accessors. There are no fallback chains: each purpose reads
 * exactly one env field. `CREDENTIAL_ENCRYPTION_KEY` is the installed secret
 * that encrypts merchant credentials at rest; `CUSTOMER_SESSION_HASH_KEY` is
 * derived from `SCALIUS_SECRET` at Worker entry (src/runtime/runtime-env.ts).
 */

function readKey(env: Record<string, unknown>, name: string): string | undefined {
    const value = env[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Key used to encrypt and decrypt merchant credentials and OTP material. */
export function getCredentialEncryptionKey(env: Record<string, unknown>): string | undefined {
    return readKey(env, "CREDENTIAL_ENCRYPTION_KEY");
}

/** Key used to hash customer session tokens before storage. */
export function getCustomerSessionHashKey(env: Record<string, unknown>): string | undefined {
    return readKey(env, "CUSTOMER_SESSION_HASH_KEY");
}

/** Fail-closed variant for credential writes. */
export function requireEncryptionKey(env: Record<string, unknown>): string {
    const key = getCredentialEncryptionKey(env);
    if (!key) {
        throw new ServiceUnavailableError("CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials.");
    }
    return key;
}
