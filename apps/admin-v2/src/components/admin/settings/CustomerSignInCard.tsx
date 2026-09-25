import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { postApiV1AdminSettingsAuth } from "@scalius/api-client/sdk";
import {
  CUSTOMER_AUTH_OTP_CHANNELS,
  EMAIL_COLLECTION_MODES,
  WHATSAPP_COLLECTION_MODES,
  isChannelCollected,
  type CustomerAuthOtpChannel,
  type CustomerIdentitySettings,
  type EmailCollectionMode,
  type WhatsAppCollectionMode,
} from "@scalius/shared/customer-auth-policy";
import { isReady } from "@scalius/shared/readiness";
import { Checkbox } from "~/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData } from "~/lib/api";
import { authQuery, customerRulesQuery, signInPolicyQuery } from "~/lib/api-query-options/settings-screens";
import { useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { notificationsMessages } from "~/i18n/settings-notifications";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsCardLoading } from "./SettingsPage";

const CHANNEL_LABEL = { email: "codeEmail", sms: "codeSms", whatsapp: "codeWhatsapp" } as const;
const EMAIL_LABEL = { required: "emailRequired", optional: "emailOptional", hidden: "emailNone" } as const;
const WHATSAPP_LABEL = { off: "whatsappOff", same_as_phone: "whatsappSame", separate: "whatsappSeparate" } as const;

function toggleChannel(identity: CustomerIdentitySettings, channel: CustomerAuthOtpChannel): CustomerIdentitySettings {
  const on = new Set(identity.channels);
  if (on.has(channel)) on.delete(channel);
  else on.add(channel);
  return { ...identity, channels: CUSTOMER_AUTH_OTP_CHANNELS.filter((item) => on.has(item)) };
}

/**
 * Settings → Customer accounts: the one place that decides what checkout
 * collects and which channels send verification codes (sign-in, full order
 * details, payment recovery). A channel is selectable only when its contact
 * is collected and its provider can send (fail closed).
 */
export function CustomerSignInCard() {
  const t = useMessages(notificationsMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const readiness = useQuery(customerRulesQuery);
  const channelReady = (channel: CustomerAuthOtpChannel) => isReady(readiness.data?.[channel]);
  const { values, setValue, isLoadError, refetch } = useSettingsForm<
    { identity: CustomerIdentitySettings },
    unknown,
    { customerAuth: number; whatsapp: number }
  >({
    label: t("signInTitle"),
    queryKey: signInPolicyQuery.queryKey,
    fetchFn: signInPolicyQuery.queryFn,
    saveFn: ({ identity }, expectedRevision) =>
      apiData(postApiV1AdminSettingsAuth({
        body: {
          expectedRevision: { customerAuth: expectedRevision.customerAuth },
          customerIdentity: { email: identity.email, whatsapp: identity.whatsapp, channels: [...identity.channels] },
        },
      })),
    invalidateQueryKeys: [authQuery.queryKey],
    defaultValues: { identity: undefined as unknown as CustomerIdentitySettings },
    errorMessage: common("saveFailed"),
    canEdit,
    // The first render after the read can still hold the empty default.
    isValid: ({ identity }) =>
      Boolean(identity) &&
      identity.channels.length > 0 &&
      identity.channels.every((channel) => channelReady(channel) && isChannelCollected(identity, channel)),
  });
  if (isLoadError) return <SettingsLoadFailure title={t("loadSignIn")} onRetry={refetch} />;
  if (!values.identity) return <SettingsCardLoading />;
  const identity = values.identity;
  const set = (next: CustomerIdentitySettings) => setValue("identity", next);
  const emailCodes = identity.channels.includes("email");
  const whatsappCodes = identity.channels.includes("whatsapp");

  return (
    <>
      <SettingsCard id="customerFields" title={t("contactTitle")} description={t("contactDescription")}>
        <div className="flex min-h-11 items-center justify-between gap-4 text-body">
          <span className="font-medium">{t("phoneField")}</span>
          <span className="text-muted-foreground">{t("phoneLocked")}</span>
        </div>
        <div className="border-t border-border pt-3">
        <fieldset className="space-y-1">
          <legend className="text-body font-medium">{t("askEmail")}</legend>
          <RadioGroup
            value={identity.email}
            disabled={!canEdit}
            onValueChange={(mode) => set({ ...identity, email: mode as EmailCollectionMode })}
          >
            {EMAIL_COLLECTION_MODES.map((mode) => (
              <label key={mode} className="flex min-h-11 items-start gap-3 py-3 text-body">
                <RadioGroupItem className="mt-0.5" value={mode} disabled={mode === "hidden" && emailCodes} />
                {t(EMAIL_LABEL[mode])}
              </label>
            ))}
          </RadioGroup>
          {emailCodes ? <p className="text-body text-muted-foreground">{t("emailInUse")}</p> : null}
        </fieldset>
        </div>
        <div className="border-t border-border pt-3">
        <fieldset className="space-y-1">
          <legend className="text-body font-medium">{t("askWhatsapp")}</legend>
          <RadioGroup
            value={identity.whatsapp}
            disabled={!canEdit}
            onValueChange={(mode) => set({ ...identity, whatsapp: mode as WhatsAppCollectionMode })}
          >
            {WHATSAPP_COLLECTION_MODES.map((mode) => (
              <label key={mode} className="flex min-h-11 items-start gap-3 py-3 text-body">
                <RadioGroupItem className="mt-0.5" value={mode} disabled={mode === "off" && whatsappCodes} />
                {t(WHATSAPP_LABEL[mode])}
              </label>
            ))}
          </RadioGroup>
          {whatsappCodes ? <p className="text-body text-muted-foreground">{t("whatsappInUse")}</p> : null}
        </fieldset>
        </div>
      </SettingsCard>

      <SettingsCard id="customerSignIn" title={t("signInTitle")} description={t("signInDescription")}>
        <fieldset className="space-y-1">
          <legend className="text-body font-medium">{t("codeChannels")}</legend>
          {CUSTOMER_AUTH_OTP_CHANNELS.map((channel) => {
            const on = identity.channels.includes(channel);
            const collected = isChannelCollected(identity, channel);
            const ready = channelReady(channel);
            // Off channels can be turned on only when they could send; the last one can't be turned off.
            const disabled = !canEdit || (on ? identity.channels.length === 1 : !collected || !ready);
            const hint = !collected
              ? t(channel === "email" ? "needEmailField" : "needWhatsappField")
              : !ready
                ? t(channel === "whatsapp" ? "whatsappNotConnected" : "channelNotReady", { channel: t(channel) })
                : null;
            return (
              <div key={channel}>
                <label className="flex min-h-11 items-start gap-3 py-3 text-body">
                  <Checkbox
                    className="mt-0.5"
                    checked={on}
                    disabled={disabled}
                    onCheckedChange={() => set(toggleChannel(identity, channel))}
                  />
                  {t(CHANNEL_LABEL[channel])}
                </label>
                {hint ? (
                  <p role={on ? "alert" : undefined} className={`pb-1 pl-7 text-body ${on ? "text-destructive" : "text-muted-foreground"}`}>
                    {collected ? (
                      <Link to="/admin/settings/notifications" hash="sending" className="underline underline-offset-2">{hint}</Link>
                    ) : hint}
                  </p>
                ) : null}
              </div>
            );
          })}
        </fieldset>
        {identity.email === "optional" && identity.channels.length === 1 && emailCodes ? (
          <p className="text-body text-muted-foreground">{t("emailOptionalOnly")}</p>
        ) : null}
      </SettingsCard>
    </>
  );
}
