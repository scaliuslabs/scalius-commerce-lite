import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { AccountSettingsWithPermissions } from "~/components/admin/AccountSettingsWithPermissions";
import { accountSecurityQueryOptions } from "~/lib/api.queries";
import type { AccountSecurity } from "~/types/api-responses";
import { RouteErrorComponent } from "~/lib/list-helpers";

export const Route = createFileRoute("/admin/settings/account")({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(accountSecurityQueryOptions());
  },
  head: () => ({ meta: [{ title: "Account Settings | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: AccountSettingsPage,
});

function AccountSettingsPage() {
  const { data: securityResult } = useSuspenseQuery(accountSecurityQueryOptions());
  const {
    user,
    permissions,
    isSuperAdmin: routeIsSuperAdmin,
  } = Route.useRouteContext();

  const security = securityResult as AccountSecurity;
  const userData = {
    ...user,
    twoFactorEnabled: user.twoFactorEnabled ?? false,
    twoFactorMethod: security.twoFactorMethod,
  };
  const isSuperAdmin = routeIsSuperAdmin || (security.isSuperAdmin ?? false);

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Account Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your account security and administrator access
        </p>
      </div>

      <AccountSettingsWithPermissions
        user={userData}
        permissions={permissions}
        isSuperAdmin={isSuperAdmin}
      />
    </div>
  );
}
