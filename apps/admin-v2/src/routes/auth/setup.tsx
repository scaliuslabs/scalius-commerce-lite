import { createFileRoute, redirect } from "@tanstack/react-router";
import { getApiV1Setup } from "@scalius/api-client/sdk";
import { SetupForm } from "~/components/auth/SetupForm";
import { translate } from "~/i18n";
import { authMessages } from "~/i18n/auth";
import { apiData } from "~/lib/api";
import { readDashboardSession } from "~/lib/auth-guards";

export const Route = createFileRoute("/auth/setup")({
  beforeLoad: async () => {
    // Only accessible while no administrator exists.
    const { adminExists } = await readDashboardSession();
    if (adminExists) throw redirect({ to: "/auth/login" });
    // The API decides whether setup is token-gated (Platform setting). A
    // failed read must not block the form: the API rejects an unaccompanied
    // request anyway, so the gate is never weakened by guessing here.
    const setupTokenRequired = await apiData(getApiV1Setup())
      .then((status) => status.setupTokenRequired === true)
      .catch(() => false);
    return { setupTokenRequired };
  },
  head: () => ({ meta: [{ title: `${translate(authMessages, "setupTitle")} · Scalius` }] }),
  component: SetupPage,
});

function SetupPage() {
  const { setupTokenRequired } = Route.useRouteContext();
  return <SetupForm setupTokenRequired={setupTokenRequired} />;
}
