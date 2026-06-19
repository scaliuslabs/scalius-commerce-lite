/**
 * Auth layout route.
 *
 * Adds the /auth URL segment and wraps all auth pages with a centered
 * layout showing the logo. Child routes render inside <Outlet />.
 *
 * Includes tab-order fix for auth forms (MutationObserver-based,
 * matching the original Astro AuthLayout behavior exactly).
 *
 * Routes: /auth/login, /auth/forgot-password, /auth/reset-password,
 *         /auth/setup, /auth/setup-2fa, /auth/two-factor
 */

import { useEffect } from "react";
import { createFileRoute, Outlet, Link } from "@tanstack/react-router";
import logoLight from "~/assets/logo-light.png";
import logoDark from "~/assets/logo-dark.png";

export const Route = createFileRoute("/auth")({
  component: AuthLayout,
});

/**
 * Fix tab order for auth form inputs.
 * Replicates the original Astro AuthLayout inline script behavior:
 * - Sets tabindex on email, password inputs, and forgot-password link
 * - Intercepts Tab on email to focus password directly
 */
function useTabOrderFix() {
  useEffect(() => {
    let activeEmailInput: HTMLElement | null = null;

    function handleEmailKeydown(e: KeyboardEvent) {
      if (e.key !== "Tab" || e.shiftKey) return;

      const passwordInput = document.querySelector(
        'input[type="password"], input[name="password"]',
      ) as HTMLElement | null;

      if (!passwordInput) return;
      e.preventDefault();
      passwordInput.focus();
    }

    function fixTabOrder() {
      const emailInput = document.querySelector(
        'input[type="email"], input[name="email"]',
      ) as HTMLElement | null;
      const passwordInput = document.querySelector(
        'input[type="password"], input[name="password"]',
      ) as HTMLElement | null;
      const forgotLink = document.querySelector(
        'a[href*="forgot"]',
      ) as HTMLElement | null;

      if (emailInput) emailInput.setAttribute("tabindex", "1");
      if (passwordInput) passwordInput.setAttribute("tabindex", "2");
      if (forgotLink) forgotLink.setAttribute("tabindex", "4");

      if (emailInput !== activeEmailInput) {
        activeEmailInput?.removeEventListener("keydown", handleEmailKeydown);
        activeEmailInput = emailInput;
        activeEmailInput?.addEventListener("keydown", handleEmailKeydown);
      }
    }

    // Wait for React to render the form
    const timeout = setTimeout(fixTabOrder, 100);

    // Observe for dynamic changes across auth forms.
    const observer = new MutationObserver(fixTabOrder);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      clearTimeout(timeout);
      observer.disconnect();
      activeEmailInput?.removeEventListener("keydown", handleEmailKeydown);
    };
  }, []);
}

function AuthLayout() {
  useTabOrderFix();

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-background text-foreground">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <Link to="/admin" className="inline-block">
            <img
              src={logoLight}
              alt="Logo"
              className="h-14 mx-auto block dark:hidden"
            />
            <img
              src={logoDark}
              alt="Logo"
              className="h-14 mx-auto hidden dark:block"
            />
          </Link>
        </div>

        {/* Auth form content */}
        <Outlet />
      </div>
    </main>
  );
}
