import { putApiV1AdminSettingsMarketingConsent } from "@scalius/api-client/sdk";
import {
  MARKETING_CONTACT_CHANNELS,
  MARKETING_CONSENT_LABEL_MAX,
  type MarketingConsentSettings,
} from "@scalius/shared/customer-marketing";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData } from "~/lib/api";
import { marketingConsentQuery } from "~/lib/api-query-options/settings-screens";
import { useMessages } from "~/i18n";
import { customerMarketingMessages } from "~/i18n/customer-marketing";
import { customersMessages } from "~/i18n/customers";
import { settingsMessages } from "~/i18n/settings";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsCardLoading, SettingsField } from "./SettingsPage";

type MarketingChannel = MarketingConsentSettings["checkout"]["channels"][number];
type Values = { settings: MarketingConsentSettings };
type Language = "en" | "bn";

/** Field ids of the card's controls, by API body path. */
const LABEL_ID: Record<Language, string> = { en: "marketing-label-en", bn: "marketing-label-bn" };

/** The text problem of one checkbox label, or null. */
export function marketingLabelProblem(text: string): "required" | "too_long" | null {
  const value = text.trim();
  if (!value) return "required";
  return value.length > MARKETING_CONSENT_LABEL_MAX ? "too_long" : null;
}

function toggleChannel(channels: readonly MarketingChannel[], channel: MarketingChannel): MarketingChannel[] {
  const on = new Set(channels);
  if (on.has(channel)) on.delete(channel);
  else on.add(channel);
  return MARKETING_CONTACT_CHANNELS.filter((item) => on.has(item));
}

/**
 * Settings → Customer accounts → Marketing: the checkout's marketing checkbox
 * (on or off, the channels it subscribes, its text in English and Bangla; it
 * is never ticked in advance and never required) and e-mail double opt-in.
 * One settings document, saved at the revision it was loaded at.
 */
export function MarketingConsentCard() {
  const t = useMessages(customerMarketingMessages);
  const c = useMessages(customersMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const { values, setValue, isLoadError, refetch } = useSettingsForm<Values, Values & { revision: number }, number>({
    label: t("marketingSettingsTitle"),
    queryKey: marketingConsentQuery.queryKey,
    fetchFn: marketingConsentQuery.queryFn,
    saveFn: ({ settings }, expectedRevision) =>
      apiData(putApiV1AdminSettingsMarketingConsent({ body: { settings, expectedRevision } })),
    resolveSavedValues: (result) => ({ settings: result.settings }),
    defaultValues: { settings: undefined as unknown as MarketingConsentSettings },
    errorMessage: common("saveFailed"),
    canEdit,
    fields: (path) => {
      if (path.startsWith("settings.checkout.label.en")) return LABEL_ID.en;
      if (path.startsWith("settings.checkout.label.bn")) return LABEL_ID.bn;
      if (path.startsWith("settings.checkout.channels")) return "marketing-channels";
      return undefined;
    },
    // The first render after the read can still hold the empty default.
    isValid: ({ settings }) =>
      Boolean(settings) &&
      settings.checkout.channels.length > 0 &&
      marketingLabelProblem(settings.checkout.label.en) === null &&
      marketingLabelProblem(settings.checkout.label.bn) === null,
  });
  if (isLoadError) return <SettingsLoadFailure title={t("loadMarketingSettings")} onRetry={refetch} />;
  if (!values.settings) return <SettingsCardLoading />;
  const settings = values.settings;
  const set = (next: MarketingConsentSettings) => setValue("settings", next);
  const checkout = settings.checkout;
  const labelError = (language: Language) => {
    const problem = marketingLabelProblem(checkout.label[language]);
    return problem === "required"
      ? t("checkboxTextRequired")
      : problem === "too_long" ? t("checkboxTextTooLong", { count: MARKETING_CONSENT_LABEL_MAX }) : undefined;
  };

  return (
    <SettingsCard id="marketingConsent" title={t("marketingSettingsTitle")} description={t("marketingSettingsDescription")}>
      <label className="flex min-h-11 items-start justify-between gap-4 text-body">
        <span className="space-y-1">
          <span className="block font-medium">{t("checkoutCheckbox")}</span>
          <span className="block text-muted-foreground">{t("checkoutCheckboxHelp")}</span>
        </span>
        <Switch
          className="mt-0.5"
          checked={checkout.enabled}
          disabled={!canEdit}
          onCheckedChange={(enabled) => set({ ...settings, checkout: { ...checkout, enabled } })}
        />
      </label>

      <div className="space-y-4 border-t border-border pt-4">
        <fieldset id="marketing-channels" className="space-y-1" aria-describedby="marketing-channels-note">
          <legend className="text-body font-medium">{t("checkboxChannels")}</legend>
          {MARKETING_CONTACT_CHANNELS.map((channel) => {
            const on = checkout.channels.includes(channel);
            return (
              <label key={channel} className="flex min-h-11 items-center gap-3 text-body md:min-h-9">
                <Checkbox
                  checked={on}
                  // The last channel stays: the checkbox has to subscribe to something.
                  disabled={!canEdit || (on && checkout.channels.length === 1)}
                  onCheckedChange={() => set({ ...settings, checkout: { ...checkout, channels: toggleChannel(checkout.channels, channel) } })}
                />
                {c(`channel.${channel}`)}
              </label>
            );
          })}
          <p id="marketing-channels-note" className={checkout.channels.length ? "text-body text-muted-foreground" : "text-body text-destructive"}>
            {checkout.channels.length ? t("checkboxChannelsHelp") : t("channelsRequired")}
          </p>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="mb-2 text-body font-medium">{t("checkboxText")}</legend>
          {(["en", "bn"] as const).map((language) => (
            <SettingsField
              key={language}
              id={LABEL_ID[language]}
              label={t(language === "en" ? "checkboxTextEn" : "checkboxTextBn")}
              error={labelError(language)}
            >
              <Input
                id={LABEL_ID[language]}
                lang={language}
                value={checkout.label[language]}
                maxLength={MARKETING_CONSENT_LABEL_MAX + 50}
                disabled={!canEdit}
                onChange={(event) => set({
                  ...settings,
                  checkout: { ...checkout, label: { ...checkout.label, [language]: event.target.value } },
                })}
              />
            </SettingsField>
          ))}
        </fieldset>
      </div>

      <label className="flex min-h-11 items-start justify-between gap-4 border-t border-border pt-4 text-body">
        <span className="space-y-1">
          <span className="block font-medium">{t("doubleOptIn")}</span>
          <span className="block text-muted-foreground">{t("doubleOptInHelp")}</span>
        </span>
        <Switch
          className="mt-0.5"
          checked={settings.emailDoubleOptIn}
          disabled={!canEdit}
          onCheckedChange={(emailDoubleOptIn) => set({ ...settings, emailDoubleOptIn })}
        />
      </label>
    </SettingsCard>
  );
}
