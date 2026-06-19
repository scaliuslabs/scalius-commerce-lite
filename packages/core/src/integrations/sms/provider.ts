// src/integrations/sms/provider.ts
// Provider interface and registry for SMS integrations.
// Follows the email provider pattern (packages/core/src/integrations/email/provider.ts).

// ── Types ───────────────────────────────────────────────────────────

export interface SendSmsOptions {
  to: string; // E.164 format: +8801XXXXXXXXX
  message: string; // Plain text SMS body
  clientReference?: string; // Deterministic caller reference for providers that support idempotency
}

export interface SendSmsResult {
  success: boolean;
  providerRef?: string; // Provider-assigned reference ID
  rawStatus?: string; // Raw status string for debugging/logging (per SMS-07)
}

/**
 * Contract that every SMS provider must implement.
 */
export interface SmsProvider {
  readonly name: string; // "smsnetbd" | "bdbulksms" | "mimsms" | "gennet"
  sendSms(options: SendSmsOptions): Promise<SendSmsResult>;
  validateConfig(): string | null; // null = ready, string = error message
}

// ── Provider Registry ───────────────────────────────────────────────

const providers = new Map<string, SmsProvider>();

/**
 * Register an SMS provider by name.
 */
export function registerSmsProvider(
  name: string,
  provider: SmsProvider,
): void {
  providers.set(name, provider);
}

/**
 * Retrieve a provider by name.
 */
export function getSmsProvider(name: string): SmsProvider | undefined {
  return providers.get(name);
}

// ── Available Provider IDs ──────────────────────────────────────────

/** All supported SMS provider identifiers, for admin UI dropdown. */
export const SMS_PROVIDER_IDS = [
  "smsnetbd",
  "bdbulksms",
  "mimsms",
  "gennet",
] as const;

export type SmsProviderId = (typeof SMS_PROVIDER_IDS)[number];
