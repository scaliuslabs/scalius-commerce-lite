import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { AccountSettingsWithPermissions } from "~/components/admin/AccountSettingsWithPermissions";
import {
  accountSecurityQueryOptions,
  rbacPermissionsQueryOptions,
} from "~/lib/api.queries";
import type { AccountSecurity, RbacPermission } from "~/types/api-responses";
import { RouteErrorComponent } from "~/lib/list-helpers";

export const Route = createFileRoute("/admin/settings/account")({
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(accountSecurityQueryOptions()),
      queryClient.ensureQueryData(rbacPermissionsQueryOptions()),
    ]);
  },
  head: () => ({ meta: [{ title: "Account Settings | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: AccountSettingsPage,
});

function AccountSettingsPage() {
  const { data: securityResult } = useSuspenseQuery(accountSecurityQueryOptions());
  const { data: permissionsResult } = useSuspenseQuery(rbacPermissionsQueryOptions());

  const security = securityResult as AccountSecurity;
  const userData = {
    id: "",
    name: "Admin",
    email: "",
    image: null,
    role: "admin",
    twoFactorEnabled: !!security.twoFactorMethod,
    twoFactorMethod: security.twoFactorMethod,
  };
  const permsList: RbacPermission[] = permissionsResult.permissions;
  const permissions = permsList.map((p) => p.name || p.id);
  const isSuperAdmin = security.isSuperAdmin ?? false;

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
