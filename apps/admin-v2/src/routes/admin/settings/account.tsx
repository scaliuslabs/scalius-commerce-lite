import { createFileRoute } from "@tanstack/react-router";
import { AccountSettingsWithPermissions } from "~/components/admin/AccountSettingsWithPermissions";
import { getAccountSecurity, getAdminUsers, getRbacPermissions } from "~/lib/api.functions";

export const Route = createFileRoute("/admin/settings/account")({
  loader: async () => {
    const [securityResult, usersResult, permissionsResult] = await Promise.all([
      getAccountSecurity().catch(() => ({ twoFactorMethod: null, isSuperAdmin: false })),
      getAdminUsers().catch(() => []),
      getRbacPermissions().catch(() => []),
    ]);
    const security = securityResult as any;
    return {
      userData: {
        id: "",
        name: "Admin",
        email: "",
        image: null,
        role: "admin",
        twoFactorEnabled: !!security.twoFactorMethod,
        twoFactorMethod: security.twoFactorMethod,
      },
      permissions: Array.isArray(permissionsResult) ? permissionsResult.map((p: any) => p.name || p.id || p) : [],
      isSuperAdmin: security.isSuperAdmin ?? false,
    };
  },
  head: () => ({ meta: [{ title: "Account Settings | Scalius Admin" }] }),
  component: AccountSettingsPage,
});

function AccountSettingsPage() {
  const { userData, permissions, isSuperAdmin } = Route.useLoaderData();

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
