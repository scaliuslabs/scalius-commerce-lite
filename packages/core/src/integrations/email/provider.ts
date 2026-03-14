// src/integrations/email/provider.ts
// Provider interface and registry for email integrations.

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
  text?: string;
}

/**
 * Contract that every email provider must implement.
 */
export interface EmailProvider {
  readonly name: string;
  sendEmail(options: SendEmailOptions): Promise<void>;
}

// ── Provider Registry ───────────────────────────────────────────────

const providers = new Map<string, EmailProvider>();
let activeProviderName = "resend";

/**
 * Register an email provider by name.
 */
export function registerEmailProvider(name: string, provider: EmailProvider): void {
  providers.set(name, provider);
}

/**
 * Retrieve a provider by name, falling back to the active provider.
 */
export function getEmailProvider(name?: string): EmailProvider | undefined {
  return providers.get(name || activeProviderName);
}

/**
 * Set the default active email provider by name.
 */
export function setActiveEmailProvider(name: string): void {
  activeProviderName = name;
}
