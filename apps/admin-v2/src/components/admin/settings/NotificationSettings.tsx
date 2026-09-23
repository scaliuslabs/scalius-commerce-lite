import { useQuery } from "@tanstack/react-query";
import type { OrderNotificationType } from "@scalius/core/modules/notifications/notification-types";
import {
  getApiV1AdminSettingsAuth,
  getApiV1AdminSettingsEmail,
  getApiV1AdminSettingsFirebase,
  getApiV1AdminSettingsNotificationChannels,
  getApiV1AdminSettingsNotificationChannelsAdminChannels,
  getApiV1AdminSettingsSms,
  postApiV1AdminSettingsAuth,
  postApiV1AdminSettingsEmail,
  postApiV1AdminSettingsFirebase,
  postApiV1AdminSettingsSms,
  putApiV1AdminSettingsNotificationChannels,
  putApiV1AdminSettingsNotificationChannelsAdminChannels,
} from "@scalius/api-client/sdk";
import { isReady } from "@scalius/shared/readiness";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData, type ApiBody, type ApiResult } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { notificationEventMessages, notificationsMessages } from "~/i18n/settings-notifications";
import {
  CUSTOMER_NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENT_GROUPS,
  buildAdminNotificationConfig,
  buildCustomerNotificationConfig,
  serializeAdminNotificationConfig,
  serializeCustomerNotificationConfig,
} from "./notification-channel-policy";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsDialog, SettingsField, SettingsRow, SettingsCardLoading } from "./SettingsPage";

/** Saved secrets come back masked; sending the mask back keeps them. */
export const MASKED_VALUE = "••••••••••••";

type CustomerRules = ApiResult<typeof getApiV1AdminSettingsNotificationChannels>;
type StaffRules = ApiResult<typeof getApiV1AdminSettingsNotificationChannelsAdminChannels>;
type EmailSettings = ApiResult<typeof getApiV1AdminSettingsEmail>;
type SmsSettings = ApiResult<typeof getApiV1AdminSettingsSms>;
type AuthSettings = ApiResult<typeof getApiV1AdminSettingsAuth>;
type SmsProvider = NonNullable<SmsSettings["activeProvider"]>;

export const customerRulesQuery = {
  queryKey: queryKeys.settings.notificationChannels(),
  queryFn: () => apiData(getApiV1AdminSettingsNotificationChannels()),
};
export const staffRulesQuery = {
  queryKey: queryKeys.settings.adminNotificationChannels(),
  queryFn: () => apiData(getApiV1AdminSettingsNotificationChannelsAdminChannels()),
};
export const emailQuery = {
  queryKey: queryKeys.settings.email(),
  queryFn: () => apiData(getApiV1AdminSettingsEmail()),
};
export const smsQuery = {
  queryKey: queryKeys.settings.sms(),
  queryFn: () => apiData(getApiV1AdminSettingsSms()),
};
export const authQuery = {
  queryKey: queryKeys.settings.auth(),
  queryFn: () => apiData(getApiV1AdminSettingsAuth()),
};
export const firebaseQuery = {
  queryKey: queryKeys.settings.firebase(),
  queryFn: () => apiData(getApiV1AdminSettingsFirebase()),
};

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
  columns,
  isOn,
  onToggle,
  disabled,
}: {
  columns: ReadonlyArray<{ key: string; label: string; ready: boolean }>;
  isOn: (event: OrderNotificationType, column: string) => boolean;
  onToggle: (event: OrderNotificationType, column: string) => void;
  disabled: boolean;
}) {
  const events = useMessages(notificationEventMessages);
  const t = useMessages(notificationsMessages);
  return (
    <table className="w-full text-body">
      <thead>
        <tr className="border-b border-border text-muted-foreground">
          <th className="py-2 text-left font-medium">{t("event")}</th>
          {columns.map((column) => (
            <th key={column.key} className="w-16 py-2 text-center font-medium sm:w-24">{column.label}</th>
          ))}
        </tr>
      </thead>
      {NOTIFICATION_EVENT_GROUPS.map((group) => (
        <tbody key={group.key}>
          <tr>
            <th colSpan={columns.length + 1} className="pb-1 pt-4 text-left font-semibold">
              {events(group.key)}
            </th>
          </tr>
          {group.events.map((event) => (
            <tr key={event} className="border-t border-border">
              <td className="py-1.5 pr-2">{events(event)}</td>
              {columns.map((column) => (
                <td key={column.key} className="text-center">
                  <label className="inline-grid size-11 place-items-center">
                    <Checkbox
                      checked={isOn(event, column.key)}
                      disabled={disabled || (!column.ready && !isOn(event, column.key))}
                      aria-label={`${events(event)}: ${column.label}`}
                      onCheckedChange={() => onToggle(event, column.key)}
                    />
                  </label>
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
  const common = useMessages(settingsMessages);
  const canEdit = useCanEditNotifications();
  const { values, setValues, isLoadError, refetch } = useSettingsForm<CustomerRules>({
    label: t("customerTitle"),
    queryKey: customerRulesQuery.queryKey,
    fetchFn: customerRulesQuery.queryFn,
    saveFn: (draft) =>
      apiData(putApiV1AdminSettingsNotificationChannels({
        body: {
          channels: serializeCustomerNotificationConfig(buildCustomerNotificationConfig(draft.channels)),
          whatsappTemplate: draft.whatsappTemplate,
        },
      })),
    defaultValues: {} as CustomerRules,
    errorMessage: common("saveFailed"),
    canEdit,
  });
  if (isLoadError) return <SettingsLoadFailure title={t("loadRules")} onRetry={refetch} />;
  if (!values.channels) return <SettingsCardLoading />;
  const config = buildCustomerNotificationConfig(values.channels);
  const columns = CUSTOMER_NOTIFICATION_CHANNELS.map((key) => ({ key, label: t(key), ready: isReady(values[key]) }));
  const unready = columns.filter((column) => !column.ready).map((column) => column.key);
  return (
    <SettingsCard id="customerNotifications" title={t("customerTitle")} description={t("customerDescription")}>
      <RulesTable
        columns={columns}
        disabled={!canEdit}
        isOn={(event, channel) => config[event][channel as keyof (typeof config)[typeof event]]}
        onToggle={(event, channel) =>
          setValues((draft) => ({
            ...draft,
            channels: { ...draft.channels, [event]: toggled(draft.channels[event], channel) },
          }))}
      />
      {unready.map((channel) => (
        <p key={channel} className="text-body text-muted-foreground">{t("notReady", { channel: t(channel) })}</p>
      ))}
    </SettingsCard>
  );
}

export function StaffNotificationsCard() {
  const t = useMessages(notificationsMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useCanEditNotifications();
  const { values, setValues, isLoadError, refetch } = useSettingsForm<StaffRules>({
    label: t("staffTitle"),
    queryKey: staffRulesQuery.queryKey,
    fetchFn: staffRulesQuery.queryFn,
    saveFn: (draft) =>
      apiData(putApiV1AdminSettingsNotificationChannelsAdminChannels({
        body: { channels: serializeAdminNotificationConfig(buildAdminNotificationConfig(draft.channels)) },
      })),
    defaultValues: {} as StaffRules,
    errorMessage: common("saveFailed"),
    canEdit,
  });
  if (isLoadError) return <SettingsLoadFailure title={t("loadRules")} onRetry={refetch} />;
  if (!values.channels) return <SettingsCardLoading />;
  const config = buildAdminNotificationConfig(values.channels);
  const pushReady = isReady(values.push);
  return (
    <SettingsCard id="staffNotifications" title={t("staffTitle")} description={t("staffDescription")}>
      <RulesTable
        columns={[{ key: "push", label: t("push"), ready: pushReady }]}
        disabled={!canEdit}
        isOn={(event) => config[event].push}
        onToggle={(event) =>
          setValues((draft) => ({
            ...draft,
            channels: { ...draft.channels, [event]: toggled(draft.channels[event], "push") },
          }))}
      />
      {!pushReady ? (
        <p className="text-body text-muted-foreground">{t("notReady", { channel: t("push") })}</p>
      ) : null}
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
    saveFn: (draft) => {
      const body: ApiBody<typeof postApiV1AdminSettingsEmail> = { provider: draft.provider, sender: draft.sender.trim() };
      if (draft.apiKey !== MASKED_VALUE) body.apiKey = draft.apiKey;
      return apiData(postApiV1AdminSettingsEmail({ body }));
    },
    invalidateQueryKeys: [customerRulesQuery.queryKey, authQuery.queryKey],
    defaultValues: {} as EmailSettings,
    errorMessage: common("saveFailed"),
    canEdit: useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT),
  });
  if (!values.provider) return null;
  return (
    <>
      <SettingsField id="email-provider" label={t("emailProvider")}>
        <RadioGroup
          value={values.provider}
          onValueChange={(provider) => setValue("provider", provider as EmailSettings["provider"])}
        >
          {(["cloudflare", "resend"] as const).map((provider) => (
            <label key={provider} className="flex min-h-11 items-start gap-2 py-3 text-body">
              <RadioGroupItem className="mt-0.5" value={provider} />
              {t(provider)}
            </label>
          ))}
        </RadioGroup>
      </SettingsField>
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

const SMS_PROVIDERS: Record<SmsProvider, { label: string; fields: Array<{ key: keyof SmsSettings; label: "smsApiKey" | "smsToken" | "smsUsername" | "smsSenderId" | "smsSenderName" | "smsBaseUrl"; secret?: boolean; optional?: boolean; help?: "smsSenderNameHelp" | "smsBaseUrlHelp" }> }> = {
  smsnetbd: {
    label: "SMS.net.bd",
    fields: [
      { key: "smsnetbdApiKey", label: "smsApiKey", secret: true },
      { key: "smsnetbdSenderId", label: "smsSenderId", optional: true },
    ],
  },
  bdbulksms: { label: "BDBulkSMS (GreenWeb)", fields: [{ key: "bdbulksmsToken", label: "smsToken", secret: true }] },
  mimsms: {
    label: "MIM SMS",
    fields: [
      { key: "mimsmsUsername", label: "smsUsername" },
      { key: "mimsmsApiKey", label: "smsApiKey", secret: true },
      { key: "mimsmsSenderName", label: "smsSenderName", help: "smsSenderNameHelp" },
    ],
  },
  gennet: {
    label: "GenNet iSMS",
    fields: [
      { key: "gennetApiToken", label: "smsToken", secret: true },
      { key: "gennetBaseUrl", label: "smsBaseUrl", help: "smsBaseUrlHelp" },
      { key: "gennetSid", label: "smsSenderId" },
    ],
  },
};

function smsComplete(values: SmsSettings): boolean {
  const provider = values.activeProvider;
  return Boolean(
    provider &&
      SMS_PROVIDERS[provider].fields.every((field) => field.optional || String(values[field.key] ?? "").trim()),
  );
}

function SmsFields() {
  const t = useMessages(notificationsMessages);
  const common = useMessages(settingsMessages);
  const { values, setValue } = useSettingsForm<SmsSettings>({
    queryKey: smsQuery.queryKey,
    fetchFn: smsQuery.queryFn,
    saveFn: ({ activeProvider, activeProviderConfigured: _configured, activeProviderError: _error, ...credentials }) =>
      apiData(postApiV1AdminSettingsSms({ body: { ...credentials, activeProvider: activeProvider ?? undefined } })),
    invalidateQueryKeys: [customerRulesQuery.queryKey],
    defaultValues: {} as SmsSettings,
    errorMessage: common("saveFailed"),
    canEdit: useCanEditNotifications(),
    isValid: smsComplete,
  });
  const provider = values.activeProvider;
  return (
    <>
      <SettingsField id="sms-provider" label={t("smsProvider")}>
        <Select value={provider ?? ""} onValueChange={(value) => setValue("activeProvider", value as SmsProvider)}>
          <SelectTrigger id="sms-provider">
            <SelectValue placeholder={t("chooseSmsProvider")} />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SMS_PROVIDERS) as SmsProvider[]).map((key) => (
              <SelectItem key={key} value={key}>{SMS_PROVIDERS[key].label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsField>
      {provider
        ? SMS_PROVIDERS[provider].fields.map((field) => {
            const value = String(values[field.key] ?? "");
            const id = `sms-${field.key}`;
            const missing = !field.optional && !value.trim();
            return (
              <SettingsField
                key={field.key}
                id={id}
                label={field.optional ? `${t(field.label)} (${common("optional")})` : t(field.label)}
                help={field.secret && value === MASKED_VALUE ? t("secretSaved") : field.help ? t(field.help) : undefined}
                error={missing ? t("smsRequired") : null}
              >
                <Input
                  id={id}
                  type={field.secret ? "password" : "text"}
                  autoComplete="off"
                  value={value}
                  aria-invalid={missing}
                  aria-describedby={`${id}-note`}
                  onFocus={() => field.secret && value === MASKED_VALUE && setValue(field.key, "" as never)}
                  onChange={(event) => setValue(field.key, event.target.value as never)}
                />
              </SettingsField>
            );
          })
        : null}
    </>
  );
}

// ── Sending: WhatsApp (credentials live with sign-in, template with rules) ──

function WhatsAppFields() {
  const t = useMessages(notificationsMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const auth = useSettingsForm<AuthSettings>({
    queryKey: authQuery.queryKey,
    fetchFn: authQuery.queryFn,
    saveFn: (draft) =>
      apiData(postApiV1AdminSettingsAuth({
        body: {
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
    saveFn: (draft) =>
      apiData(putApiV1AdminSettingsNotificationChannels({
        body: {
          channels: serializeCustomerNotificationConfig(buildCustomerNotificationConfig(draft.channels)),
          whatsappTemplate: {
            templateName: draft.whatsappTemplate.templateName.trim() || "order_status_update",
            languageCode: draft.whatsappTemplate.languageCode.trim() || "en_US",
          },
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
      <div className="grid gap-4 sm:grid-cols-2">
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
      </div>
    </>
  );
}

// ── Sending: push (Firebase) ────────────────────────────────────────────

const FIREBASE_FIELDS = [
  ["apiKey", "fbApiKey"],
  ["authDomain", "fbAuthDomain"],
  ["projectId", "fbProjectId"],
  ["storageBucket", "fbStorageBucket"],
  ["messagingSenderId", "fbSenderId"],
  ["appId", "fbAppId"],
  ["vapidKey", "fbVapidKey"],
] as const;
type FirebaseKey = (typeof FIREBASE_FIELDS)[number][0];

interface FirebaseValues {
  serviceAccount: string;
  publicConfig: Record<FirebaseKey | "measurementId", string>;
}

function isServiceAccount(value: string): boolean {
  if (!value || value === MASKED_VALUE) return true;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return ["private_key", "client_email", "project_id"].every(
      (key) => typeof parsed[key] === "string" && Boolean((parsed[key] as string).trim()),
    );
  } catch {
    return false;
  }
}

/** Reads the `firebaseConfig = {...}` snippet Firebase shows for web apps. */
function parseWebConfig(raw: string): Partial<Record<string, string>> | null {
  try {
    const json = raw
      .trim()
      .replace(/^(const|let|var)\s+\w+\s*=\s*/, "")
      .replace(/;$/, "")
      .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":')
      .replace(/,(\s*[}\]])/g, "$1");
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string")) as Record<string, string>;
  } catch {
    return null;
  }
}

function PushFields() {
  const t = useMessages(notificationsMessages);
  const common = useMessages(settingsMessages);
  const { values, setValue, setValues } = useSettingsForm<FirebaseValues>({
    queryKey: firebaseQuery.queryKey,
    fetchFn: async () => {
      const data = await firebaseQuery.queryFn();
      const config = Object.fromEntries(
        [...FIREBASE_FIELDS.map(([key]) => key), "measurementId"].map((key) => [
          key,
          typeof data.publicConfig[key] === "string" ? (data.publicConfig[key] as string) : "",
        ]),
      ) as FirebaseValues["publicConfig"];
      return { serviceAccount: data.serviceAccount, publicConfig: config };
    },
    saveFn: (draft) => {
      const body: ApiBody<typeof postApiV1AdminSettingsFirebase> = { publicConfig: draft.publicConfig };
      if (draft.serviceAccount !== MASKED_VALUE) body.serviceAccount = draft.serviceAccount;
      return apiData(postApiV1AdminSettingsFirebase({ body }));
    },
    invalidateQueryKeys: [staffRulesQuery.queryKey],
    defaultValues: { serviceAccount: "", publicConfig: {} as FirebaseValues["publicConfig"] },
    errorMessage: common("saveFailed"),
    canEdit: useCanEditNotifications(),
    isValid: (draft) => isServiceAccount(draft.serviceAccount),
  });
  const accountValid = isServiceAccount(values.serviceAccount);
  return (
    <>
      <SettingsField
        id="push-service-account"
        label={t("serviceAccount")}
        help={values.serviceAccount === MASKED_VALUE ? t("serviceAccountSaved") : t("serviceAccountHelp")}
        error={accountValid ? null : t("serviceAccountInvalid")}
      >
        <Textarea
          id="push-service-account"
          rows={4}
          spellCheck={false}
          autoComplete="off"
          value={values.serviceAccount}
          aria-invalid={!accountValid}
          aria-describedby="push-service-account-note"
          onFocus={() => values.serviceAccount === MASKED_VALUE && setValue("serviceAccount", "")}
          onChange={(event) => setValue("serviceAccount", event.target.value)}
        />
      </SettingsField>
      <SettingsField id="push-paste" label={t("pasteConfig")} help={t("pasteConfigHelp")}>
        <Textarea
          id="push-paste"
          rows={2}
          spellCheck={false}
          aria-describedby="push-paste-note"
          onChange={(event) => {
            const parsed = parseWebConfig(event.target.value);
            if (parsed) setValues((draft) => ({ ...draft, publicConfig: { ...draft.publicConfig, ...parsed } }));
          }}
        />
      </SettingsField>
      <div className="grid gap-4 sm:grid-cols-2">
        {FIREBASE_FIELDS.map(([key, label]) => (
          <SettingsField key={key} id={`push-${key}`} label={t(label)}>
            <Input
              id={`push-${key}`}
              autoComplete="off"
              value={values.publicConfig[key] ?? ""}
              onChange={(event) =>
                setValues((draft) => ({ ...draft, publicConfig: { ...draft.publicConfig, [key]: event.target.value } }))}
            />
          </SettingsField>
        ))}
      </div>
    </>
  );
}

// ── Sending card ────────────────────────────────────────────────────────

export function SendingCard() {
  const t = useMessages(notificationsMessages);
  const canEditGeneral = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const canEditNotifications = useCanEditNotifications();
  const rules = useQuery(customerRulesQuery);
  const staff = useQuery(staffRulesQuery);
  const email = useQuery(emailQuery);
  const sms = useQuery(smsQuery);
  if (!rules.data || !staff.data) return null;
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
                  email.data?.sender ? t("via", { sender: email.data.sender, provider: t(email.data.provider) }) : null,
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
                value={status(isReady(rules.data.sms), sms.data?.activeProvider ? SMS_PROVIDERS[sms.data.activeProvider].label : null)}
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
          <SettingsDialog
            title={t("pushTitle")}
            trigger={
              <SettingsRow label={t("pushTitle")} disabled={!canEditNotifications} value={status(isReady(staff.data.push))} />
            }
          >
            <PushFields />
          </SettingsDialog>
        </>
      }
    />
  );
}
