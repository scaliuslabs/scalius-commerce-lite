import { createFileRoute, redirect } from "@tanstack/react-router";
import { ForgotPasswordForm } from "~/components/auth/ForgotPasswordForm";
import { readDashboardSession } from "~/lib/auth-guards";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/auth/forgot-password")({
  beforeLoad: async () => {
    // A signed-in user only lands here to finish a required password change.
    const { session } = await readDashboardSession();
    if (session && !session.user.mustChangePassword) throw redirect({ to: "/admin" });
    return { signedInEmail: session?.user.email };
  },
  head: () => pageHead("forgotPassword"),
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const { signedInEmail } = Route.useRouteContext();
  return <ForgotPasswordForm signedInEmail={signedInEmail} />;
}
