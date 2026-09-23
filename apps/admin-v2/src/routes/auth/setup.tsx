import { createFileRoute, redirect } from "@tanstack/react-router";
import { SetupForm } from "~/components/auth/SetupForm";
import { getSetupStatus } from "~/lib/api-server-fns";
import { checkAdminExists } from "~/lib/auth.fns";

export const Route = createFileRoute("/auth/setup")({
  beforeLoad: async () => {
    // Only accessible when no admin users exist in the shared Better Auth D1 database.
    const adminExists = await checkAdminExists();
    if (adminExists) {
      throw redirect({ to: "/auth/login" });
    }
    // The API decides whether setup is token-gated (Platform setting). A
    // failed read must not block the form: the API rejects an unaccompanied
    // request anyway, so the gate is never weakened by guessing here.
    const setupTokenRequired = await getSetupStatus()
      .then((status) => status.setupTokenRequired === true)
      .catch(() => false);
    return { setupTokenRequired };
  },
  head: () => ({
    meta: [{ title: "Setup - Scalius Admin" }],
  }),
  component: SetupPage,
});

function SetupPage() {
  const { setupTokenRequired } = Route.useRouteContext();
  return <SetupForm setupTokenRequired={setupTokenRequired} />;
}
