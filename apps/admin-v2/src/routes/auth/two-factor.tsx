import { createFileRoute, redirect } from "@tanstack/react-router";
import { TwoFactorForm } from "~/components/auth/TwoFactorForm";
import { readDashboardSession } from "~/lib/auth-guards";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/auth/two-factor")({
  beforeLoad: async () => {
    // Without a session, Better Auth's pending-2FA cookie carries the sign-in.
    const { session } = await readDashboardSession();
    if (session && (!session.user.twoFactorEnabled || session.twoFactorVerified)) {
      throw redirect({ to: "/admin" });
    }
  },
  head: () => pageHead("twoFactor"),
  component: TwoFactorForm,
});
