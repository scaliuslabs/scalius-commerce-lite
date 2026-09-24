// src/integrations/email/provider.ts
// Provider interface and registry for email integrations.

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
  /** Display name for the sender; defaults to the store name. */
  fromName?: string;
  text?: string;
  idempotencyKey?: string;
}

export interface SendEmailResult {
  success: boolean;
  provider: "cloudflare" | "resend" | "mailpit" | "log";
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
  /** The store name from Business settings: what recipients see as the sender. */
  senderName?: string;
  senderConfigured: boolean;
  resendApiKey: string | null;
  hasResendApiKey: boolean;
  cloudflareBindingConfigured: boolean;
  localMailpitUrl: string | null;
  resendCredentialError?: string | null;
}

export interface EmailRuntimeContext {
  db?: unknown;
  env?: Record<string, unknown> & {
    EMAIL?: CloudflareEmailBinding;
    /** The only key that decrypts stored provider credentials. */
    CREDENTIAL_ENCRYPTION_KEY?: string;
    /** Local development only: route mail to a loopback Mailpit. */
    LOCAL_MAILPIT_URL?: string;
  };
  /** Explicit override of `env.CREDENTIAL_ENCRYPTION_KEY`. */
  encryptionKey?: string;
  settings?: EmailRuntimeSettings;
}

/** The sender as providers take it: address plus a display name, if any. */
export function resolveSender(
  options: Pick<SendEmailOptions, "from" | "fromName">,
  settings: Pick<EmailRuntimeSettings, "sender" | "senderName">,
): { email: string; name?: string } {
  const email = options.from || settings.sender;
  // Header-safe: no quotes, angle brackets or line breaks in the display name.
  const name = (options.fromName ?? settings.senderName ?? "").replace(/["<>\r\n\\]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 78);
  return name ? { email, name } : { email };
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
const DEFAULT_PROVIDER_NAME = "cloudflare";

/**
 * Register an email provider by name.
 */
export function registerEmailProvider(name: string, provider: EmailProvider): void {
  providers.set(name, provider);
}

/**
 * Retrieve a provider by name, falling back to the immutable default.
 */
export function getEmailProvider(name?: string): EmailProvider | undefined {
  return providers.get(name || DEFAULT_PROVIDER_NAME);
}
