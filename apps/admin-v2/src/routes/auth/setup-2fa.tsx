import { createFileRoute, redirect } from "@tanstack/react-router";
import { TwoFactorSetup } from "~/components/auth/TwoFactorSetup";
import { getSessionInfo } from "~/lib/auth.fns";

export const Route = createFileRoute("/auth/setup-2fa")({
  beforeLoad: async () => {
    const session = await getSessionInfo();

    // No session -> login
    if (!session) {
      throw redirect({ to: "/auth/login" });
    }

    // 2FA already enabled
    if (session.user.twoFactorEnabled) {
      if (session.session.twoFactorVerified) {
        throw redirect({ to: "/admin" });
      }
      throw redirect({ to: "/auth/two-factor" });
    }

    return { userEmail: session.user.email };
  },
  head: () => ({
    meta: [{ title: "Setup Two-Factor Authentication - Scalius Admin" }],
  }),
  component: Setup2faPage,
});

function Setup2faPage() {
  const { userEmail } = Route.useRouteContext() as { userEmail: string };
  return <TwoFactorSetup userEmail={userEmail} />;
}
