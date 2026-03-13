// src/lib/auth-client.ts
import { createAuthClient } from "better-auth/react";
import { twoFactorClient, adminClient } from "better-auth/client/plugins";

// Create the auth client for use in React components
export const authClient = createAuthClient({
  baseURL: import.meta.env.PUBLIC_API_BASE_URL || "",
  plugins: [
    twoFactorClient({
      onTwoFactorRedirect: () => {
        window.location.href = "/auth/two-factor";
      },
    }),
    adminClient(),
  ],
});

// Export commonly used hooks and functions
export const {
  signIn,
  signUp,
  signOut,
  useSession,
  getSession,
  twoFactor,
  admin,
} = authClient;

// Type exports for use in components
export type Session = typeof authClient.$Infer.Session;
export type User = Session["user"];
