import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { AccountSettings } from "~/components/admin/account-settings";
import { accountSecurityQueryOptions } from "~/lib/api-query-options/auth-management";
import type { AccountSecurity } from "~/types/api-responses";
import { RouteErrorComponent } from "~/lib/route-error";

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
  const { user } = Route.useRouteContext();

  const security = securityResult as AccountSecurity;
  const userData = {
    ...user,
    twoFactorEnabled: user.twoFactorEnabled ?? false,
    twoFactorMethod: security.twoFactorMethod,
  };

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Account Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your account security and administrator access
        </p>
      </div>

      <AccountSettings user={userData} />
    </div>
  );
}
