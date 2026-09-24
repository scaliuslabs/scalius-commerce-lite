// src/lib/auth.ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor, admin } from "better-auth/plugins";
import { and, eq, like, ne } from "drizzle-orm";
import { getDb, safeBatch } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import {
  EMPTY_IDENTITY_HANDOFF_CONFIG,
  dashboardBasePathFromUrl,
  joinPlatformUrl,
  type PlatformConfig,
} from "@scalius/shared/platform-config";
import { identityHandoff } from "./identity-handoff";
import { createTwoFactorRecoveryCodeStorage, generateRecoveryCodes } from "./two-factor-method-challenge";
import {
  PASSWORD_RESET_TTL_SECONDS,
  STAFF_INVITE_TTL_SECONDS,
  readStoreName,
  sendStaffPasswordChangedEmail,
  staffInviteEmail,
  staffPasswordResetEmail,
  staffSignInCodeEmail,
} from "./staff-emails";
import {
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
} from "./credential-account";
import { retryTransientD1 } from "../utils/transient-d1";

function getEmailRuntimeContext(env: Env) {
  const source = env as Record<string, unknown>;
  return {
    env: source,
    encryptionKey: source.CREDENTIAL_ENCRYPTION_KEY as string | undefined,
  };
}

function readString(env: Env, key: string): string | undefined {
  const value = (env as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPlatformConfig(env: Env): PlatformConfig | undefined {
  const value = (env as Record<string, unknown>).PLATFORM_CONFIG;
  return value && typeof value === "object" ? (value as PlatformConfig) : undefined;
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Create Better Auth instance with the request's composed environment.
 *
 * `BETTER_AUTH_SECRET` is derived from `SCALIUS_SECRET` at Worker entry and
 * `BETTER_AUTH_URL` is the dashboard URL resolved from Platform settings. The
 * dashboard URL may carry a path prefix; Better Auth receives the bare origin
 * as `baseURL` and the prefix inside `basePath`, while every dashboard link is
 * joined onto the full URL so the prefix survives. Nothing is read from
 * `process.env`; the request `Env` is the only source.
 */
export function createAuth(env: Env) {
  const db = getDb(env);

  const secret = readString(env, "BETTER_AUTH_SECRET");
  // The dashboard URL. Never the API origin: reset links open dashboard routes.
  const dashboardUrl = readString(env, "BETTER_AUTH_URL");
  const baseURL = originOf(dashboardUrl);
  const dashboardBasePath = dashboardBasePathFromUrl(dashboardUrl);
  const storefrontURL = originOf(readString(env, "STOREFRONT_URL"));
  const appName = "Scalius Commerce";
  const emailRuntimeContext = getEmailRuntimeContext(env);
  const platform = readPlatformConfig(env);
  const handoffConfig = platform?.identityHandoff ?? EMPTY_IDENTITY_HANDOFF_CONFIG;

  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is not set. It is derived from SCALIUS_SECRET at Worker entry.");
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
        rateLimit: schema.rateLimit,
      },
    }),
    secret,
    baseURL,
    // The API Worker serves these routes on the dashboard host, below its base path.
    basePath: `${dashboardBasePath}/api/auth`,
    appName,
    emailAndPassword: {
      // An operator-managed identity provider may switch password sign-in
      // off; the Platform settings only allow that while the handoff is on.
      enabled: !handoffConfig.localLoginDisabled,
      requireEmailVerification: false,
      minPasswordLength: AUTH_PASSWORD_MIN_LENGTH,
      maxPasswordLength: AUTH_PASSWORD_MAX_LENGTH,
      // Staff invites reuse this token; sendResetPassword extends theirs to 7 days.
      resetPasswordTokenExpiresIn: PASSWORD_RESET_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }: {
        user: { id: string; email: string; name: string };
        token: string;
      }) => {
        if (!dashboardUrl) {
          throw new Error("BETTER_AUTH_URL is required for password reset links");
        }
        const { sendEmail } = await import("../integrations/email");
        const inviteState = await db
          .select({
            role: schema.user.role,
            mustChangePassword: schema.user.mustChangePassword,
            invitationId: schema.adminInvitations.id,
            invitationStatus: schema.adminInvitations.status,
            invitedByUserId: schema.adminInvitations.invitedByUserId,
          })
          .from(schema.user)
          .leftJoin(
            schema.adminInvitations,
            eq(schema.adminInvitations.userId, schema.user.id),
          )
          .where(eq(schema.user.id, user.id))
          .get();
        const invitationId = inviteState?.invitationId ?? null;
        const isAdminInviteSetup = inviteState?.role === "admin"
          && inviteState.mustChangePassword === true
          && inviteState.invitationStatus === "pending";
        const identifier = `reset-password:${token}`;
        const sentAt = new Date();
        const expiresAt = new Date(sentAt.getTime() + (isAdminInviteSetup ? STAFF_INVITE_TTL_SECONDS : PASSWORD_RESET_TTL_SECONDS) * 1000);
        // One live link per person: a new invite or reset link replaces the older ones.
        await safeBatch(db, [
          db.delete(schema.verification).where(and(
            like(schema.verification.identifier, "reset-password:%"),
            eq(schema.verification.value, user.id),
            ne(schema.verification.identifier, identifier),
          )),
          db.update(schema.verification)
            .set({ expiresAt, updatedAt: sentAt })
            .where(eq(schema.verification.identifier, identifier)),
        ]);

        const link = new URL(joinPlatformUrl(dashboardUrl, "/auth/reset-password"));
        // Fragments are not sent to Cloudflare or included in Referer. The
        // dashboard exchanges and removes this one-time value immediately.
        link.hash = `${isAdminInviteSetup ? "invite" : "token"}=${encodeURIComponent(token)}`;
        const store = await readStoreName(db);
        const inviter = isAdminInviteSetup && inviteState?.invitedByUserId
          ? await db.select({ name: schema.user.name }).from(schema.user)
            .where(eq(schema.user.id, inviteState.invitedByUserId)).get()
          : undefined;
        const message = isAdminInviteSetup
          ? staffInviteEmail({ store, inviterName: inviter?.name.trim() || null, name: user.name, link: link.href })
          : staffPasswordResetEmail({ store, name: user.name, link: link.href });
        const delivery = await sendEmail({ to: user.email, ...message }, emailRuntimeContext);

        if (!delivery.success) {
          if (invitationId) {
            await db
              .update(schema.adminInvitations)
              .set({
                deliveryStatus: "failed",
                expiresAt: null,
                updatedAt: new Date(),
              })
              .where(eq(schema.adminInvitations.id, invitationId));
          }
          throw new Error("Password reset email delivery failed");
        }

        if (invitationId && isAdminInviteSetup) {
          await db
            .update(schema.adminInvitations)
            .set({
              deliveryStatus: "sent",
              lastSentAt: sentAt,
              expiresAt,
              updatedAt: sentAt,
            })
            .where(eq(schema.adminInvitations.id, invitationId));
        }
      },
      onPasswordReset: async ({ user }: { user: { id: string; name: string; email: string } }) => {
        const acceptedAt = new Date();
        let wasInvite = false;
        try {
          const before = await db
            .select({ mustChangePassword: schema.user.mustChangePassword })
            .from(schema.user)
            .where(eq(schema.user.id, user.id))
            .get();
          wasInvite = before?.mustChangePassword === true;
          await retryTransientD1(
            () => safeBatch(db, [
              db.update(schema.user)
                .set({ mustChangePassword: false, updatedAt: acceptedAt })
                .where(eq(schema.user.id, user.id)),
              db.update(schema.adminInvitations)
                .set({
                  status: "accepted",
                  acceptedAt,
                  updatedAt: acceptedAt,
                })
                .where(eq(schema.adminInvitations.userId, user.id)),
            ]),
            { delaysMs: [100, 250] },
          );
        } catch {
          // Better Auth revokes existing sessions after this callback returns.
          // Never let ancillary invitation bookkeeping prevent that revocation.
          console.error("Password-reset onboarding reconciliation failed");
        }
        // Accepting an invite sets a first password; only a real reset gets the notice.
        if (!wasInvite) {
          await sendStaffPasswordChangedEmail({ db, env: emailRuntimeContext.env, dashboardUrl, user });
        }
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // Update session every day
      additionalFields: {
        twoFactorVerified: {
          type: "boolean",
          fieldName: "twoFactorVerified",
          required: false,
          returned: true,
          input: false,
          defaultValue: false,
        },
      },
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5, // 5 minutes
      },
    },
    // Rate limiting configuration for security
    rateLimit: {
      enabled: true,
      // Workers isolates do not share memory. Keep abuse counters in D1 so
      // limits survive isolate churn and apply consistently across the edge.
      storage: "database",
      window: 60, // 60 seconds window
      max: 100, // 100 requests per window for general endpoints
      customRules: {
        // Strict rate limiting for sign-in to prevent brute force
        "/sign-in/email": {
          window: 60, // 1 minute
          max: 5, // Only 5 attempts per minute
        },
        // Strict rate limiting for password reset
        "/request-password-reset": {
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
      // Session cookies are scoped to the dashboard base path so a prefixed
      // dashboard never sends them to the storefront on a shared host.
      defaultCookieAttributes: {
        path: dashboardBasePath || "/",
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
          amount: 10,
          storeBackupCodes: createTwoFactorRecoveryCodeStorage(secret),
          customBackupCodesGenerate: generateRecoveryCodes,
        },
        otpOptions: {
          async sendOTP({ user, otp }) {
            const { sendEmail } = await import("../integrations/email");
            const message = staffSignInCodeEmail({ store: await readStoreName(db), name: user.name, code: otp });
            await sendEmail({ to: user.email, ...message }, emailRuntimeContext);
          },
          // OTP expires in 5 minutes
          period: 5,
        },
      }),
      admin({
        defaultRole: "user",
        adminRoles: ["admin"],
        // Sign-in answers a suspended staff member with this and the stable code BANNED_USER.
        bannedUserMessage: "Your access to this store is suspended. Contact the store owner.",
      }),
      identityHandoff({
        db,
        config: handoffConfig,
        hmacSecret: readString(env, "IDENTITY_HANDOFF_SECRET"),
        dashboardUrl,
        permissionCache: env.CACHE,
      }),
    ],
    trustedOrigins: [baseURL, storefrontURL].filter(Boolean) as string[],
  });
}

// Type for the auth instance
export type Auth = ReturnType<typeof createAuth>;

/**
 * Backward-compatible request-scoped auth factory.
 *
 * Better Auth closes over the request's database adapter and Worker bindings,
 * so retaining an instance in module scope can leak stale bindings or I/O
 * context into a later request. Keep this alias request-scoped like
 * `createAuth()`.
 */
export function getAuth(env: Env): Auth {
  return createAuth(env);
}
