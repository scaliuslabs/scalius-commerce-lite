import { createFileRoute } from "@tanstack/react-router";
import { getApiV1AdminSettingsSeo, postApiV1AdminSettingsSeo } from "@scalius/api-client/sdk";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import {
  isValidSeoReturnPolicyUrl,
  normalizeSeoReturnPolicySettings,
  type SeoReturnPolicySettings,
} from "@scalius/shared/seo-return-policy";
import { Input } from "~/components/ui/input";
import { PoliciesCard, StorePagePicker, policiesQuery, storePagesQuery } from "~/components/admin/settings/PoliciesCard";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { NativeSelect } from "~/components/ui/native-select";
import { SettingsLoadFailure } from "~/components/admin/settings/SettingsLoadFailure";
import { SettingsCard, SettingsField, SettingsPage, SettingsCardLoading } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { apiData } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { RouteErrorComponent } from "~/lib/route-error";
import { useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { policiesMessages } from "~/i18n/settings-policies";

// The return policy lives in the SEO settings document; only its
// `returnPolicy` part is read and written here (the POST is partial).
const returnPolicyQuery = {
  queryKey: [...queryKeys.settings.seo(), "return-policy"],
  queryFn: async () => {
    const seo = await apiData(getApiV1AdminSettingsSeo()) as { returnPolicy?: unknown; revision: number };
    return { ...normalizeSeoReturnPolicySettings(seo.returnPolicy), revision: seo.revision };
  },
};

export const Route = createFileRoute("/admin/settings/policies")({
  loader: ({ context: { queryClient } }) =>
    Promise.allSettled([
      queryClient.ensureQueryData(returnPolicyQuery),
      queryClient.ensureQueryData(policiesQuery),
      queryClient.ensureQueryData(storePagesQuery),
    ]),
  head: () => settingsHead("policies"),
  errorComponent: RouteErrorComponent,
  component: PoliciesPage,
});

type Choice = "not_set" | SeoReturnPolicySettings["category"];

function validDays(value: number | null): boolean {
  return Number.isInteger(value) && value! >= 1 && value! <= 365;
}

function ReturnPolicyCard({ canEdit }: { canEdit: boolean }) {
  const t = useMessages(policiesMessages);
  const common = useMessages(settingsMessages);
  const { values, setValues, setValue, isLoadError, refetch } = useSettingsForm<SeoReturnPolicySettings>({
    label: t("returnsTitle"),
    queryKey: returnPolicyQuery.queryKey,
    fetchFn: returnPolicyQuery.queryFn,
    saveFn: (draft, expectedRevision) =>
      apiData(postApiV1AdminSettingsSeo({
        body: { returnPolicy: { ...draft, policyUrl: draft.policyUrl.trim() }, expectedRevision },
      })),
    invalidateQueryKeys: [queryKeys.settings.seo()],
    defaultValues: {} as SeoReturnPolicySettings,
    errorMessage: common("saveFailed"),
    canEdit,
    isValid: (draft) =>
      isValidSeoReturnPolicyUrl(draft.policyUrl) && (!draft.enabled || draft.category !== "finite" || validDays(draft.returnWindowDays)),
  });
  if (isLoadError) return <SettingsLoadFailure title={t("load")} onRetry={refetch} />;
  if (values.category === undefined) return <SettingsCardLoading />;

  const choice: Choice = values.enabled ? values.category : "not_set";
  const accepts = values.enabled && values.category !== "no_returns";
  const urlValid = isValidSeoReturnPolicyUrl(values.policyUrl);
  const choices: Array<[Choice, "notSet" | "finite" | "unlimited" | "noReturns"]> = [
    ["not_set", "notSet"],
    ["finite", "finite"],
    ["unlimited", "unlimited"],
    ["no_returns", "noReturns"],
  ];
  return (
    <SettingsCard id="returnPolicy" title={t("returnsTitle")} description={t("returnsDescription")}>
      <RadioGroup
        value={choice}
        disabled={!canEdit}
        aria-label={t("returns")}
        onValueChange={(next) =>
          setValues((draft) =>
            next === "not_set"
              ? { ...draft, enabled: false }
              : {
                  ...draft,
                  enabled: true,
                  category: next as SeoReturnPolicySettings["category"],
                  returnWindowDays: next === "finite" ? draft.returnWindowDays ?? 7 : null,
                },
          )}
      >
        {choices.map(([value, label]) => (
          <label key={value} className="flex min-h-11 items-start gap-3 py-3 text-body">
            <RadioGroupItem className="mt-0.5" value={value} />
            {t(label)}
          </label>
        ))}
      </RadioGroup>
      {values.enabled && values.category === "finite" ? (
        <SettingsField id="return-days" label={t("days")} error={validDays(values.returnWindowDays) ? null : t("daysInvalid")}>
          <Input
            id="return-days"
            type="number"
            inputMode="numeric"
            min="1"
            max="365"
            className="max-w-32"
            disabled={!canEdit}
            value={values.returnWindowDays ?? ""}
            aria-invalid={!validDays(values.returnWindowDays)}
            aria-describedby="return-days-note"
            onChange={(event) => setValue("returnWindowDays", event.target.value ? Number(event.target.value) : null)}
          />
        </SettingsField>
      ) : null}
      {accepts ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <SettingsField id="return-fees" label={t("fees")}>
            <NativeSelect id="return-fees" value={values.returnFees} disabled={!canEdit} onValueChange={(fees) => setValue("returnFees", fees as SeoReturnPolicySettings["returnFees"])}>
              <option value="free">{t("free")}</option>
              <option value="customer_responsibility">{t("customerPays")}</option>
            </NativeSelect>
          </SettingsField>
          <SettingsField id="return-method" label={t("method")}>
            <NativeSelect id="return-method" value={values.returnMethod} disabled={!canEdit} onValueChange={(method) => setValue("returnMethod", method as SeoReturnPolicySettings["returnMethod"])}>
              <option value="mail">{t("mail")}</option>
              <option value="in_store">{t("inStore")}</option>
              <option value="both">{t("both")}</option>
            </NativeSelect>
          </SettingsField>
        </div>
      ) : null}
      {values.enabled ? (
        <SettingsField id="return-url" label={t("policyUrl")} help={t("policyUrlHelp")} error={urlValid ? null : t("policyUrlInvalid")}>
          <StorePagePicker
            id="return-url"
            value={values.policyUrl}
            valueOf={(page) => `/${page.slug}`}
            disabled={!canEdit}
            onChange={(path) => setValue("policyUrl", path)}
          />
        </SettingsField>
      ) : null}
    </SettingsCard>
  );
}

function PoliciesPage() {
  const canEdit = useHasPermission(PERMISSIONS.SETTINGS_SEO_EDIT);
  return (
    <SettingsPage page="policies" readOnly={!canEdit}>
      <PoliciesCard canEdit={canEdit} />
      <ReturnPolicyCard canEdit={canEdit} />
    </SettingsPage>
  );
}
