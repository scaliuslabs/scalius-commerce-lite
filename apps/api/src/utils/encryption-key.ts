import { ServiceUnavailableError } from "./api-error";

export function getEncryptionKey(env: Record<string, unknown>): string | undefined {
    return (env.CREDENTIAL_ENCRYPTION_KEY as string | undefined)
        ?? (env.JWT_SECRET as string | undefined);
}

export function getCredentialEncryptionKey(env: Record<string, unknown>): string | undefined {
    return env.CREDENTIAL_ENCRYPTION_KEY as string | undefined;
}

export function getCustomerSessionHashKey(env: Record<string, unknown>): string | undefined {
    return (env.BETTER_AUTH_SECRET as string | undefined)
        ?? (env.JWT_SECRET as string | undefined)
        ?? (env.CREDENTIAL_ENCRYPTION_KEY as string | undefined);
}

export function requireEncryptionKey(env: Record<string, unknown>): string {
    const key = getCredentialEncryptionKey(env);
    if (!key) {
        throw new ServiceUnavailableError("CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials.");
    }
    return key;
}
