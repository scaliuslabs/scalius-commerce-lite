import {
  createFileRoute,
  Outlet,
  redirect,
  useRouterState,
} from "@tanstack/react-router";

import { AgentAccessSettingsPage } from "~/components/admin/agent-access";
import { agentConnectionsQueryOptions } from "~/components/admin/agent-access/api";
import { ADMIN_ACCESS_DENIED_PATH } from "~/lib/admin-access";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { getFreshAdminRouteContext } from "~/lib/admin-route-context";
import { RouteErrorComponent } from "~/lib/route-error";

export async function requireFreshAgentAccessViewAuthority() {
  const context = await getFreshAdminRouteContext();
  if (
    !context.isSuperAdmin &&
    !context.permissions.includes(ADMIN_PERMISSIONS.AGENT_ACCESS_VIEW)
  ) {
    throw redirect({ to: ADMIN_ACCESS_DENIED_PATH, replace: true });
  }
  return context;
}

export const Route = createFileRoute("/admin/settings/agent-access")({
  beforeLoad: requireFreshAgentAccessViewAuthority,
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(agentConnectionsQueryOptions());
  },
  head: () => ({ meta: [{ title: "Agent Access | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: AgentAccessRoute,
});

function AgentAccessRoute() {
  const isAgentAccessChild = useRouterState({
    select: (state) =>
      state.location.pathname !== "/admin/settings/agent-access",
  });
  const context = Route.useRouteContext();

  if (isAgentAccessChild) return <Outlet />;

  return (
    <AgentAccessSettingsPage
      availablePermissions={[...context.permissions].sort()}
      canManage={
        context.isSuperAdmin &&
        context.permissions.includes(ADMIN_PERMISSIONS.AGENT_ACCESS_MANAGE)
      }
    />
  );
}
