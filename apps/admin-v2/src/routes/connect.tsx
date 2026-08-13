import { createFileRoute, redirect } from "@tanstack/react-router";

import { DevicePairingPage } from "~/components/admin/agent-access";
import { ThemeProvider } from "~/components/admin/layout/ThemeProvider";
import { DeferredToaster } from "~/components/ui/deferred-toaster";
import { ADMIN_ACCESS_DENIED_PATH } from "~/lib/admin-access";
import { getFreshAdminRouteContext } from "~/lib/admin-route-context";
import { RouteErrorComponent } from "~/lib/route-error";

export async function requireFreshCliPairingAuthority() {
  const context = await getFreshAdminRouteContext();
  if (!context.isSuperAdmin) {
    throw redirect({ to: ADMIN_ACCESS_DENIED_PATH, replace: true });
  }
  return context;
}

export const Route = createFileRoute("/connect")({
  beforeLoad: requireFreshCliPairingAuthority,
  head: () => ({
    meta: [
      { title: "Connect Scalius CLI" },
      { name: "referrer", content: "no-referrer" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  errorComponent: RouteErrorComponent,
  component: ConnectRoute,
});

function ConnectRoute() {
  const context = Route.useRouteContext();
  return (
    <ThemeProvider>
      <DevicePairingPage
        availablePermissions={[...context.permissions].sort()}
      />
      <DeferredToaster />
    </ThemeProvider>
  );
}
