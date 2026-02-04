// src/lib/email.ts
// Email service for sending emails using Cloudflare Email Workers

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
  text?: string;
  env?: Env | NodeJS.ProcessEnv;
}

/**
 * Send an email using Cloudflare Email Workers.
 * Falls back to console logging in development when EMAIL binding is not available.
 */
export async function sendEmail({
  to,
  subject,
  html,
  from,
  text,
  env,
}: SendEmailOptions): Promise<void> {
  // Get the sender email from environment
  const getEnvVar = (key: string): string | undefined => {
    if (env && key in env) {
      return (env as Record<string, string>)[key];
    }
    if (typeof process !== "undefined" && process.env) {
      return process.env[key];
    }
    return undefined;
  };

  const senderEmail = from || getEnvVar("EMAIL_SENDER") || "noreply@scalius.com";

  // Check if we have the EMAIL binding (Cloudflare Workers environment)
  const emailBinding = (env as Env)?.EMAIL;

  if (emailBinding) {
    try {
      // Use mimetext to create proper MIME message
      const { createMimeMessage } = await import("mimetext");

      const msg = createMimeMessage();
      msg.setSender({ addr: senderEmail, name: "Scalius Commerce" });
      msg.setRecipient(to);
      msg.setSubject(subject);

      // Add HTML content
      msg.addMessage({
        contentType: "text/html",
        data: html,
      });

      // Optionally add plain text version
      if (text) {
        msg.addMessage({
          contentType: "text/plain",
          data: text,
        });
      }

      // Create EmailMessage and send
      const rawEmail = msg.asRaw();

      // Use the EmailMessage class from Cloudflare Workers
      // @ts-expect-error - cloudflare:email is a runtime module only available in Cloudflare Workers
      const { EmailMessage } = await import("cloudflare:email");
      const message = new EmailMessage(senderEmail, to, rawEmail);

      await emailBinding.send(message);

      console.log(`Email sent successfully to ${to}`);
    } catch (error) {
      console.error("Failed to send email via Cloudflare Email Workers:", error);
      throw new Error(`Failed to send email: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  } else {
    // Development fallback - log email to console
    console.log("=".repeat(60));
    console.log("EMAIL (Development Mode - No EMAIL binding available)");
    console.log("=".repeat(60));
    console.log(`From: ${senderEmail}`);
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log("-".repeat(60));
    console.log("HTML Content:");
    console.log(html);
    if (text) {
      console.log("-".repeat(60));
      console.log("Plain Text Content:");
      console.log(text);
    }
    console.log("=".repeat(60));
  }
}

/**
 * Send a verification email to a user.
 */
export async function sendVerificationEmail(
  email: string,
  name: string,
  verificationUrl: string,
  env?: Env | NodeJS.ProcessEnv
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
    text: `Hi ${name},\n\nPlease verify your email by visiting: ${verificationUrl}\n\nThis link expires in 24 hours.\n\nIf you didn't request this email, you can safely ignore it.`,
    env,
  });
}

/**
 * Send a password reset email to a user.
 */
export async function sendPasswordResetEmail(
  email: string,
  name: string,
  resetUrl: string,
  env?: Env | NodeJS.ProcessEnv
): Promise<void> {
  await sendEmail({
    to: email,
    subject: "Reset your password for Scalius Commerce",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Reset your password</h2>
        <p>Hi ${name},</p>
        <p>We received a request to reset your password. Click the button below to create a new password:</p>
        <p style="margin: 30px 0;">
          <a href="${resetUrl}" style="background-color: #000; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Reset Password
          </a>
        </p>
        <p>Or copy and paste this link in your browser:</p>
        <p style="color: #666; word-break: break-all;">${resetUrl}</p>
        <p>This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
        <p style="color: #999; font-size: 12px;">
          For security reasons, this link can only be used once.
        </p>
      </div>
    `,
    text: `Hi ${name},\n\nWe received a request to reset your password. Visit this link to create a new password: ${resetUrl}\n\nThis link expires in 1 hour.\n\nIf you didn't request this, you can safely ignore this email.`,
    env,
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
  env?: Env | NodeJS.ProcessEnv
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
        <p style="color: #e74c3c; font-weight: 500;">
          Please change your password immediately after logging in.
        </p>
        <p>We also strongly recommend setting up two-factor authentication for enhanced security.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
        <p style="color: #999; font-size: 12px;">
          If you weren't expecting this invitation, please contact your administrator.
        </p>
      </div>
    `,
    text: `Hi,\n\n${inviterName} has invited you to join Scalius Commerce as an administrator.\n\nYour temporary login credentials are:\nEmail: ${email}\nTemporary Password: ${tempPassword}\n\nLogin at: ${loginUrl}\n\nPlease change your password immediately after logging in.\n\nWe also strongly recommend setting up two-factor authentication for enhanced security.`,
    env,
  });
}
