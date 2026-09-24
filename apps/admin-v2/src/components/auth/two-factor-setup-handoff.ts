/**
 * Backup codes from the two-step setup the server started when a new password
 * was set, carried to the setup page in memory only (never storage or a URL).
 * A reload loses them; the setup page then asks for the password as usual.
 */
let pending: string[] | null = null;

export function handOffTwoFactorSetup(backupCodes: string[]): void {
  pending = backupCodes;
}

export function peekTwoFactorSetup(): string[] | null {
  return pending;
}

export function clearTwoFactorSetup(): void {
  pending = null;
}
