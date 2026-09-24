import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { postApiV1AdminSettingsAuth } from "@scalius/api-client/sdk";
import {
  CUSTOMER_AUTH_OTP_CHANNELS,
  getLegacyCustomerAuthMethodForPolicy,
  normalizeCustomerAuthPolicy,
  type CustomerAuthOtpChannel,
  type CustomerAuthPolicyConfig,
} from "@scalius/shared/customer-auth-policy";
import { isReady } from "@scalius/shared/readiness";
import { Checkbox } from "~/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { NativeSelect } from "~/components/ui/native-select";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData } from "~/lib/api";
import { useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { notificationsMessages } from "~/i18n/settings-notifications";
import { authQuery, customerRulesQuery } from "./NotificationSettings";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsField, SettingsCardLoading } from "./SettingsPage";

type EmailMode = "none" | "optional" | "required";

export const signInPolicyQuery = {
  queryKey: [...authQuery.queryKey, "policy"],
  queryFn: async () => {
    const auth = await authQuery.queryFn();
    return {
      policy: normalizeCustomerAuthPolicy(auth.customerAuthPolicy, auth.authVerificationMethod),
      revision: auth.revision,
    };
  },
};

function emailMode(policy: CustomerAuthPolicyConfig): EmailMode {
  if (policy.requiredContactFields.includes("email")) return "required";
  if (policy.optionalContactFields.includes("email")) return "optional";
  return "none";
}

/** Codes sent only by email need the email: the shared rule forces it to required. */
function emailOnly(policy: CustomerAuthPolicyConfig): boolean {
  return policy.otpChannels.length === 1 && policy.otpChannels[0] === "email";
}

/** Phone is always required: only the email field is the merchant's choice. */
function withEmailMode(policy: CustomerAuthPolicyConfig, mode: EmailMode): CustomerAuthPolicyConfig {
  return normalizeCustomerAuthPolicy({
    ...policy,
    requiredContactFields: mode === "required" ? ["phone", "email"] : ["phone"],
    optionalContactFields: mode === "optional" ? ["email"] : [],
  });
}

function withChannel(policy: CustomerAuthPolicyConfig, channel: CustomerAuthOtpChannel): CustomerAuthPolicyConfig {
  const on = new Set(policy.otpChannels);
  if (on.has(channel)) on.delete(channel);
  else on.add(channel);
  const otpChannels = CUSTOMER_AUTH_OTP_CHANNELS.filter((item) => on.has(item));
  return normalizeCustomerAuthPolicy({
    ...policy,
    otpChannels,
    defaultOtpChannel: otpChannels.includes(policy.defaultOtpChannel) ? policy.defaultOtpChannel : otpChannels[0]!,
  });
}

export function CustomerSignInCard() {
  const t = useMessages(notificationsMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  // Delivery readiness decides which channels can be turned on (fail closed).
  const readiness = useQuery(customerRulesQuery);
  const channelReady = (channel: CustomerAuthOtpChannel) => isReady(readiness.data?.[channel]);
  const { values, setValue, isLoadError, refetch } = useSettingsForm<
    { policy: CustomerAuthPolicyConfig },
    unknown,
    { customerAuth: number; whatsapp: number }
  >({
    label: t("signInTitle"),
    queryKey: signInPolicyQuery.queryKey,
    fetchFn: signInPolicyQuery.queryFn,
    saveFn: ({ policy }, expectedRevision) =>
      apiData(postApiV1AdminSettingsAuth({
        body: {
          expectedRevision: { customerAuth: expectedRevision.customerAuth },
          authVerificationMethod: getLegacyCustomerAuthMethodForPolicy(policy),
          customerAuthPolicy: {
            otpChannels: [...policy.otpChannels],
            requiredContactFields: [...policy.requiredContactFields],
            optionalContactFields: [...policy.optionalContactFields],
            defaultOtpChannel: policy.defaultOtpChannel,
          },
        },
      })),
    invalidateQueryKeys: [authQuery.queryKey],
    defaultValues: { policy: undefined as unknown as CustomerAuthPolicyConfig },
    errorMessage: common("saveFailed"),
    canEdit,
    // The first render after the read can still hold the empty default.
    isValid: ({ policy }) =>
      Boolean(policy) &&
      policy.otpChannels.length > 0 && policy.otpChannels.every((channel) => channelReady(channel)),
  });
  if (isLoadError) return <SettingsLoadFailure title={t("loadSignIn")} onRetry={refetch} />;
  if (!values.policy) return <SettingsCardLoading />;
  const policy = values.policy;

  return (
    <SettingsCard id="customerSignIn" title={t("signInTitle")} description={t("signInDescription")}>
      <fieldset className="space-y-1">
        <legend className="text-body font-medium">{t("codeChannels")}</legend>
        {CUSTOMER_AUTH_OTP_CHANNELS.map((channel) => {
          const on = policy.otpChannels.includes(channel);
          return (
            <div key={channel}>
              <label className="flex min-h-11 items-start gap-3 py-3 text-body">
                <Checkbox
                  className="mt-0.5"
                  checked={on}
                  disabled={!canEdit || (on && policy.otpChannels.length === 1)}
                  onCheckedChange={() => setValue("policy", withChannel(policy, channel))}
                />
                {t(channel)}
              </label>
              {on && !channelReady(channel) ? (
                <p role="alert" className="pb-1 pl-7 text-body text-destructive">
                  <Link to="/admin/settings/notifications" hash="sending" className="underline underline-offset-2">
                    {t("channelNotReady", { channel: t(channel) })}
                  </Link>
                </p>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      {policy.otpChannels.length > 1 ? (
        <SettingsField id="signin-default" label={t("defaultChannel")}>
          <NativeSelect
            id="signin-default"
            className="max-w-xs"
            value={policy.defaultOtpChannel}
            disabled={!canEdit}
            onValueChange={(value) =>
              setValue("policy", { ...policy, defaultOtpChannel: value as CustomerAuthOtpChannel })}
          >
            {policy.otpChannels.map((channel) => (
              <option key={channel} value={channel}>{t(channel)}</option>
            ))}
          </NativeSelect>
        </SettingsField>
      ) : null}
      <fieldset className="space-y-1">
        <legend className="text-body font-medium">{t("askEmail")}</legend>
        <RadioGroup
          value={emailMode(policy)}
          disabled={!canEdit}
          onValueChange={(mode) => setValue("policy", withEmailMode(policy, mode as EmailMode))}
        >
          {(["none", "optional", "required"] as const).map((mode) => (
            <label key={mode} className="flex min-h-11 items-start gap-3 py-3 text-body">
              <RadioGroupItem className="mt-0.5" value={mode} disabled={mode !== "required" && emailOnly(policy)} />
              {t(mode === "none" ? "emailNone" : mode === "optional" ? "emailOptional" : "emailRequired")}
            </label>
          ))}
        </RadioGroup>
        <p className="text-body text-muted-foreground">{t(emailOnly(policy) ? "emailOnlyChannel" : "phoneAlways")}</p>
      </fieldset>
    </SettingsCard>
  );
}
