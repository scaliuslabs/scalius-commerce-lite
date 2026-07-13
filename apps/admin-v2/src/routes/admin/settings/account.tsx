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
  head: () => ({ meta: [{ title: "My account | Scalius Admin" }] }),
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
    <div className="mx-auto max-w-6xl">
      <div className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight">My account</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Manage your profile, sign-in security, and store access.
        </p>
      </div>

      <AccountSettings user={userData} />
    </div>
  );
}
