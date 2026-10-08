/**
 * Settings → Notifications → Browser notifications: who sends the browser
 * notifications that signed-in buyers allow on their account page. Web Push is
 * built in; an installed app's push provider can send them instead. The choice
 * saves with the notification rules, under their revision. Staff alerts do not
 * use this choice: they always go by Web Push and Firebase.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { putApiV1AdminSettingsNotificationChannels } from "@scalius/api-client/sdk";
import { isReady } from "@scalius/shared/readiness";
import { Alert } from "~/components/ui/alert";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useOpenAppProvider } from "~/components/admin/apps/AppProviderSheetHost";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { useMessages } from "~/i18n";
import { appKindsMessages } from "~/i18n/settings-app-kinds";
import { appProvidersMessages } from "~/i18n/settings-app-providers";
import { settingsMessages } from "~/i18n/settings";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData } from "~/lib/api";
import { appProvidersQuery, customerRulesQuery } from "~/lib/api-query-options/settings-screens";
import { useProviderPortAccess } from "~/lib/provider-port-access";
import { AppProviderStatus, appProviderOption } from "./AppProviderStatus";
import { NoAppsLine } from "./AppKindCard";
import { pushProviderBody, type CustomerRules } from "./notification-channel-policy";
import { usePushIssueText } from "./push-issue-text";
import { SettingsCard, SettingsCardLoading, SettingsField } from "./SettingsPage";
import { SettingsLoadFailure } from "./SettingsLoadFailure";

/** The built-in sender's value in the select: an app provider's id is never empty. */
const BUILT_IN = "";

export function BrowserNotificationsCard() {
  const t = useMessages(appKindsMessages);
  const appT = useMessages(appProvidersMessages);
  const common = useMessages(settingsMessages);
  const pushIssueText = usePushIssueText();
  const queryClient = useQueryClient();
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT);
  const canSeeApps = useHasPermission(ADMIN_PERMISSIONS.APPS_VIEW);
  const openProvider = useOpenAppProvider();
  const apps = useQuery({ ...appProvidersQuery("push"), enabled: useProviderPortAccess("push").canView }).data ?? [];
  const { values, setValue, isLoadError, refetch } = useSettingsForm<CustomerRules>({
    label: t("browserTitle"),
    queryKey: customerRulesQuery.queryKey,
    fetchFn: customerRulesQuery.queryFn,
    saveFn: (draft, expectedRevision) => {
      // The rules another card saved a moment ago, not this card's older copy of them.
      const latest = queryClient.getQueryData<CustomerRules>(customerRulesQuery.queryKey) ?? draft;
      return apiData(putApiV1AdminSettingsNotificationChannels({
        body: pushProviderBody(latest.channels, draft.pushProvider ?? BUILT_IN, expectedRevision),
      }));
    },
    defaultValues: {} as CustomerRules,
    errorMessage: common("saveFailed"),
    canEdit,
  });
  if (isLoadError) return <SettingsLoadFailure title={t("browserLoadFailed")} onRetry={refetch} />;
  if (!values.channels) return <SettingsCardLoading />;
  const choice = values.pushProvider ?? BUILT_IN;
  const app = apps.find((candidate) => candidate.id === choice);
  const options = [
    { value: BUILT_IN, label: t("browserBuiltIn") },
    ...apps.map((candidate) => appProviderOption(candidate, appT)),
    // An app that is gone stays visible, so the choice can be changed back.
    ...(choice !== BUILT_IN && !app ? [{ value: choice, label: choice }] : []),
  ];
  const builtInIssue = choice === BUILT_IN && values.customerPush && !isReady(values.customerPush)
    ? pushIssueText(values.customerPush.issues[0])
    : null;
  return (
    <SettingsCard id="browserNotifications" title={t("browserTitle")} description={t("browserDescription")}>
      <SettingsField id="push-provider" label={t("sendWith")} help={choice === BUILT_IN ? t("browserBuiltInHelp") : undefined}>
        <SearchableSelect
          id="push-provider"
          value={choice}
          disabled={!canEdit}
          triggerClassName="w-full"
          options={options}
          onValueChange={(value) => {
            setValue("pushProvider", value);
            // An app not set up yet opens its own setup, beside this choice.
            const chosen = apps.find((candidate) => candidate.id === value);
            if (chosen && !chosen.readiness.configured && canSeeApps) openProvider?.(chosen.id);
          }}
        />
      </SettingsField>
      {app ? <AppProviderStatus provider={app} /> : null}
      {builtInIssue ? <Alert variant="warning">{builtInIssue}</Alert> : null}
      {apps.length === 0 ? <NoAppsLine>{t("browserEmpty")}</NoAppsLine> : null}
    </SettingsCard>
  );
}
