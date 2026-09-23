import { createFileRoute, redirect } from "@tanstack/react-router";
import { TwoFactorForm } from "~/components/auth/TwoFactorForm";
import { readDashboardSession } from "~/lib/auth-guards";

export const Route = createFileRoute("/auth/two-factor")({
  beforeLoad: async () => {
    const { session } = await readDashboardSession();

    if (session?.user) {
      // 2FA not enabled or already verified -> go to admin
      if (!session.user.twoFactorEnabled || session.twoFactorVerified) {
        throw redirect({ to: "/admin" });
      }
      // User has session but needs 2FA verification -> show form
    }
    // No session: allow access (Better Auth uses cookies for pending 2FA state)
  },
  head: () => ({
    meta: [{ title: "Two-Factor Authentication - Scalius Admin" }],
  }),
  component: TwoFactorPage,
});

function TwoFactorPage() {
  return <TwoFactorForm />;
}
