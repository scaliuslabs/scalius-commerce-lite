// src/integrations/email/provider.ts
// Provider interface and registry for email integrations.

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
  /** Display name shown before the sender address (the store name). */
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

/**
 * Contract that every email provider must implement.
 */
export interface EmailProvider {
  readonly name: string;
  sendEmail(options: SendEmailOptions, context?: EmailRuntimeContext): Promise<SendEmailResult>;
}

export interface SenderMailbox {
  email: string;
  name?: string;
}

/** The sender address plus a display name safe to place in a From header. */
export function senderMailbox(
  { from, fromName }: Pick<SendEmailOptions, "from" | "fromName">,
  settings: Pick<EmailRuntimeSettings, "sender">,
): SenderMailbox {
  const email = from || settings.sender;
  const name = fromName?.replace(/[\p{Cc}\s]+/gu, " ").trim().slice(0, 78);
  return name ? { email, name } : { email };
}

/** RFC 5322 `"Name" <address>`, or the bare address without a name. */
export function formatSenderMailbox({ email, name }: SenderMailbox): string {
  return name ? `"${name.replace(/["\\]/g, "\\$&")}" <${email}>` : email;
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
