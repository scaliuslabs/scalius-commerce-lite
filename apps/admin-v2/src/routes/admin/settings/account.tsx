import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { AccountSettings } from "~/components/admin/account-settings";
import { accountSecurityQueryOptions } from "~/lib/api-query-options/auth-management";
import type { AccountSecurity } from "~/types/api-responses";
import { RouteErrorComponent } from "~/lib/route-error";
import { normalizeAccountSection } from "~/components/admin/account-settings/account-sections";
import type { AccountSection } from "~/components/admin/account-settings/account-sections";

export function validateAccountSearch(search: Record<string, unknown>) {
  return { section: normalizeAccountSection(search.section) };
}

export const Route = createFileRoute("/admin/settings/account")({
  validateSearch: validateAccountSearch,
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(accountSecurityQueryOptions());
  },
  head: () => ({ meta: [{ title: "Account | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: AccountSettingsPage,
});

function AccountSettingsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { data: securityResult } = useSuspenseQuery(accountSecurityQueryOptions());
  const { user } = Route.useRouteContext();

  const security = securityResult as AccountSecurity;
  const userData = {
    ...user,
    twoFactorEnabled: user.twoFactorEnabled ?? false,
    twoFactorMethod: security.twoFactorMethod,
  };
  const handleSectionChange = useCallback(
    (section: AccountSection, options?: { replace?: boolean }) => {
      void navigate({
        replace: options?.replace ?? false,
        search: ((previous: Record<string, unknown>) => ({
          ...previous,
          section,
        })) as never,
      });
    },
    [navigate],
  );

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight">Account</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Manage your identity, sign-in security, and store access.
        </p>
      </div>

      <AccountSettings
        user={userData}
        section={search.section}
        onSectionChange={handleSectionChange}
      />
    </div>
  );
}
