import { createFileRoute, redirect } from "@tanstack/react-router";
import { TwoFactorForm } from "~/components/auth/TwoFactorForm";
import { translate } from "~/i18n";
import { authMessages } from "~/i18n/auth";
import { readDashboardSession } from "~/lib/auth-guards";

export const Route = createFileRoute("/auth/two-factor")({
  beforeLoad: async () => {
    // Without a session, Better Auth's pending-2FA cookie carries the sign-in.
    const { session } = await readDashboardSession();
    if (session && (!session.user.twoFactorEnabled || session.twoFactorVerified)) {
      throw redirect({ to: "/admin" });
    }
  },
  head: () => ({ meta: [{ title: `${translate(authMessages, "twoFactorTitle")} · Scalius` }] }),
  component: TwoFactorForm,
});
