import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ProfileHeader } from "~/components/admin/account-settings/ProfileHeader";
import { ChangePasswordForm } from "~/components/admin/account-settings/ChangePasswordForm";
import { TwoFactorSetup } from "~/components/admin/account-settings/TwoFactorSetup";
import { AccountSessions } from "~/components/admin/account-settings/AccountSessions";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { accountSecurityQueryOptions } from "~/lib/api-query-options/auth-management";
import { RouteErrorComponent } from "~/lib/route-error";
import { translate, useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";

export const Route = createFileRoute("/admin/account")({
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(accountSecurityQueryOptions()),
  head: () => ({ meta: [{ title: translate(shellMessages, "accountTitle") }] }),
  errorComponent: RouteErrorComponent,
  component: AccountPage,
});

/** My account: the signed-in person's profile, password, two-step verification and sessions. */
function AccountPage() {
  const t = useMessages(shellMessages);
  const { user } = Route.useRouteContext();
  const { data: security } = useSuspenseQuery(accountSecurityQueryOptions());
  const accountUser = {
    ...user,
    twoFactorEnabled: user.twoFactorEnabled ?? false,
    twoFactorMethod: security.twoFactorMethod,
  };

  return (
    <div className="mx-auto max-w-3xl pb-8">
      <PageHeader title={t("accountTitle")} />
      <div className="space-y-4">
        <ProfileHeader user={accountUser} />
        <ChangePasswordForm />
        <TwoFactorSetup user={accountUser} />
        <AccountSessions />
      </div>
    </div>
  );
}
