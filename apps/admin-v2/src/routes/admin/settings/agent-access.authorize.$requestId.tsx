import { createFileRoute, redirect } from "@tanstack/react-router";
import { getApiV1Platform } from "@scalius/api-client/sdk";

import { AuthorizationApprovalPage } from "~/components/admin/agent-access";
import { ADMIN_ACCESS_DENIED_PATH } from "~/lib/admin-access";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData } from "~/lib/api";
import { getFreshAdminRouteContext } from "~/lib/admin-route-context";
import { RouteErrorComponent } from "~/lib/route-error";

/** The Platform API URL, as resolved by the API Worker that serves this page. */
async function getTrustedApiOrigin(): Promise<string> {
  const { apiUrl } = await apiData(getApiV1Platform());
  if (!apiUrl) throw new Error("Agent authorization is not configured");
  const url = new URL(apiUrl);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("Agent authorization origin is invalid");
  }
  return url.origin;
}

/** Approving an AI assistant needs a fresh Super Admin session that can manage access. */
export async function requireFreshAgentApprovalAuthority() {
  const context = await getFreshAdminRouteContext();
  if (
    !context.isSuperAdmin ||
    !context.permissions.includes(ADMIN_PERMISSIONS.AGENT_ACCESS_MANAGE)
  ) {
    throw redirect({ to: ADMIN_ACCESS_DENIED_PATH, replace: true });
  }
  return context;
}

export const Route = createFileRoute(
  "/admin/settings/agent-access/authorize/$requestId",
)({
  beforeLoad: requireFreshAgentApprovalAuthority,
  loader: () => getTrustedApiOrigin(),
  head: () => ({
    meta: [
      { title: "Connect an app | Scalius Admin" },
      { name: "referrer", content: "no-referrer" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  errorComponent: RouteErrorComponent,
  component: AgentAuthorizationRoute,
});

function AgentAuthorizationRoute() {
  const { requestId } = Route.useParams();
  return (
    <AuthorizationApprovalPage
      requestId={requestId}
      trustedApiOrigin={Route.useLoaderData()}
    />
  );
}
