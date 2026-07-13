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
