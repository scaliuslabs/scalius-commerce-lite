// src/integrations/email/index.ts
// Barrel file for email provider abstraction.

export type {
  SendEmailOptions,
  SendEmailResult,
  EmailProvider,
  EmailRuntimeContext,
  EmailRuntimeSettings,
  CloudflareEmailBinding,
} from "./provider";
export {
  registerEmailProvider,
  getEmailProvider,
  setActiveEmailProvider,
} from "./provider";

export { CloudflareEmailProvider } from "./cloudflare";
export { ResendEmailProvider } from "./resend";
export { getEmailProviderReadiness, getEmailRuntimeSettings, readEmailSetting } from "./settings";

// ── Register built-in providers ─────────────────────────────────────

import { registerEmailProvider } from "./provider";
import { CloudflareEmailProvider } from "./cloudflare";
import { ResendEmailProvider } from "./resend";

registerEmailProvider("cloudflare", new CloudflareEmailProvider());
registerEmailProvider("resend", new ResendEmailProvider());

// ── Convenience functions (preserve existing public API) ────────────

import type { EmailRuntimeContext, EmailRuntimeSettings, SendEmailOptions, SendEmailResult } from "./provider";
import { getEmailProvider } from "./provider";
import { getEmailRuntimeSettings } from "./settings";
import { escapeHtml } from "@scalius/shared/html-escape";

function maskEmailForLog(value: string | undefined): string {
  if (!value) return "unset";
  const [localPart, domain] = value.split("@");
  if (!localPart || !domain) return "redacted";
  const visible = localPart.length <= 2
    ? localPart[0] ?? "*"
    : `${localPart[0]}${localPart[localPart.length - 1]}`;
  return `${visible}***@${domain}`;
}

function logEmailFallback(
  { to, subject, html, from, text }: SendEmailOptions,
  settings: EmailRuntimeSettings,
): SendEmailResult {
  const fromAddress = from || settings.sender;
  console.warn("[Email] No configured provider available; email was not delivered", {
    providerPreference: settings.provider,
    from: maskEmailForLog(fromAddress),
    to: maskEmailForLog(to),
    subjectLength: subject.length,
    htmlLength: html.length,
    textLength: text?.length ?? 0,
    contentLogged: false,
  });
  return {
    success: false,
    provider: "log",
    rawStatus: "No configured email provider available; email not delivered",
  };
}

function providerOrder(settings: EmailRuntimeSettings): Array<EmailRuntimeSettings["provider"]> {
  return settings.provider === "resend"
    ? ["resend", "cloudflare"]
    : ["cloudflare", "resend"];
}

function isProviderConfigured(
  providerName: EmailRuntimeSettings["provider"],
  settings: EmailRuntimeSettings,
  context?: EmailRuntimeContext,
): boolean {
  if (providerName === "cloudflare") return Boolean(context?.env?.EMAIL);
  return Boolean(settings.resendApiKey);
}

/**
 * Send an email using the configured provider.
 * Falls back to the secondary provider, then console logging, when unavailable.
 */
export async function sendEmail(
  options: SendEmailOptions,
  context?: EmailRuntimeContext,
): Promise<SendEmailResult> {
  const settings = await getEmailRuntimeSettings(context);
  const runtimeContext: EmailRuntimeContext = { ...context, settings };

  for (const providerName of providerOrder(settings)) {
    if (!isProviderConfigured(providerName, settings, runtimeContext)) continue;
    const provider = getEmailProvider(providerName);
    if (!provider) continue;
    return await provider.sendEmail(options, runtimeContext);
  }

  return logEmailFallback(options, settings);
}

/**
 * Send a verification email.
 */
export async function sendVerificationEmail(
  email: string,
  name: string,
  verificationUrl: string,
  context?: EmailRuntimeContext,
): Promise<void> {
  await sendEmail({
    to: email,
    subject: "Verify your email for Scalius Commerce",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Verify your email</h2>
        <p>Hi ${escapeHtml(name)},</p>
        <p>Please click the button below to verify your email address:</p>
        <p style="margin: 30px 0;">
          <a href="${verificationUrl}" style="background-color: #000; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Verify Email
          </a>
        </p>
        <p>Or copy and paste this link in your browser:</p>
        <p style="color: #666; word-break: break-all;">${verificationUrl}</p>
        <p>This link expires in 24 hours.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
        <p style="color: #999; font-size: 12px;">
          If you didn't request this email, you can safely ignore it.
        </p>
      </div>
    `,
    text: `Hi ${name},\n\nPlease verify your email: ${verificationUrl}\n\nExpires in 24 hours.`,  // Plain text: no HTML escaping needed
  }, context);
}

/**
 * Send a password reset email.
 */
export async function sendPasswordResetEmail(
  email: string,
  name: string,
  resetUrl: string,
  context?: EmailRuntimeContext,
): Promise<void> {
  await sendEmail({
    to: email,
    subject: "Reset your password for Scalius Commerce",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Reset your password</h2>
        <p>Hi ${escapeHtml(name)},</p>
        <p>Click the button below to create a new password:</p>
        <p style="margin: 30px 0;">
          <a href="${resetUrl}" style="background-color: #000; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Reset Password
          </a>
        </p>
        <p>Or copy and paste this link in your browser:</p>
        <p style="color: #666; word-break: break-all;">${resetUrl}</p>
        <p>This link expires in 1 hour.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
        <p style="color: #999; font-size: 12px;">
          For security reasons, this link can only be used once.
        </p>
      </div>
    `,
    text: `Hi ${name},\n\nReset your password: ${resetUrl}\n\nExpires in 1 hour.`,
  }, context);
}

/**
 * Send an admin invitation email.
 */
export async function sendAdminInviteEmail(
  email: string,
  inviterName: string,
  tempPassword: string,
  loginUrl: string,
  context?: EmailRuntimeContext,
): Promise<void> {
  await sendEmail({
    to: email,
    subject: "You've been invited to Scalius Commerce Admin",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Admin Invitation</h2>
        <p>Hi,</p>
        <p>${escapeHtml(inviterName)} has invited you to join Scalius Commerce as an administrator.</p>
        <p>Your temporary login credentials are:</p>
        <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p style="margin: 0;"><strong>Email:</strong> ${escapeHtml(email)}</p>
          <p style="margin: 10px 0 0;"><strong>Temporary Password:</strong> <code style="background: #fff; padding: 4px 8px; border-radius: 4px;">${escapeHtml(tempPassword)}</code></p>
        </div>
        <p style="margin: 30px 0;">
          <a href="${loginUrl}" style="background-color: #000; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Login to Admin Panel
          </a>
        </p>
        <p style="color: #e74c3c; font-weight: 500;">Please change your password immediately after logging in.</p>
        <p>We also strongly recommend setting up two-factor authentication.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
        <p style="color: #999; font-size: 12px;">
          If you weren't expecting this invitation, please contact your administrator.
        </p>
      </div>
    `,
    text: `Hi,\n\n${inviterName} invited you to Scalius Commerce admin.\n\nEmail: ${email}\nTemp Password: ${tempPassword}\n\nLogin: ${loginUrl}\n\nChange your password immediately.`,
  }, context);
}
