// src/integrations/email/provider.ts
// The email port as core calls it: the shared port
// (`@scalius/shared/plugins/providers/messaging`, the one app providers
// implement) behind `sendEmail`. Built-in senders are one adapter in this
// directory (cloudflare.ts, resend.ts, mailpit.ts); an app's sender
// (`<plugin id>:<provider id>`) joins through the request's AppProviders. The
// choice is the `email` document's `provider`, read per send.

import type { AppProviders, BoundProvider, BuiltInAdapter } from "../provider-port";

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
  /** Display name for the sender; defaults to the store name. */
  fromName?: string;
  text?: string;
  idempotencyKey?: string;
  /**
   * Extra message headers. Only the list headers marketing mail needs
   * (RFC 2369 `List-Unsubscribe`, RFC 8058 `List-Unsubscribe-Post`) pass
   * `safeEmailHeaders`; everything else is dropped.
   */
  headers?: Readonly<Record<string, string | undefined>>;
}

const ALLOWED_EMAIL_HEADERS = new Set(["List-Unsubscribe", "List-Unsubscribe-Post"]);

/** The allowed headers with header-safe values (no line breaks), or undefined when none. */
export function safeEmailHeaders(headers: Readonly<Record<string, string | undefined>> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const safe = Object.entries(headers)
    .filter((entry): entry is [string, string] => {
      const [name, value] = entry;
      return ALLOWED_EMAIL_HEADERS.has(name) && typeof value === "string" && value.length > 0 && value.length <= 2000 && !/[\r\n]/.test(value);
    });
  return safe.length > 0 ? Object.fromEntries(safe) : undefined;
}

export interface SendEmailResult {
  success: boolean;
  /** The sender that took the message: `cloudflare`, `resend`, `mailpit`, an app provider id, or `log` when none could. */
  provider: string;
  providerRef?: string;
  rawStatus?: string;
  /** False when the provider said the same message can never pass (bad credentials, refused recipient). */
  retryable?: boolean;
}

export interface CloudflareEmailBinding {
  send(message: {
    to: string | { email: string; name?: string };
    from: string | { email: string; name?: string };
    subject: string;
    html?: string;
    text?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

/** The built-in senders a merchant chooses between (Mailpit is the local development sink, never a choice). */
export const BUILT_IN_EMAIL_PROVIDER_IDS = ["cloudflare", "resend"] as const;
export type BuiltInEmailProviderId = (typeof BUILT_IN_EMAIL_PROVIDER_IDS)[number];

export interface EmailRuntimeSettings {
  /** The merchant's choice: a built-in sender or an app provider's `<plugin id>:<provider id>`. */
  provider: string;
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
  /** The app providers a saved choice may name; without them an app choice cannot send. */
  appProviders?: AppProviders;
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

/** The sender a message goes through: a built-in one with the store's settings, or an app's. */
export type EmailProvider = BoundProvider<"email">;

/** What a built-in sender sends with: the store's email settings and the Worker's send binding. */
export interface EmailAdapterSettings {
  runtime: EmailRuntimeSettings;
  binding?: CloudflareEmailBinding;
}

/** A built-in sender; `configured` says whether it can send with these settings. */
export type EmailAdapter = BuiltInAdapter<"email", EmailAdapterSettings> & {
  configured(settings: EmailAdapterSettings): boolean;
};

export function maskEmailForLog(value: string | undefined): string {
  if (!value) return "unset";
  const [localPart, domain] = value.split("@");
  if (!localPart || !domain) return "redacted";
  const visible = localPart.length <= 2
    ? localPart[0] ?? "*"
    : `${localPart[0]}${localPart[localPart.length - 1]}`;
  return `${visible}***@${domain}`;
}
