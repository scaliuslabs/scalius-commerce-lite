/**
 * Route guards for the static dashboard.
 *
 * Every decision comes from one read of the API Worker's
 * `GET <dashboard>/api/auth/dashboard-session` (apps/api/src/dashboard/auth.ts):
 * whether an administrator exists, the signed-in user and their 2FA state,
 * and — only once every sign-in gate has passed — their RBAC permissions.
 * The guards redirect; the admin API enforces the same gates on every call.
 */
import { redirect } from "@tanstack/react-router";
import { AdminApiResponseError } from "./admin-api-error";
import { withDashboardBasePath } from "./dashboard-base-path";

export interface DashboardSessionState {
  adminExists: boolean;
  signIn: { localLoginDisabled: boolean; identityHandoffEnabled: boolean };
  session: null | {
    user: {
      id: string;
      name: string;
      email: string;
      image: string | null;
      role: string | null;
      twoFactorEnabled: boolean;
      mustChangePassword: boolean;
      mustEnrollTwoFactor: boolean;
      isSuperAdmin: boolean;
    };
    twoFactorVerified: boolean;
    permissions: string[] | null;
  };
  /** Someone else ended this browser's session (suspended, removed, signed out elsewhere). */
  signedOut?: "access_changed";
}

export type AdminRouteContext = {
  user: NonNullable<DashboardSessionState["session"]>["user"];
  permissions: string[];
  isSuperAdmin: boolean;
  hasAdminAccess: boolean;
};

export async function readDashboardSession(): Promise<DashboardSessionState> {
  const response = await fetch(withDashboardBasePath("/api/auth/dashboard-session"), {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  // The server answered: carry its status, so a 502 reads as "Scalius isn't
  // responding" rather than as the merchant's connection being down.
  if (!response.ok) throw new AdminApiResponseError("Dashboard session is unavailable", response.status);
  return response.json() as Promise<DashboardSessionState>;
}

/** Signed in, password set, 2FA enrolled when required and verified. */
export async function adminRouteGuard(): Promise<AdminRouteContext> {
  const { session } = await readDashboardSession();
  if (!session) throw redirect({ to: "/auth/login" });
  const { user } = session;
  if (user.mustChangePassword) throw redirect({ to: "/auth/forgot-password" });
  if (user.mustEnrollTwoFactor && !user.twoFactorEnabled) throw redirect({ to: "/auth/setup-2fa" });
  if (user.twoFactorEnabled && !session.twoFactorVerified) throw redirect({ to: "/auth/two-factor" });

  const permissions = session.permissions ?? [];
  return {
    user,
    permissions,
    isSuperAdmin: user.isSuperAdmin,
    hasAdminAccess: user.isSuperAdmin || permissions.length > 0,
  };
}

/**
 * The sign-in page: setup first, then send signed-in users onward. When the
 * server says someone else ended this browser's session, the page says why
 * (the reason comes from the session read, never from the URL).
 */
export async function loginPageGuard() {
  const { adminExists, signIn, session, signedOut } = await readDashboardSession();
  if (!adminExists) throw redirect({ to: "/auth/setup" });
  if (session) {
    const { user } = session;
    if (user.mustChangePassword) throw redirect({ to: "/auth/forgot-password" });
    if (user.twoFactorEnabled && !session.twoFactorVerified) throw redirect({ to: "/auth/two-factor" });
    if (user.mustEnrollTwoFactor && !user.twoFactorEnabled) throw redirect({ to: "/auth/setup-2fa" });
    throw redirect({ to: "/admin" });
  }
  return { signIn, signedOut };
}
