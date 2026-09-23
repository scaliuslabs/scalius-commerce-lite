/**
 * Sign-in layout: one card centred on the page background, the Scalius logo
 * inside it, the language switch below. Every /auth/* screen renders in the
 * card through <Outlet />.
 */
import { createFileRoute, Outlet } from "@tanstack/react-router";
import logoLight from "~/assets/logo-light.png";
import logoDark from "~/assets/logo-dark.png";
import { ThemeProvider, useTheme } from "~/components/admin/layout/ThemeProvider";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { LOCALES, setLocale, useLocale, useMessages } from "~/i18n";
import { authMessages } from "~/i18n/auth";
// See AppSidebar: bundled asset URLs are host-root and the prefix is runtime.
import { withDashboardBasePath } from "~/lib/dashboard-base-path";

export const Route = createFileRoute("/auth")({
  component: AuthLayout,
});

function AuthLayout() {
  return (
    <ThemeProvider>
      <AuthFrame />
    </ThemeProvider>
  );
}

function AuthFrame() {
  const t = useMessages(authMessages);
  const locale = useLocale();
  const { theme } = useTheme();
  return (
    // Top-anchored rather than centred, so a message appearing in the card never moves its heading.
    <main className="flex min-h-dvh flex-col items-center bg-background px-4 py-10">
      <div className="w-full max-w-md sm:mt-[12vh]">
        <Card className="flex flex-col gap-6 p-6 sm:p-8">
          <img
            src={withDashboardBasePath(theme === "dark" ? logoDark : logoLight)}
            alt="Scalius"
            width={350}
            height={98}
            className="h-8 w-auto self-start"
          />
          <Outlet />
        </Card>
        <nav aria-label={t("language")} className="mt-4 flex justify-center gap-1">
          {LOCALES.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant="ghost"
              size="sm"
              lang={option.value}
              aria-pressed={locale === option.value}
              onClick={() => setLocale(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </nav>
      </div>
    </main>
  );
}
