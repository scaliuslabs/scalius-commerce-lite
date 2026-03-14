// src/integrations/email/index.ts
// Barrel file for email provider abstraction.

export type { SendEmailOptions, EmailProvider } from "./provider";
export {
  registerEmailProvider,
  getEmailProvider,
  setActiveEmailProvider,
} from "./provider";

export { ResendEmailProvider } from "./resend";

// ── Register built-in providers ─────────────────────────────────────

import { registerEmailProvider } from "./provider";
import { ResendEmailProvider } from "./resend";

registerEmailProvider("resend", new ResendEmailProvider());

// ── Convenience functions (preserve existing public API) ────────────

import type { SendEmailOptions } from "./provider";
import { getEmailProvider } from "./provider";

/**
 * Send an email using the active provider.
 * Falls back to console logging when no provider is configured.
 */
export async function sendEmail(options: SendEmailOptions): Promise<void> {
  const provider = getEmailProvider();
  if (!provider) {
    console.warn("[Email] No email provider registered");
    return;
  }
  await provider.sendEmail(options);
}

/**
 * Send a verification email.
 */
export async function sendVerificationEmail(
  email: string,
  name: string,
  verificationUrl: string,
): Promise<void> {
  await sendEmail({
    to: email,
    subject: "Verify your email for Scalius Commerce",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Verify your email</h2>
        <p>Hi ${name},</p>
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
    text: `Hi ${name},\n\nPlease verify your email: ${verificationUrl}\n\nExpires in 24 hours.`,
  });
}

/**
 * Send a password reset email.
 */
export async function sendPasswordResetEmail(
  email: string,
  name: string,
  resetUrl: string,
): Promise<void> {
  await sendEmail({
    to: email,
    subject: "Reset your password for Scalius Commerce",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Reset your password</h2>
        <p>Hi ${name},</p>
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
  });
}

/**
 * Send an admin invitation email.
 */
export async function sendAdminInviteEmail(
  email: string,
  inviterName: string,
  tempPassword: string,
  loginUrl: string,
): Promise<void> {
  await sendEmail({
    to: email,
    subject: "You've been invited to Scalius Commerce Admin",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Admin Invitation</h2>
        <p>Hi,</p>
        <p>${inviterName} has invited you to join Scalius Commerce as an administrator.</p>
        <p>Your temporary login credentials are:</p>
        <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p style="margin: 0;"><strong>Email:</strong> ${email}</p>
          <p style="margin: 10px 0 0;"><strong>Temporary Password:</strong> <code style="background: #fff; padding: 4px 8px; border-radius: 4px;">${tempPassword}</code></p>
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
  });
}
