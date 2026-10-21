import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { isTemplatedNotificationType, type NotificationType } from "@scalius/core/modules/notifications/browser";
import {
  getApiV1AdminSettingsAuth,
  getApiV1AdminSettingsEmail,
  getApiV1AdminSettingsSms,
  postApiV1AdminSettingsAuth,
  postApiV1AdminSettingsEmail,
  postApiV1AdminSettingsSms,
  putApiV1AdminSettingsNotificationChannels,
  putApiV1AdminSettingsNotificationChannelsAdminChannels,
} from "@scalius/api-client/sdk";
import { isQualifiedProviderId, parseQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { isReady } from "@scalius/shared/readiness";
import { Alert } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { useProviderPortAccess } from "~/lib/provider-port-access";
import { apiData, type ApiBody, type ApiResult } from "~/lib/api";
import {
  appProvidersQuery,
  authQuery,
  customerRulesQuery,
  emailQuery,
  smsQuery,
  type AppProvider,
} from "~/lib/api-query-options/settings-screens";
import { useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { notificationEventMessages } from "~/i18n/notification-events";
import { notificationsMessages } from "~/i18n/settings-notifications";
import { appProvidersMessages } from "~/i18n/settings-app-providers";
import {
  CUSTOMER_EVENT_GROUPS,
  CUSTOMER_NOTIFICATION_CHANNELS,
  STAFF_EVENT_GROUPS,
  adminChannelAllowed,
  buildAdminNotificationConfig,
  customerChannelAllowed,
  buildCustomerNotificationConfig,
  serializeAdminNotificationConfig,
  serializeCustomerNotificationConfig,
  type CustomerRules,
  type NotificationEventGroup,
} from "./notification-channel-policy";
import { AppProviderStatus, appProviderOption } from "./AppProviderStatus";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { usePushIssueText } from "./push-issue-text";
import { webPushMessages } from "~/i18n/settings-web-push";
import { SettingsCard, SettingsDialog, SettingsField, SettingsRow, SettingsCardLoading } from "./SettingsPage";
import { FieldRow } from "~/components/ui/field";
import { appProviderSetupPath } from "~/components/admin/apps/app-sections";

/** Saved secrets come back masked; sending the mask back keeps them. */
export const MASKED_VALUE = "••••••••••••";

type EmailSettings = ApiResult<typeof getApiV1AdminSettingsEmail>;
type SmsSettings = ApiResult<typeof getApiV1AdminSettingsSms>;
type AuthSettings = ApiResult<typeof getApiV1AdminSettingsAuth>;

function useCanEditNotifications() {
  return useHasPermission(ADMIN_PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT);
}

function toggled<T extends string>(list: readonly T[] | undefined, item: T): T[] {
  const current = list ?? [];
  return current.includes(item) ? current.filter((value) => value !== item) : [...current, item];
}

// ── Customer and staff rules ────────────────────────────────────────────

/**
 * A channel that isn't set up can't be switched on (the server refuses it);
 * rules already on stay visible so they can be switched off.
 */
function RulesTable({
  groups,
  columns,
  isOn,
  allowed,
  onToggle,
  disabled,
  linkEvents = false,
  rowIdPrefix,
}: {
  groups: readonly NotificationEventGroup[];
  columns: ReadonlyArray<{ key: string; label: string; ready: boolean }>;
  isOn: (event: NotificationType, column: string) => boolean;
  /** Channels an event can't use show no checkbox. */
  allowed: (event: NotificationType, column: string) => boolean;
  onToggle: (event: NotificationType, column: string) => void;
  disabled: boolean;
  /** Templated message names (order events, digital, gift card, review request) open that message's editor. */
  linkEvents?: boolean;
  /** Gives each row an anchor (`#<prefix>-<event>`) other screens can link to. */
  rowIdPrefix?: string;
}) {
  const events = useMessages(notificationEventMessages);
  const t = useMessages(notificationsMessages);
  // Column headings (caption size): each channel column is as wide as its
  // name on one line with room on both sides, so long Bangla names
  // ("হোয়াটসঅ্যাপ") never run into the next one; the event names wrap instead.
  return (
    <table className="w-full text-body">
      <thead>
        <tr className="border-b border-border align-bottom text-muted-foreground">
          <th className="py-2 pe-2 text-start text-caption font-medium">{t("event")}</th>
          {columns.map((column) => (
            <th key={column.key} className="whitespace-nowrap px-1.5 py-2 text-center text-caption font-medium sm:w-24">{column.label}</th>
          ))}
        </tr>
      </thead>
      {groups.map((group) => (
        <tbody key={group.key}>
          <tr className="h-[calc(2lh+12px)]">
            <th colSpan={columns.length + 1} className="py-1.5 text-start font-semibold">
              <span className="flex min-h-11 items-center sm:min-h-0">{events(group.key)}</span>
            </th>
          </tr>
          {group.events.map((event) => (
            <tr key={event} id={rowIdPrefix ? `${rowIdPrefix}-${event}` : undefined} className="h-[calc(2lh+12px)] scroll-mt-20 border-t border-border">
              <td className="py-1.5 pe-2">
                {linkEvents && isTemplatedNotificationType(event) ? (
                  <Link
                    to="/admin/settings/notifications/$event"
                    params={{ event }}
                    aria-label={t("editMessage", { event: events(event) })}
                    title={events(event)}
                    className="flex min-h-11 min-w-6 items-center text-link hover:underline sm:min-h-6"
                  >
                    {/* The 44px phone target centres its text on the row, beside the checkboxes (T4). */}
                    <span className="line-clamp-2">{events(event)}</span>
                  </Link>
                ) : (
                  <span title={events(event)} className="flex min-h-11 items-center sm:min-h-6">
                    <span className="line-clamp-2">{events(event)}</span>
                  </span>
                )}
              </td>
              {columns.map((column) => (
                <td key={column.key} className="text-center">
                  {allowed(event, column.key) ? (
                    <label className="inline-grid size-11 place-items-center">
                      <Checkbox
                        checked={isOn(event, column.key)}
                        disabled={disabled || (!column.ready && !isOn(event, column.key))}
                        aria-label={`${events(event)}: ${column.label}`}
                        onCheckedChange={() => onToggle(event, column.key)}
                      />
                    </label>
                  ) : (
                    <span className="text-muted-foreground" aria-label={`${events(event)}: ${column.label} ${t("notAvailable")}`}>–</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
}

export function CustomerNotificationsCard() {
  const t = useMessages(notificationsMessages);
  const pushIssueText = usePushIssueText();
  const common = useMessages(settingsMessages);
  const canEdit = useCanEditNotifications();
  const { values, setValues, isLoadError, refetch } = useSettingsForm<CustomerRules>({
    label: t("customerTitle"),
    queryKey: customerRulesQuery.queryKey,
    fetchFn: customerRulesQuery.queryFn,
    saveFn: (draft, expectedRevision) =>
      apiData(putApiV1AdminSettingsNotificationChannels({
        body: {
          channels: serializeCustomerNotificationConfig(buildCustomerNotificationConfig(draft.channels)),
          whatsappTemplate: draft.whatsappTemplate,
          expectedRevision,
        },
      })),
    defaultValues: {} as CustomerRules,
    errorMessage: common("saveFailed"),
    canEdit,
  });
  if (isLoadError) return <SettingsLoadFailure title={t("loadRules")} onRetry={refetch} />;
  if (!values.channels) return <SettingsCardLoading />;
  const config = buildCustomerNotificationConfig(values.channels);
  // Browser notifications are ready by their own rule (Web Push or the chosen app), not by a sending setup.
  const columns = CUSTOMER_NOTIFICATION_CHANNELS.map((key) =>
    key === "push"
      ? { key, label: t("browser"), ready: isReady(values.customerPush) }
      : { key, label: t(key), ready: isReady(values[key]) });
  const unready = columns.filter((column) => !column.ready).map((column) => column.key);
  return (
    <SettingsCard id="customerNotifications" title={t("customerTitle")} description={t("customerDescription")}>
      <RulesTable
        groups={CUSTOMER_EVENT_GROUPS}
        columns={columns}
        disabled={!canEdit}
        linkEvents
        rowIdPrefix="customer-rule"
        allowed={customerChannelAllowed}
        isOn={(event, channel) => config[event][channel as keyof (typeof config)[typeof event]]}
        onToggle={(event, channel) =>
          setValues((draft) => ({
            ...draft,
            channels: { ...draft.channels, [event]: toggled(draft.channels[event], channel) },
          }))}
      />
      {unready.map((channel) => (
        <p key={channel} className="text-body text-muted-foreground">
          {channel === "push"
            ? pushIssueText(values.customerPush?.issues[0]) ?? t("browserNotReady")
            : t("notReady", { channel: t(channel) })}
        </p>
      ))}
    </SettingsCard>
  );
}

const STAFF_EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const STAFF_EMAILS_MAX = 10;

function staffEmailValid(email: string): boolean {
  const trimmed = email.trim();
  return !trimmed || STAFF_EMAIL.test(trimmed);
}

export function StaffNotificationsCard() {
  const t = useMessages(notificationsMessages);
  const push = useMessages(webPushMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useCanEditNotifications();
  // The same document as the customer card: one read, each card saves its part.
  const { values, setValues, isLoadError, refetch } = useSettingsForm<CustomerRules>({
    label: t("staffTitle"),
    queryKey: customerRulesQuery.queryKey,
    fetchFn: customerRulesQuery.queryFn,
    saveFn: (draft, expectedRevision) =>
      apiData(putApiV1AdminSettingsNotificationChannelsAdminChannels({
        body: {
          channels: serializeAdminNotificationConfig(buildAdminNotificationConfig(draft.adminChannels)),
          emailRecipients: draft.staffEmailRecipients.map((email) => email.trim()).filter(Boolean),
          expectedRevision,
        },
      })),
    defaultValues: {} as CustomerRules,
    errorMessage: common("saveFailed"),
    canEdit,
    isValid: (draft) => draft.staffEmailRecipients.every(staffEmailValid),
    fields: (path) => (path.startsWith("emailRecipients.") ? `staff-email-${path.split(".")[1]}` : undefined),
  });
  if (isLoadError) return <SettingsLoadFailure title={t("loadRules")} onRetry={refetch} />;
  if (!values.adminChannels) return <SettingsCardLoading />;
  const config = buildAdminNotificationConfig(values.adminChannels);
  const pushReady = isReady(values.push);
  const recipients = values.staffEmailRecipients;
  const setRecipients = (update: (current: string[]) => string[]) =>
    setValues((draft) => ({ ...draft, staffEmailRecipients: update(draft.staffEmailRecipients) }));
  return (
    <SettingsCard id="staffNotifications" title={t("staffTitle")} description={t("staffDescription")}>
      <RulesTable
        groups={STAFF_EVENT_GROUPS}
        columns={[
          { key: "push", label: t("push"), ready: pushReady },
          { key: "email", label: t("email"), ready: isReady(values.email) },
        ]}
        disabled={!canEdit}
        allowed={adminChannelAllowed}
        isOn={(event, channel) => config[event][channel as "push" | "email"]}
        onToggle={(event, channel) =>
          setValues((draft) => ({
            ...draft,
            adminChannels: { ...draft.adminChannels, [event]: toggled(draft.adminChannels[event], channel) },
          }))}
      />
      {!pushReady ? (
        // Staff push is Web Push: it needs the store's https address (Sending has no push row any more).
        <p className="text-body text-muted-foreground">{push("reasonHttps")}</p>
      ) : null}
      {/* Staff push is set up per person, on their own devices (My account): one place, open to every staff member. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-4">
        <p className="min-w-0 flex-1 basis-60 text-body text-muted-foreground">{push("settingsPointer")}</p>
        <Button variant="outline" size="sm" asChild>
          <Link to="/admin/account" hash="this-device">{push("settingsOpen")}</Link>
        </Button>
      </div>
      <div className="space-y-3 border-t border-border pt-4">
        <div className="space-y-1">
          <h3 className="text-heading-sm">{t("staffEmails")}</h3>
          <p className="text-body text-muted-foreground">{t("staffEmailsHelp")}</p>
        </div>
        {recipients.map((email, index) => (
          <div key={index} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <SettingsField
                id={`staff-email-${index}`}
                label={<span className="sr-only">{t("staffEmail", { number: index + 1 })}</span>}
                error={staffEmailValid(email) ? null : t("staffEmailInvalid")}
              >
                <Input
                  id={`staff-email-${index}`}
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  // A row the merchant just added is where they type next.
                  autoFocus={!email && index === recipients.length - 1}
                  value={email}
                  disabled={!canEdit}
                  placeholder="name@example.com"
                  onChange={(event) =>
                    setRecipients((current) => current.map((value, at) => (at === index ? event.target.value : value)))}
                />
              </SettingsField>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="mt-1.5"
              disabled={!canEdit}
              aria-label={t("removeStaffEmail", { email: email || t("staffEmail", { number: index + 1 }) })}
              onClick={() => setRecipients((current) => current.filter((_, at) => at !== index))}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        ))}
        {recipients.length < STAFF_EMAILS_MAX ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canEdit}
            onClick={() => setRecipients((current) => [...current, ""])}
          >
            <Plus aria-hidden="true" />
            {t("addStaffEmail")}
          </Button>
        ) : null}
      </div>
    </SettingsCard>
  );
}

// ── Sending: email ──────────────────────────────────────────────────────

function EmailFields() {
  const t = useMessages(notificationsMessages);
  const common = useMessages(settingsMessages);
  const { values, setValue } = useSettingsForm<EmailSettings>({
    queryKey: emailQuery.queryKey,
    fetchFn: emailQuery.queryFn,
    saveFn: (draft, expectedRevision) => {
      const body: ApiBody<typeof postApiV1AdminSettingsEmail> = {
        provider: draft.provider,
        sender: draft.sender.trim(),
        expectedRevision,
      };
      if (draft.apiKey !== MASKED_VALUE) body.apiKey = draft.apiKey;
      return apiData(postApiV1AdminSettingsEmail({ body }));
    },
    invalidateQueryKeys: [customerRulesQuery.queryKey, authQuery.queryKey],
    defaultValues: {} as EmailSettings,
    errorMessage: common("saveFailed"),
    canEdit: useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT),
  });
  // Installed apps' email providers sit beside the built-in senders.
  const apps = useQuery({ ...appProvidersQuery("email"), enabled: useProviderPortAccess("email").canView }).data ?? [];
  const appT = useMessages(appProvidersMessages);
  if (!values.provider) return null;
  const app = apps.find((candidate) => candidate.id === values.provider);
  return (
    <>
      <SettingsField id="email-provider" label={t("emailProvider")}>
        <RadioGroup
          value={values.provider}
          onValueChange={(provider) => {
            setValue("provider", provider as EmailSettings["provider"]);
          }}
        >
          {(["cloudflare", "resend"] as const).map((provider) => (
            <label key={provider} className="flex min-h-11 items-start gap-2 py-3 text-body">
              <span className="flex h-lh items-center"><RadioGroupItem value={provider} /></span>
              {t(provider)}
            </label>
          ))}
          {apps.map((provider) => (
            <label key={provider.id} className="flex min-h-11 items-start gap-2 py-3 text-body">
              <span className="flex h-lh items-center"><RadioGroupItem value={provider.id} /></span>
              <span>
                {provider.name}
                <span className="block text-muted-foreground">{appT("byApp", { app: provider.appName })}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </SettingsField>
      {app ? <AppProviderStatus provider={app} /> : null}
      {values.provider === "resend" ? (
        <SettingsField
          id="email-resend-key"
          label={t("resendKey")}
          help={values.apiKey === MASKED_VALUE ? t("keySaved") : undefined}
        >
          <Input
            id="email-resend-key"
            type="password"
            autoComplete="new-password"
            value={values.apiKey}
            placeholder="re_..."
            aria-describedby="email-resend-key-note"
            onFocus={() => values.apiKey === MASKED_VALUE && setValue("apiKey", "")}
            onChange={(event) => setValue("apiKey", event.target.value)}
          />
        </SettingsField>
      ) : null}
      <SettingsField id="email-sender" label={t("sender")} help={t("senderHelp")}>
        <Input
          id="email-sender"
          type="email"
          value={values.sender}
          placeholder="orders@yourshop.com"
          aria-describedby="email-sender-note"
          onChange={(event) => setValue("sender", event.target.value)}
        />
      </SettingsField>
    </>
  );
}

// ── Sending: SMS ────────────────────────────────────────────────────────

/** A choice is complete when it names an app provider; whether it can send shows below it. */
function smsComplete(values: SmsSettings): boolean {
  return isQualifiedProviderId(values.activeProvider);
}

/** The merchant-facing name of a saved SMS or email choice, an app's from the installed apps. */
function providerName(provider: string, apps: readonly AppProvider[] | undefined, builtIn: (id: string) => string | null): string | null {
  return builtIn(provider) ?? apps?.find((candidate) => candidate.id === provider)?.name ?? null;
}

function SmsFields() {
  const t = useMessages(notificationsMessages);
  const common = useMessages(settingsMessages);
  const { values, setValue } = useSettingsForm<SmsSettings>({
    queryKey: smsQuery.queryKey,
    fetchFn: smsQuery.queryFn,
    saveFn: ({ activeProvider }, expectedRevision) =>
      apiData(postApiV1AdminSettingsSms({ body: { activeProvider: activeProvider ?? undefined, expectedRevision } })),
    invalidateQueryKeys: [customerRulesQuery.queryKey],
    defaultValues: {} as SmsSettings,
    errorMessage: common("saveFailed"),
    canEdit: useCanEditNotifications(),
    isValid: smsComplete,
  });
  // Every SMS gateway is an installed app's (the Bangladesh gateways: the Bangladesh pack).
  const apps = useQuery({ ...appProvidersQuery("sms"), enabled: useProviderPortAccess("sms").canView }).data ?? [];
  const appT = useMessages(appProvidersMessages);
  const provider = values.activeProvider;
  const app = apps.find((candidate) => candidate.id === provider);
  return (
    <>
      <SettingsField id="sms-provider" label={t("smsProvider")} help={apps.length === 0 ? t("smsNoApps") : undefined}>
        <SearchableSelect
          id="sms-provider"
          value={provider ?? ""}
          placeholder={t("chooseSmsProvider")}
          onValueChange={(value) => {
            setValue("activeProvider", value);
          }}
          triggerClassName="w-full"
          options={apps.map((candidate) => appProviderOption(candidate, appT))}
        />
      </SettingsField>
      {app ? <AppProviderStatus provider={app} /> : null}
      {provider && !app && values.activeProviderError ? (
        <Alert variant="warning">{values.activeProviderError}</Alert>
      ) : null}
    </>
  );
}

// ── Sending: WhatsApp (credentials live with sign-in, template with rules) ──

function WhatsAppFields() {
  const t = useMessages(notificationsMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const auth = useSettingsForm<AuthSettings, unknown, { customerAuth: number; whatsapp: number }>({
    queryKey: authQuery.queryKey,
    fetchFn: authQuery.queryFn,
    saveFn: (draft, expectedRevision) =>
      apiData(postApiV1AdminSettingsAuth({
        body: {
          expectedRevision: { whatsapp: expectedRevision.whatsapp },
          whatsappAccessToken: draft.whatsappAccessToken,
          whatsappPhoneNumberId: draft.whatsappPhoneNumberId.trim(),
          whatsappTemplateName: draft.whatsappTemplateName.trim() || "auth_otp",
        },
      })),
    invalidateQueryKeys: [customerRulesQuery.queryKey],
    defaultValues: {} as AuthSettings,
    errorMessage: common("saveFailed"),
    canEdit,
  });
  const rules = useSettingsForm<CustomerRules>({
    queryKey: customerRulesQuery.queryKey,
    fetchFn: customerRulesQuery.queryFn,
    saveFn: (draft, expectedRevision) =>
      apiData(putApiV1AdminSettingsNotificationChannels({
        body: {
          channels: serializeCustomerNotificationConfig(buildCustomerNotificationConfig(draft.channels)),
          whatsappTemplate: {
            templateName: draft.whatsappTemplate.templateName.trim() || "order_status_update",
            languageCode: draft.whatsappTemplate.languageCode.trim() || "en_US",
          },
          expectedRevision,
        },
      })),
    defaultValues: {} as CustomerRules,
    errorMessage: common("saveFailed"),
    canEdit: useCanEditNotifications(),
  });
  if (auth.values.whatsappAccessToken === undefined || !rules.values.whatsappTemplate) return null;
  const template = rules.values.whatsappTemplate;
  const setTemplate = (key: keyof typeof template, value: string) =>
    rules.setValues((draft) => ({ ...draft, whatsappTemplate: { ...draft.whatsappTemplate, [key]: value } }));
  const token = auth.values.whatsappAccessToken;
  return (
    <>
      <p className="text-body text-muted-foreground">{t("waHelp")}</p>
      <SettingsField id="wa-token" label={t("waAccessToken")} help={token === MASKED_VALUE ? t("secretSaved") : undefined}>
        <Input
          id="wa-token"
          type="password"
          autoComplete="off"
          value={token}
          aria-describedby="wa-token-note"
          onFocus={() => token === MASKED_VALUE && auth.setValue("whatsappAccessToken", "")}
          onChange={(event) => auth.setValue("whatsappAccessToken", event.target.value)}
        />
      </SettingsField>
      <SettingsField id="wa-phone" label={t("waPhoneNumberId")}>
        <Input
          id="wa-phone"
          inputMode="numeric"
          value={auth.values.whatsappPhoneNumberId}
          onChange={(event) => auth.setValue("whatsappPhoneNumberId", event.target.value)}
        />
      </SettingsField>
      <SettingsField id="wa-otp-template" label={t("waOtpTemplate")}>
        <Input
          id="wa-otp-template"
          value={auth.values.whatsappTemplateName}
          placeholder="auth_otp"
          onChange={(event) => auth.setValue("whatsappTemplateName", event.target.value)}
        />
      </SettingsField>
      <FieldRow>
        <SettingsField id="wa-order-template" label={t("waOrderTemplate")}>
          <Input
            id="wa-order-template"
            value={template.templateName}
            placeholder="order_status_update"
            onChange={(event) => setTemplate("templateName", event.target.value)}
          />
        </SettingsField>
        <SettingsField id="wa-language" label={t("waLanguage")}>
          <Input
            id="wa-language"
            value={template.languageCode}
            placeholder="en_US"
            onChange={(event) => setTemplate("languageCode", event.target.value)}
          />
        </SettingsField>
      </FieldRow>
    </>
  );
}

// ── Sending card ────────────────────────────────────────────────────────

export function SendingCard() {
  const t = useMessages(notificationsMessages);
  const canEditGeneral = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const canEditNotifications = useCanEditNotifications();
  const rules = useQuery(customerRulesQuery);
  const email = useQuery(emailQuery);
  const sms = useQuery(smsQuery);
  const canSeeApps = useHasPermission(ADMIN_PERMISSIONS.APPS_VIEW);
  // An app's name is read only when the saved choice is an app.
  const smsAccess = useProviderPortAccess("sms");
  const emailAccess = useProviderPortAccess("email");
  const smsApps = useQuery({ ...appProvidersQuery("sms"), enabled: smsAccess.canView && isQualifiedProviderId(sms.data?.activeProvider) });
  const emailApps = useQuery({ ...appProvidersQuery("email"), enabled: emailAccess.canView && isQualifiedProviderId(email.data?.provider) });
  if (!rules.data) return null;
  const smsName = sms.data?.activeProvider
    ? providerName(sms.data.activeProvider, smsApps.data, () => null)
    : null;
  // A chosen gateway that cannot send (its app is not installed, active or set up): say why, where to fix it.
  const smsBlocked = sms.data?.activeProvider && !sms.data.activeProviderConfigured ? sms.data.activeProviderError : null;
  const smsPluginId = parseQualifiedProviderId(sms.data?.activeProvider)?.pluginId ?? null;
  const emailName = email.data?.provider
    ? providerName(email.data.provider, emailApps.data, (id) => (id === "cloudflare" || id === "resend" ? t(id) : null))
    : null;
  const status = (ready: boolean, detail?: string | null) => (ready ? detail || t("ready") : t("notSetUp"));
  return (
    <SettingsCard id="sending"
      title={t("sendingTitle")}
      rows={
        <>
          <SettingsDialog
            title={t("email")}
            trigger={
              <SettingsRow
                label={t("email")}
                disabled={!canEditGeneral || !email.data}
                value={status(
                  isReady(rules.data.email),
                  email.data?.sender && emailName ? t("via", { sender: email.data.sender, provider: emailName }) : null,
                )}
              />
            }
          >
            <EmailFields />
          </SettingsDialog>
          <SettingsDialog
            title={t("sms")}
            trigger={
              <SettingsRow
                label={t("sms")}
                disabled={!canEditNotifications || !sms.data}
                value={status(isReady(rules.data.sms), smsName)}
              />
            }
          >
            <SmsFields />
          </SettingsDialog>
          <SettingsDialog
            title={t("whatsapp")}
            trigger={<SettingsRow label={t("whatsapp")} disabled={!canEditGeneral} value={status(isReady(rules.data.whatsapp))} />}
          >
            <WhatsAppFields />
          </SettingsDialog>
        </>
      }
    >
      {smsBlocked ? (
        <Alert variant="warning">
          <span className="flex flex-col items-start gap-1">
            <span>{t("smsBlocked", { reason: smsBlocked })}</span>
            {canSeeApps && smsPluginId ? (
              <Button type="button" variant="link" asChild>
                <Link to={appProviderSetupPath(sms.data?.activeProvider ?? "")}>{t("smsOpenApp")}</Link>
              </Button>
            ) : null}
          </span>
        </Alert>
      ) : null}
    </SettingsCard>
  );
}
