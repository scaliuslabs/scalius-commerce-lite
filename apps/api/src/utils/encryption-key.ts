/**
 * Get encryption key from Cloudflare env bindings.
 * Prefers CREDENTIAL_ENCRYPTION_KEY, falls back to JWT_SECRET.
 */
export function getEncryptionKey(env: Record<string, unknown>): string | undefined {
    return (env.CREDENTIAL_ENCRYPTION_KEY as string | undefined)
        ?? (env.JWT_SECRET as string | undefined);
}
