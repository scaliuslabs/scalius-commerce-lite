import { createFileRoute } from "@tanstack/react-router";
import { TwoFactorForm } from "~/components/auth/TwoFactorForm";
import { dashboardSignInDestination, readDashboardSession, signedInRedirect } from "~/lib/auth-guards";
import { signInReturnSearch } from "~/lib/sign-in-return";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/auth/two-factor")({
  // `next`: the dashboard page sign-in returns to (validated: never another site).
  validateSearch: signInReturnSearch,
  beforeLoad: async ({ search }) => {
    // Without a session, Better Auth's pending-2FA cookie carries the sign-in.
    const { session } = await readDashboardSession();
    if (session && dashboardSignInDestination(session) !== "/auth/two-factor") throw signedInRedirect(session, search.next);
  },
  head: () => pageHead("twoFactor"),
  component: TwoFactorPage,
});

function TwoFactorPage() {
  const { next } = Route.useSearch();
  return <TwoFactorForm next={next} />;
}
