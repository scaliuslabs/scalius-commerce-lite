// src/lib/auth-client.ts
import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";
import { storePendingTwoFactorMethods } from "./two-factor-pending";

// Create the auth client for use in React components
// Auth endpoints live on the admin worker (same-origin), not the API worker
export const authClient = createAuthClient({
  plugins: [
    twoFactorClient({
      onTwoFactorRedirect: (context) => {
        storePendingTwoFactorMethods(context?.twoFactorMethods);
      },
    }),
  ],
});

type PasswordVerificationResult =
  | { status: true; error: null }
  | { status: false; error: { message: string } };

/**
 * Confirm the signed-in administrator's current password without mutating
 * two-factor secrets, recovery codes, sessions, or account state.
 *
 * Better Auth intentionally exposes this endpoint as server-scoped, so it is
 * not part of the generated client surface even though the same-origin auth
 * handler serves it. Keep this narrow wrapper here instead of misusing a
 * state-changing auth endpoint as a password check.
 */
export async function verifyCurrentPassword(
  password: string,
): Promise<PasswordVerificationResult> {
  try {
    const response = await fetch("/api/auth/verify-password", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { status?: boolean; message?: string; error?: { message?: string } }
      | null;

    if (!response.ok || payload?.status !== true) {
      return {
        status: false,
        error: {
          message:
            payload?.message ??
            payload?.error?.message ??
            "Password confirmation failed",
        },
      };
    }

    return { status: true, error: null };
  } catch {
    return {
      status: false,
      error: { message: "Password confirmation is unavailable. Try again." },
    };
  }
}

// Export commonly used hooks and functions
export const {
  signIn,
  signUp,
  signOut,
  useSession,
  getSession,
  twoFactor,
} = authClient;

// Type exports for use in components
export type Session = typeof authClient.$Infer.Session;
export type User = Session["user"];
