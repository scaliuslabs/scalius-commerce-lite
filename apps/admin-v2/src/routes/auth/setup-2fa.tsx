import { createFileRoute, redirect } from "@tanstack/react-router";
import { TwoFactorSetup } from "~/components/auth/TwoFactorSetup";
import { translate } from "~/i18n";
import { authMessages } from "~/i18n/auth";
import { readDashboardSession } from "~/lib/auth-guards";

export const Route = createFileRoute("/auth/setup-2fa")({
  beforeLoad: async () => {
    const { session } = await readDashboardSession();
    if (!session) throw redirect({ to: "/auth/login" });
    if (session.user.mustChangePassword) throw redirect({ to: "/auth/forgot-password" });
    if (session.user.twoFactorEnabled) {
      throw redirect({ to: session.twoFactorVerified ? "/admin" : "/auth/two-factor" });
    }
    return { userEmail: session.user.email };
  },
  head: () => ({ meta: [{ title: `${translate(authMessages, "setupTwoFactorTitle")} · Scalius` }] }),
  component: Setup2faPage,
});

function Setup2faPage() {
  const { userEmail } = Route.useRouteContext();
  return <TwoFactorSetup userEmail={userEmail} />;
}
