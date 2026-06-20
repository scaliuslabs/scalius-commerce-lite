// src/integrations/email/provider.ts
// Provider interface and registry for email integrations.

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
  text?: string;
  idempotencyKey?: string;
}

export interface SendEmailResult {
  success: boolean;
  provider: "cloudflare" | "resend" | "log";
  providerRef?: string;
  rawStatus?: string;
}

export interface CloudflareEmailBinding {
  send(message: {
    to: string | { email: string; name?: string };
    from: string | { email: string; name?: string };
    subject: string;
    html?: string;
    text?: string;
  }): Promise<{ messageId: string }>;
}

export interface EmailRuntimeSettings {
  provider: "cloudflare" | "resend";
  sender: string;
  senderConfigured: boolean;
  resendApiKey: string | null;
  hasResendApiKey: boolean;
  cloudflareBindingConfigured: boolean;
  resendCredentialError?: string | null;
}

export interface EmailRuntimeContext {
  db?: unknown;
  env?: Record<string, unknown> & {
    EMAIL?: CloudflareEmailBinding;
    CREDENTIAL_ENCRYPTION_KEY?: string;
    JWT_SECRET?: string;
  };
  encryptionKey?: string;
  settings?: EmailRuntimeSettings;
}

/**
 * Contract that every email provider must implement.
 */
export interface EmailProvider {
  readonly name: string;
  sendEmail(options: SendEmailOptions, context?: EmailRuntimeContext): Promise<SendEmailResult>;
}

// ── Provider Registry ───────────────────────────────────────────────

const providers = new Map<string, EmailProvider>();
let activeProviderName = "cloudflare";

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
