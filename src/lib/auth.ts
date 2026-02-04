// src/lib/auth.ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor, admin } from "better-auth/plugins";
import { getDb } from "@/db";
import * as schema from "@/db/schema";

/**
 * Create Better Auth instance with the given environment.
 * This factory pattern is necessary for Cloudflare Workers where
 * env bindings are only available within the request context.
 */
export function createAuth(env?: Env | NodeJS.ProcessEnv) {
  const db = getDb(env);

  // Get environment variables
  const getEnvVar = (key: string): string | undefined => {
    if (env && key in env) {
      return (env as Record<string, string>)[key];
    }
    return process.env[key];
  };

  const secret = getEnvVar("BETTER_AUTH_SECRET");
  const baseURL = getEnvVar("BETTER_AUTH_URL") || getEnvVar("PUBLIC_API_BASE_URL");
  const senderEmail = getEnvVar("EMAIL_SENDER") || "noreply@scalius.com";
  const appName = "Scalius Commerce";

  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is not set. Generate one with: openssl rand -base64 32");
  }

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        twoFactor: schema.twoFactor,
      },
    }),
    secret,
    baseURL,
    appName,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false, // Can be enabled once email is configured
      minPasswordLength: 8,
      // Email verification callback - called when user needs to verify email
      sendVerificationEmail: async ({ user, url }: { user: { email: string; name: string }; url: string }) => {
        // Import dynamically to avoid circular dependencies
        const { sendEmail } = await import("@/lib/email");
        await sendEmail({
          to: user.email,
          subject: `Verify your email for ${appName}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>Verify your email</h2>
              <p>Hi ${user.name},</p>
              <p>Please click the button below to verify your email address:</p>
              <p style="margin: 30px 0;">
                <a href="${url}" style="background-color: #000; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                  Verify Email
                </a>
              </p>
              <p>Or copy and paste this link in your browser:</p>
              <p style="color: #666; word-break: break-all;">${url}</p>
              <p>This link expires in 24 hours.</p>
              <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
              <p style="color: #999; font-size: 12px;">
                If you didn't request this email, you can safely ignore it.
              </p>
            </div>
          `,
          from: senderEmail,
          env,
        });
      },
      // Password reset callback
      sendResetPassword: async ({ user, url }: { user: { email: string; name: string }; url: string }) => {
        const { sendEmail } = await import("@/lib/email");
        await sendEmail({
          to: user.email,
          subject: `Reset your password for ${appName}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>Reset your password</h2>
              <p>Hi ${user.name},</p>
              <p>We received a request to reset your password. Click the button below to create a new password:</p>
              <p style="margin: 30px 0;">
                <a href="${url}" style="background-color: #000; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                  Reset Password
                </a>
              </p>
              <p>Or copy and paste this link in your browser:</p>
              <p style="color: #666; word-break: break-all;">${url}</p>
              <p>This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.</p>
              <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
              <p style="color: #999; font-size: 12px;">
                For security reasons, this link can only be used once.
              </p>
            </div>
          `,
          from: senderEmail,
          env,
        });
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // Update session every day
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5, // 5 minutes
      },
    },
    // Rate limiting configuration for security
    rateLimit: {
      enabled: true,
      window: 60, // 60 seconds window
      max: 100, // 100 requests per window for general endpoints
      customRules: {
        // Strict rate limiting for sign-in to prevent brute force
        "/sign-in/email": {
          window: 60, // 1 minute
          max: 5, // Only 5 attempts per minute
        },
        // Strict rate limiting for password reset
        "/forget-password": {
          window: 300, // 5 minutes
          max: 3, // Only 3 requests per 5 minutes
        },
        // Strict rate limiting for 2FA verification
        "/two-factor/*": {
          window: 60,
          max: 5,
        },
        // Disable rate limiting for session checks
        "/get-session": false,
      },
    },
    // Advanced configuration for Cloudflare
    advanced: {
      ipAddress: {
        // Use Cloudflare's header for real IP address
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
        // Limit IPv6 by /64 subnet to prevent bypass attacks
        ipv6Subnet: 64,
      },
    },
    plugins: [
      twoFactor({
        issuer: appName,
        totpOptions: {
          digits: 6,
          period: 30,
        },
        backupCodeOptions: {
          length: 10,
          count: 10,
        },
        // Email OTP configuration for 2FA verification
        otpOptions: {
          async sendOTP({ user, otp }) {
            const { sendEmail } = await import("@/lib/email");
            await sendEmail({
              to: user.email,
              subject: `Your ${appName} verification code`,
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                  <h2>Two-Factor Authentication</h2>
                  <p>Hi ${user.name},</p>
                  <p>Your verification code is:</p>
                  <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; padding: 20px; background-color: #f5f5f5; border-radius: 8px; margin: 20px 0;">
                    ${otp}
                  </p>
                  <p>This code expires in 5 minutes.</p>
                  <p style="color: #666;">If you didn't request this code, please ignore this email and ensure your account is secure.</p>
                  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
                  <p style="color: #999; font-size: 12px;">
                    This is an automated security email from ${appName}.
                  </p>
                </div>
              `,
              from: senderEmail,
              env,
            });
          },
          // OTP expires in 5 minutes
          period: 5,
        },
      }),
      admin({
        defaultRole: "user",
        adminRoles: ["admin"],
      }),
    ],
    trustedOrigins: baseURL ? [baseURL] : [],
  });
}

// Type for the auth instance
export type Auth = ReturnType<typeof createAuth>;

// Cached auth instance for reuse within the same environment
let cachedAuth: Auth | null = null;
let cachedEnvSignature: string | null = null;

/**
 * Get or create an auth instance.
 * Uses caching to avoid recreating the instance on every request.
 */
export function getAuth(env?: Env | NodeJS.ProcessEnv): Auth {
  // Create a signature to detect env changes
  const envSignature = env
    ? `${(env as Record<string, string>).BETTER_AUTH_SECRET || ""}:${(env as Record<string, string>).TURSO_DATABASE_URL || ""}`
    : `${process.env.BETTER_AUTH_SECRET || ""}:${process.env.TURSO_DATABASE_URL || ""}`;

  // Return cached instance if env hasn't changed
  if (cachedAuth && cachedEnvSignature === envSignature) {
    return cachedAuth;
  }

  // Create new instance
  const auth = createAuth(env);
  cachedAuth = auth;
  cachedEnvSignature = envSignature;

  return auth;
}
