import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteApiV1AdminSettingsCheckoutLanguagesById,
  getApiV1AdminSettingsCheckoutLanguages,
  getApiV1AdminSettingsCheckoutReadiness,
  getApiV1AdminSettingsCustomerRequests,
  postApiV1AdminSettingsCheckoutLanguages,
  putApiV1AdminSettingsCheckoutLanguagesById,
  putApiV1AdminSettingsCustomerRequests,
} from "@scalius/api-client/sdk";
import {
  CUSTOMER_REQUEST_INTRO_MAX_LENGTH,
  type CustomerRequestPolicy,
} from "@scalius/core/modules/settings/customer-request-policy.shared";
import {
  getCheckoutLanguagePreset,
  resolveCheckoutLanguageData,
} from "@scalius/shared/checkout-language";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData, type ApiResult } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { checkoutMessages } from "~/i18n/settings-checkout";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useSaveBar } from "../shared/SaveBar";
import { useCheckoutFlowForm } from "./PaymentsSettings";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsDialog, SettingsField, SettingsRow, SettingsCardLoading } from "./SettingsPage";

type Language = ApiResult<typeof getApiV1AdminSettingsCheckoutLanguages>["languages"][number];
type FieldKey = "showEmailField" | "showOrderNotesField" | "showAreaField";

const LANGUAGES_PARAMS = { page: 1, limit: 10, sort: "name", order: "asc" } as const;
export const languagesQuery = {
  queryKey: queryKeys.settings.checkoutLanguages(LANGUAGES_PARAMS),
  queryFn: () => apiData(getApiV1AdminSettingsCheckoutLanguages({ query: LANGUAGES_PARAMS })),
};
export const checkoutReadinessQuery = {
  queryKey: queryKeys.settings.checkoutReadiness(),
  queryFn: () => apiData(getApiV1AdminSettingsCheckoutReadiness()),
};
export const customerRequestsQuery = {
  queryKey: queryKeys.settings.customerRequests(),
  queryFn: async () => (await apiData(getApiV1AdminSettingsCustomerRequests())).policy,
};

const TEXT_FIELDS = [
  "pageTitle",
  "checkoutSectionTitle",
  "customerNameLabel",
  "customerNamePlaceholder",
  "customerPhoneLabel",
  "customerPhonePlaceholder",
  "customerPhoneHelp",
  "customerEmailLabel",
  "customerEmailPlaceholder",
  "shippingAddressLabel",
  "shippingAddressPlaceholder",
  "cityLabel",
  "zoneLabel",
  "areaLabel",
  "placeOrderText",
  "processingText",
] as const;
const FORM_FIELDS: Array<[FieldKey, "askEmail" | "orderNotes" | "area"]> = [
  ["showEmailField", "askEmail"],
  ["showOrderNotesField", "orderNotes"],
  ["showAreaField", "area"],
];

function useCanEditCheckout() {
  return useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
}

/** The storefront uses the active language, else the fallback one. */
function checkoutLanguage(languages: readonly Language[] | undefined): Language | undefined {
  return languages?.find((language) => language.isActive) ?? languages?.find((language) => language.isDefault);
}

function visibility(language: Language | undefined, key: FieldKey): boolean {
  const saved = (language?.fieldVisibility ?? {}) as Partial<Record<FieldKey, boolean>>;
  return saved[key] ?? true;
}

// ── Customer contact: guest checkout + form fields ──────────────────────

/**
 * Form fields live on the checkout language; edit the one buyers see. With
 * no language yet, saving creates the English one with these fields.
 */
function FormFields({ language, disabled }: { language: Language | undefined; disabled: boolean }) {
  const t = useMessages(checkoutMessages);
  const queryClient = useQueryClient();
  const saved = Object.fromEntries(FORM_FIELDS.map(([key]) => [key, visibility(language, key)])) as Record<FieldKey, boolean>;
  const [draft, setDraft] = useState(saved);
  const dirty = FORM_FIELDS.some(([key]) => draft[key] !== saved[key]);
  const save = useMutation({
    mutationFn: (): Promise<unknown> =>
      language
        ? apiData(putApiV1AdminSettingsCheckoutLanguagesById({ path: { id: language.id }, body: { fieldVisibility: draft } }))
        : apiData(postApiV1AdminSettingsCheckoutLanguages({
            body: {
              name: "English",
              code: "en",
              isActive: true,
              isDefault: true,
              languageData: getCheckoutLanguagePreset("en"),
              fieldVisibility: draft,
            },
          })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutLanguages() }),
  });
  useSaveBar({
    dirty,
    saving: save.isPending,
    invalid: disabled,
    label: t("contactTitle"),
    save: () => save.mutateAsync(),
    discard: () => setDraft(saved),
  });
  return FORM_FIELDS.map(([key, label]) => (
    <label key={key} className="flex min-h-11 items-start gap-3 py-3 text-body">
      <Checkbox
        className="mt-0.5"
        checked={draft[key]}
        disabled={disabled}
        onCheckedChange={(checked) => setDraft((current) => ({ ...current, [key]: checked === true }))}
      />
      {t(label)}
    </label>
  ));
}

export function CustomerContactCard() {
  const t = useMessages(checkoutMessages);
  const canEdit = useCanEditCheckout();
  const readiness = useQuery(checkoutReadinessQuery);
  const languages = useQuery(languagesQuery);
  // Requiring accounts fails closed until customer sign-in is known to work.
  const signInReady = readiness.data?.hasUsableCustomerSignIn === true;
  const { values, setValue, isLoadError, refetch } = useCheckoutFlowForm(
    (draft) => draft.guestCheckoutEnabled || signInReady,
    t("contactTitle"),
  );
  if (isLoadError) return <SettingsLoadFailure title={t("loadFlow")} onRetry={refetch} />;
  if (values.revision === undefined) return <SettingsCardLoading />;
  const language = checkoutLanguage(languages.data?.languages);
  return (
    <SettingsCard id="customerContact" title={t("contactTitle")}>
      <label className="flex min-h-11 items-center justify-between gap-4 text-body">
        <span>
          <span className="block font-medium">{t("guest")}</span>
          <span className="block text-muted-foreground">{t("guestHelp")}</span>
        </span>
        <Switch
          checked={values.guestCheckoutEnabled}
          disabled={!canEdit}
          onCheckedChange={(on) => setValue("guestCheckoutEnabled", on)}
        />
      </label>
      {!values.guestCheckoutEnabled && !signInReady ? (
        <p role="alert" className="text-body text-destructive">{t("signInNotReady")}</p>
      ) : null}
      <p className="text-body text-muted-foreground">{t("phoneAlways")}</p>
      <div className="border-t border-border pt-2">
        <FormFields
          key={language ? `${language.id}:${JSON.stringify(language.fieldVisibility)}` : "none"}
          language={language}
          disabled={!canEdit}
        />
      </div>
    </SettingsCard>
  );
}

// ── Checkout text (languages) ───────────────────────────────────────────

interface LanguageDraft {
  name: string;
  code: string;
  isActive: boolean;
  isDefault: boolean;
  languageData: Record<string, string>;
}

function toDraft(language: Language | null): LanguageDraft {
  if (!language) {
    return { name: "", code: "", isActive: false, isDefault: false, languageData: getCheckoutLanguagePreset("en") };
  }
  return {
    name: language.name,
    code: language.code,
    isActive: language.isActive,
    isDefault: language.isDefault,
    languageData: { ...getCheckoutLanguagePreset(language.code), ...(language.languageData as Record<string, string>) },
  };
}

function LanguageForm({ language }: { language: Language | null }) {
  const t = useMessages(checkoutMessages);
  const common = useMessages(settingsMessages);
  const queryClient = useQueryClient();
  const [saved] = useState(() => toDraft(language));
  const [draft, setDraft] = useState(saved);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutLanguages() });
  const save = useMutation({
    mutationFn: () =>
      language
        ? apiData(putApiV1AdminSettingsCheckoutLanguagesById({ path: { id: language.id }, body: draft }))
        : apiData(postApiV1AdminSettingsCheckoutLanguages({ body: draft })),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => apiData(deleteApiV1AdminSettingsCheckoutLanguagesById({ path: { id: language!.id } })),
    onSuccess: async () => {
      toast.success(t("deleted"));
      await refresh();
    },
    onError: () => toast.error(common("saveFailed")),
  });
  useSaveBar({
    dirty,
    saving: save.isPending,
    invalid: !draft.name.trim() || !draft.code.trim(),
    save: () => save.mutateAsync(),
    discard: () => setDraft(saved),
  });
  const setText = (key: string, value: string) =>
    setDraft((current) => ({ ...current, languageData: { ...current.languageData, [key]: value } }));

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsField id="language-name" label={t("name")}>
          <Input id="language-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </SettingsField>
        <SettingsField id="language-code" label={t("code")} help={t("codeHelp")}>
          <Input
            id="language-code"
            value={draft.code}
            aria-describedby="language-code-note"
            onChange={(event) =>
              setDraft({
                ...draft,
                code: event.target.value,
                languageData: resolveCheckoutLanguageData(event.target.value, draft.languageData),
              })}
          />
        </SettingsField>
      </div>
      {(["isActive", "isDefault"] as const).map((key) => (
        <label key={key} className="flex min-h-11 items-center justify-between gap-4 text-body font-medium">
          {key === "isActive" ? t("useAtCheckout") : t("useAsFallback")}
          <Switch checked={draft[key]} onCheckedChange={(on) => setDraft({ ...draft, [key]: on })} />
        </label>
      ))}
      <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
        {TEXT_FIELDS.map((key) => (
          <SettingsField key={key} id={`language-${key}`} label={t(key)}>
            <Input id={`language-${key}`} value={draft.languageData[key] ?? ""} onChange={(event) => setText(key, event.target.value)} />
          </SettingsField>
        ))}
      </div>
      <SettingsField id="language-terms" label={t("termsText")}>
        <Textarea id="language-terms" rows={2} value={draft.languageData.termsText ?? ""} onChange={(event) => setText("termsText", event.target.value)} />
      </SettingsField>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => setDraft({ ...draft, languageData: getCheckoutLanguagePreset(draft.code) })}
        >
          {t("resetText")}
        </Button>
        {language ? (
          <Button type="button" variant="ghost" onClick={() => setConfirmDelete(true)}>
            {t("deleteLanguage")}
          </Button>
        ) : null}
      </div>
      {language ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={t("deleteLanguage")}
          description={t("deleteConfirm", { name: language.name })}
          confirmLabel={common("delete")}
          cancelLabel={common("cancel")}
          isLoading={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      ) : null}
    </>
  );
}

export function CheckoutTextCard() {
  const t = useMessages(checkoutMessages);
  const canEdit = useCanEditCheckout();
  const { data, isError, refetch } = useQuery(languagesQuery);
  if (isError) return <SettingsLoadFailure title={t("loadLanguages")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;
  return (
    <SettingsCard id="checkoutText"
      title={t("textTitle")}
      description={data.languages.length ? t("textDescription") : t("noLanguages")}
      action={
        <SettingsDialog
          title={t("addLanguage")}
          trigger={<Button type="button" variant="outline" size="sm" disabled={!canEdit}>{t("addLanguage")}</Button>}
        >
          <LanguageForm language={null} />
        </SettingsDialog>
      }
      rows={
        data.languages.length
          ? data.languages.map((language) => (
              <SettingsDialog
                key={language.id}
                title={t("editLanguage", { name: language.name })}
                trigger={
                  <SettingsRow
                    disabled={!canEdit}
                    label={
                      <span className="flex items-center gap-2">
                        {language.name}
                        {language.isActive ? <Badge>{t("active")}</Badge> : null}
                        {language.isDefault ? <Badge variant="secondary">{t("fallback")}</Badge> : null}
                      </span>
                    }
                    value={language.code}
                  />
                }
              >
                <LanguageForm language={language} />
              </SettingsDialog>
            ))
          : null
      }
    />
  );
}

// ── Customer requests ───────────────────────────────────────────────────

export function CustomerRequestsCard() {
  const t = useMessages(checkoutMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useCanEditCheckout();
  const { values, setValue, isLoadError, refetch } = useSettingsForm<CustomerRequestPolicy, CustomerRequestPolicy>({
    label: t("requestsTitle"),
    queryKey: customerRequestsQuery.queryKey,
    fetchFn: customerRequestsQuery.queryFn,
    saveFn: async (draft) => (await apiData(putApiV1AdminSettingsCustomerRequests({ body: draft }))).policy,
    resolveSavedValues: (saved) => saved,
    defaultValues: {} as CustomerRequestPolicy,
    errorMessage: common("saveFailed"),
    canEdit,
  });
  if (isLoadError) return <SettingsLoadFailure title={t("loadRequests")} onRetry={refetch} />;
  if (values.visibility === undefined) return <SettingsCardLoading />;
  const switches = [
    ["cancellationEnabled", "cancellationHelp"],
    ["returnEnabled", "returnHelp"],
    ["refundEnabled", "refundHelp"],
  ] as const;
  return (
    <SettingsCard id="customerRequests" title={t("requestsTitle")} description={t("requestsDescription")}>
      {switches.map(([key, help]) => (
        <label key={key} className="flex min-h-11 items-center justify-between gap-4 text-body">
          <span>
            <span className="block font-medium">{t(key)}</span>
            <span className="block text-muted-foreground">{t(help)}</span>
          </span>
          <Switch checked={values[key]} disabled={!canEdit} onCheckedChange={(on) => setValue(key, on)} />
        </label>
      ))}
      <label className="flex min-h-11 items-start gap-3 border-t border-border pt-4 py-3 text-body">
        <Checkbox
          className="mt-0.5"
          checked={values.visibility === "show_unavailable"}
          disabled={!canEdit}
          onCheckedChange={(checked) => setValue("visibility", checked === true ? "show_unavailable" : "eligible_only")}
        />
        {t("showUnavailable")}
      </label>
      <SettingsField id="request-intro" label={t("intro")}>
        <Textarea
          id="request-intro"
          rows={3}
          maxLength={CUSTOMER_REQUEST_INTRO_MAX_LENGTH}
          disabled={!canEdit}
          value={values.introText ?? ""}
          placeholder={t("introPlaceholder")}
          onChange={(event) => setValue("introText", event.target.value || null)}
        />
      </SettingsField>
    </SettingsCard>
  );
}
