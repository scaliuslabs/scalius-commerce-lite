/**
 * Auth layout route.
 *
 * Adds the /auth URL segment and wraps all auth pages with a centered
 * layout showing the logo. Child routes render inside <Outlet />.
 *
 * Routes: /auth/login, /auth/forgot-password, /auth/reset-password,
 *         /auth/setup, /auth/setup-2fa, /auth/two-factor
 */

import { createFileRoute, Outlet } from "@tanstack/react-router";
import logoLight from "~/assets/logo-light.png";
import logoDark from "~/assets/logo-dark.png";

export const Route = createFileRoute("/auth")({
  component: AuthLayout,
});

function AuthLayout() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-background text-foreground">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <img
            src={logoLight}
            alt="Scalius"
            className="mx-auto block h-14 dark:hidden"
          />
          <img
            src={logoDark}
            alt="Scalius"
            className="mx-auto hidden h-14 dark:block"
          />
        </div>

        <Outlet />
      </div>
    </main>
  );
}
