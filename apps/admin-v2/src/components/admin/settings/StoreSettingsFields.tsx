/** The Store details dialogs' fields: they load inside the existing SettingsDialog/save scope when a dialog first opens. */
import { lazy, Suspense, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ImageIcon, Plus, Trash2 } from "lucide-react";
import { z } from "zod";
import {
  postApiV1AdminSettingsBusiness,
  postApiV1AdminSettingsCurrency,
  putApiV1AdminSettingsPlatform,
} from "@scalius/api-client/sdk";
import { formatBdLandline, normalizeBdLandline } from "@scalius/shared/customer-utils";
import {
  SUPPORTED_CURRENCY_CODES,
  normalizeSupportedCurrencyCode,
} from "@scalius/shared/currency";
import { normalizePublicMediaUrl } from "@scalius/shared/media-url";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { currencySymbol } from "@scalius/shared/money-format";
import {
  normalizeDashboardUrl,
  normalizeMediaBaseUrl,
  normalizePlatformOriginUrl,
} from "@scalius/shared/platform-config";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import { usePermissions } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { apiData } from "~/lib/api";
import { normalizeCurrencySettingsInput, type CurrencySettingsPayload } from "~/lib/api-query-options/currency";
import { marketKeys } from "~/lib/api-query-options/markets";
import {
  businessQuery,
  countriesQuery,
  currencyQuery,
  platformQuery,
} from "~/lib/api-query-options/settings-screens";
import { queryKeys } from "~/lib/query-keys";
import { toast } from "~/lib/toast";
import { useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { storeSettingsMessages } from "~/i18n/settings-store";
import { fieldErrorMessages } from "~/i18n/save-bar";
import { MediaManager } from "../media-manager";
import { AdminPhoneInput, adminPhoneProblem, normalizeAdminPhone, type PhoneCountryPolicy } from "../shared/AdminPhoneInput";
import { SettingsField } from "./SettingsPage";
import { FieldSet, ReadOnlyValue } from "~/components/ui/field";
import {
  ADVANCED_URL_KEYS,
  MAIN_URL_KEYS,
  SettingsAdvanced,
  URL_KEYS,
  URL_LABELS,
  currencyName,
  useCanEditStore,
  type Business,
  type Platform,
  type SocialLink,
  type UrlKey,
} from "./store-settings-shared";

const ImageField = lazy(() => import("../online-store/ImageField").then((module) => ({ default: module.ImageField })));

const BUSINESS_DEFAULTS: Business = {
  companyName: "",
  legalName: "",
  taxId: "",
  phone: "",
  email: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  stateRegion: "",
  postalCode: "",
  country: "Bangladesh",
  invoicePrefix: "INV",
  invoiceLogoUrl: "",
  invoiceFooterText: "",
  socialLinks: [],
};

/** The most social profiles a store lists (the server's BUSINESS_SOCIAL_LINKS_MAX). */
const SOCIAL_LINKS_MAX = 8;

/** A profile address the storefront may link to: https, no credentials (the server checks the same). */
export function isSafeSocialDestination(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

// ── Business details ────────────────────────────────────────────────────

function isValidLogo(value: string) {
  return !value.trim() || Boolean(normalizePublicMediaUrl(value));
}

/** The server's limit (BUSINESS_FIELD_LIMITS.invoicePrefix), checked before Save. */
const INVOICE_PREFIX_MAX = 32;
const isValidInvoicePrefix = (value: string) => value.trim().length <= INVOICE_PREFIX_MAX;

const EMAIL = z.email();

/**
 * What's wrong with a contact field, as a catalog key. The server checks the
 * same. The store's own phone may also be a landline (02-9876543).
 */
function contactProblem(key: keyof Business, value: string, policy?: PhoneCountryPolicy) {
  if (key === "phone") return adminPhoneProblem(normalizeBdLandline(value) ?? value, policy);
  if (key === "email") return value.trim() && !EMAIL.safeParse(value.trim()).success ? "emailInvalid" : null;
  return null;
}

function useBusinessForm() {
  const common = useMessages(settingsMessages);
  const policy = useQuery(countriesQuery).data;
  return useSettingsForm<Business>({
    queryKey: businessQuery.queryKey,
    fetchFn: businessQuery.queryFn,
    saveFn: (values, expectedRevision) =>
      apiData(postApiV1AdminSettingsBusiness({ body: { ...values, expectedRevision } })),
    defaultValues: BUSINESS_DEFAULTS,
    toDraft: (values) => ({ ...values, phone: normalizeBdLandline(values.phone) ?? normalizeAdminPhone(values.phone) }),
    errorMessage: common("saveFailed"),
    canEdit: useCanEditStore(),
    isValid: (values) =>
      isValidLogo(values.invoiceLogoUrl) &&
      values.socialLinks.every((link) => isSafeSocialDestination(link.url)) &&
      isValidInvoicePrefix(values.invoicePrefix) &&
      !contactProblem("email", values.email) &&
      !contactProblem("phone", values.phone, policy),
    // `socialLinks.2.url` marks that profile's field (ids follow the list order).
    fields: (path) => `business-${path}`,
  });
}

export type BusinessKey = Exclude<keyof Business, "invoiceLogoUrl" | "invoiceFooterText" | "socialLinks">;

export function BusinessFields({ fields }: { fields: Array<{ key: BusinessKey; label: string; help?: string; type?: string }> }) {
  const t = useMessages(storeSettingsMessages);
  const { values, setValue } = useBusinessForm();
  const policy = useQuery(countriesQuery).data;
  return fields.map(({ key, label, help, type }) => {
    const id = `business-${key}`;
    const problem = contactProblem(key, values[key], policy);
    const describedBy = help ? `${id}-note` : undefined;
    return (
      <SettingsField key={key} id={id} label={label} help={help} error={problem ? t(problem) : null}>
        {key === "phone" ? (
          <AdminPhoneInput
            id={id}
            value={formatBdLandline(values.phone)}
            aria-describedby={describedBy}
            onChange={(next) => setValue("phone", next)}
            // Like a mobile, a landline settles into one shape on leaving: +880…, shown as 02-9876543.
            onBlur={(event) => {
              const landline = normalizeBdLandline(event.target.value);
              if (landline) setValue("phone", landline);
            }}
          />
        ) : (
          <Input
            id={id}
            type={type}
            value={values[key]}
            aria-describedby={describedBy}
            onChange={(event) => setValue(key, event.target.value)}
          />
        )}
      </SettingsField>
    );
  });
}

export function InvoiceFields() {
  const t = useMessages(storeSettingsMessages);
  const common = useMessages(settingsMessages);
  const fieldErrors = useMessages(fieldErrorMessages);
  const { values, setValue } = useBusinessForm();
  const logoUrl = values.invoiceLogoUrl.trim() ? normalizePublicMediaUrl(values.invoiceLogoUrl) : null;
  const prefix = values.invoicePrefix.trim() || "INV";
  return (
    <>
      <SettingsField
        id="business-invoicePrefix"
        label={t("invoicePrefix")}
        help={t("invoicePreview", { example: `${prefix}-00001` })}
        error={isValidInvoicePrefix(values.invoicePrefix) ? null : fieldErrors("maxLength", { count: INVOICE_PREFIX_MAX })}
      >
        <Input
          id="business-invoicePrefix"
          value={values.invoicePrefix}
          aria-describedby="business-invoicePrefix-note"
          className="max-w-xs"
          onChange={(event) => setValue("invoicePrefix", event.target.value)}
        />
      </SettingsField>
      <FieldSet label={t("invoiceLogo")} error={isValidLogo(values.invoiceLogoUrl) ? undefined : t("logoUrlInvalid")}>
        <div className="flex items-center gap-3">
          <div className="grid h-16 w-32 shrink-0 place-items-center rounded-lg border border-border bg-muted p-2">
            {logoUrl ? (
              <img src={mediaImageUrl(logoUrl, 480)} alt="" className="max-h-12 max-w-full object-contain" />
            ) : (
              <ImageIcon className="size-5 text-muted-foreground" aria-label={t("noLogo")} />
            )}
          </div>
          <MediaManager
            capability="image"
            onSelect={(file) => setValue("invoiceLogoUrl", file.url)}
            trigger={
              <Button type="button" variant="outline">
                {logoUrl ? t("changeLogo") : t("chooseLogo")}
              </Button>
            }
          />
          {values.invoiceLogoUrl ? (
            <Button type="button" variant="ghost" onClick={() => setValue("invoiceLogoUrl", "")}>
              {common("remove")}
            </Button>
          ) : null}
        </div>
      </FieldSet>
      <SettingsField id="business-invoiceFooterText" label={t("invoiceFooter")}>
        <Textarea
          id="business-invoiceFooterText"
          rows={3}
          value={values.invoiceFooterText}
          placeholder={t("invoiceFooterPlaceholder")}
          onChange={(event) => setValue("invoiceFooterText", event.target.value)}
        />
      </SettingsField>
    </>
  );
}

/**
 * The store's social profiles, in order: shown in the storefront's header,
 * footer and phone menu (their only source). Each is a name, an https link
 * and an optional icon from Files.
 */
export function SocialProfileFields() {
  const t = useMessages(storeSettingsMessages);
  const { values, setValue } = useBusinessForm();
  const links = values.socialLinks;
  const setLinks = (next: SocialLink[]) => setValue("socialLinks", next);
  const update = (id: string, updates: Partial<SocialLink>) =>
    setLinks(links.map((link) => (link.id === id ? { ...link, ...updates } : link)));
  return (
    <>
      <p className="text-body text-muted-foreground">{t("socialHelp")}</p>
      {links.length === 0 ? (
        <p className="text-body text-muted-foreground">{t("noSocial")}</p>
      ) : (
        // Ordered picks move with up/down buttons (DESIGN.md), as in the theme editor.
        <ol className="space-y-2">
          {links.map((link, index) => {
            const name = link.label.trim() || t("socialProfile", { number: index + 1 });
            const labelId = `business-socialLinks.${index}.label`;
            const urlId = `business-socialLinks.${index}.url`;
            const move = (step: -1 | 1) => {
              const next = [...links];
              [next[index], next[index + step]] = [next[index + step]!, next[index]!];
              setLinks(next);
            };
            return (
              <li key={link.id} className="flex items-start gap-2 rounded-lg border bg-card p-3">
                <div className="mt-6 flex shrink-0 flex-col">
                  <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0} aria-label={t("moveSocialUp", { name })} onClick={() => move(-1)}>
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" disabled={index === links.length - 1} aria-label={t("moveSocialDown", { name })} onClick={() => move(1)}>
                    <ArrowDown aria-hidden="true" />
                  </Button>
                </div>
                <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
                  <SettingsField id={labelId} label={t("socialLabel")}>
                    <Input
                      id={labelId}
                      value={link.label}
                      maxLength={200}
                      placeholder={t("socialLabelPlaceholder")}
                      onChange={(event) => update(link.id, { label: event.target.value })}
                    />
                  </SettingsField>
                  <SettingsField
                    id={urlId}
                    label={t("socialUrl")}
                    error={isSafeSocialDestination(link.url) ? null : t("socialUrlInvalid")}
                  >
                    <Input
                      id={urlId}
                      type="url"
                      inputMode="url"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      maxLength={2048}
                      value={link.url}
                      placeholder="https://facebook.com/yourshop"
                      onChange={(event) => update(link.id, { url: event.target.value })}
                    />
                  </SettingsField>
                  <div className="sm:col-span-2">
                    {/* The image field (and the online-store copy it speaks) loads with the first profile. */}
                    <Suspense fallback={<Skeleton className="h-16 w-full" />}>
                      <ImageField
                        label={t("socialIcon")}
                        src={link.iconUrl ?? ""}
                        onChange={(image) => setLinks(links.map((each) => {
                          if (each.id !== link.id) return each;
                          // Removing the icon drops the key: the server stores no empty icon.
                          const { iconUrl: _previous, ...rest } = each;
                          return image.src ? { ...rest, iconUrl: image.src } : rest;
                        }))}
                      />
                    </Suspense>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="mt-6 shrink-0"
                  aria-label={t("removeSocial", { name })}
                  onClick={() => setLinks(links.filter((each) => each.id !== link.id))}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ol>
      )}
      {links.length < SOCIAL_LINKS_MAX ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setLinks([...links, { id: crypto.randomUUID(), label: "", url: "" }])}
        >
          <Plus aria-hidden="true" />
          {t("addSocial")}
        </Button>
      ) : (
        <p className="text-body text-muted-foreground">{t("socialLimit", { count: SOCIAL_LINKS_MAX })}</p>
      )}
    </>
  );
}

function urlError(key: UrlKey, raw: string): "urlRequired" | "urlInvalid" | "dashboardUrlInvalid" | null {
  const value = raw.trim();
  if (key === "storefrontUrl" && !value) return "urlRequired";
  if (!value) return null;
  if (key === "dashboardUrl") return normalizeDashboardUrl(value) ? null : "dashboardUrlInvalid";
  if (key === "mediaUrl") return normalizeMediaBaseUrl(value) ? null : "urlInvalid";
  return normalizePlatformOriginUrl(value) ? null : "urlInvalid";
}

/**
 * After a save, whether the store address answers its `/health` page. The
 * storefront is another origin, so the check is a no-cors request: it fails
 * only when nothing answers there (a typo, a domain not set up yet).
 */
async function storefrontAnswers(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8000);
  try {
    await fetch(`${url.replace(/\/+$/, "")}/health`, { mode: "no-cors", cache: "no-store", credentials: "omit", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

export function WebAddressFields() {
  const t = useMessages(storeSettingsMessages);
  const common = useMessages(settingsMessages);
  // The developer's addresses (payment return, image hosting) are the store owner's to change.
  const isOwner = usePermissions().isSuperAdmin;
  const { values, setValue } = useSettingsForm<Platform, Platform>({
    queryKey: platformQuery.queryKey,
    fetchFn: platformQuery.queryFn,
    // PUT is a partial update: only the web addresses this person may change travel.
    saveFn: async (draft, expectedRevision) => {
      const keys = isOwner ? URL_KEYS : MAIN_URL_KEYS;
      const saved = await apiData(putApiV1AdminSettingsPlatform({
        body: { ...Object.fromEntries(keys.map((key) => [key, draft[key].trim()])), expectedRevision },
      }));
      const storeUrl = draft.storefrontUrl.trim();
      if (storeUrl && !(await storefrontAnswers(storeUrl))) toast.warning(t("storeUnreachable", { url: storeUrl }));
      return saved;
    },
    resolveSavedValues: (payload) => payload,
    invalidateQueryKeys: [queryKeys.settings.storefrontUrl(), queryKeys.settings.security(), queryKeys.settings.storeDefaults()],
    defaultValues: {} as Platform,
    errorMessage: common("saveFailed"),
    canEdit: useCanEditStore(),
    isValid: (draft) => (isOwner ? URL_KEYS : MAIN_URL_KEYS).every((key) => !urlError(key, draft[key] ?? "")),
    fields: (path) => `platform-${path}`,
  });
  const field = (key: UrlKey) => {
    const [label, help] = URL_LABELS[key];
    const error = urlError(key, values[key] ?? "");
    return (
      <SettingsField key={key} id={`platform-${key}`} label={t(label)} help={t(help)} error={error ? t(error) : null}>
        <Input
          id={`platform-${key}`}
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://"
          value={values[key] ?? ""}
          aria-invalid={Boolean(error)}
          aria-describedby={`platform-${key}-note`}
          onChange={(event) => setValue(key, event.target.value)}
        />
      </SettingsField>
    );
  };
  return (
    <>
      {MAIN_URL_KEYS.map(field)}
      {/* A newcomer never needs these: they stay closed, and open by themselves when one is wrong. */}
      <Suspense fallback={null}>
        <SettingsAdvanced
          label={t("advancedAddresses")}
          forceOpen={isOwner && ADVANCED_URL_KEYS.some((key) => Boolean(urlError(key, values[key] ?? "")))}
          defaultOpen={ADVANCED_URL_KEYS.some((key) => Boolean(values[key]))}
        >
          {isOwner
            ? ADVANCED_URL_KEYS.map(field)
            : ADVANCED_URL_KEYS.map((key) => (
              <ReadOnlyValue key={key} label={t(URL_LABELS[key][0])} value={values[key] || t("notSet")} help={t("ownerOnly")} />
            ))}
        </SettingsAdvanced>
      </Suspense>
    </>
  );
}

export function CurrencyFields() {
  const t = useMessages(storeSettingsMessages);
  const common = useMessages(settingsMessages);
  const { values, setValues, setValue } = useSettingsForm<CurrencySettingsPayload>({
    queryKey: currencyQuery.queryKey,
    fetchFn: currencyQuery.queryFn,
    saveFn: (draft, expectedRevision) =>
      apiData(postApiV1AdminSettingsCurrency({
        body: normalizeCurrencySettingsInput({
          currencyCode: draft.currencyCode,
          currencySymbol: draft.currencySymbol,
          expectedRevision,
        }),
      })),
    defaultValues: { currencyCode: "BDT", currencySymbol: "৳", priceIncrementMinor: 100, currencyCodeLocked: false, revision: 0 },
    // A new currency starts the backup market at its default price increment (Settings › Markets).
    invalidateQueryKeys: [marketKeys.all],
    errorMessage: common("saveFailed"),
    canEdit: useCanEditStore(),
  });
  const options = useMemo(
    () =>
      SUPPORTED_CURRENCY_CODES.map((code) => ({
        value: code,
        label: `${currencyName(code)} (${code} ${currencySymbol(code)})`,
        keywords: [code],
      })),
    [],
  );
  return (
    <>
      <SettingsField
        id="currency-code"
        label={t("currencyRow")}
        help={values.currencyCodeLocked ? t("currencyLocked") : t("currencyLockWarning")}
      >
        <SearchableSelect
          id="currency-code"
          value={values.currencyCode}
          options={options}
          disabled={values.currencyCodeLocked}
          searchPlaceholder={t("currencySearch")}
          emptyMessage={t("currencyNone")}
          triggerClassName="w-full"
          onValueChange={(code) => {
            const supported = normalizeSupportedCurrencyCode(code);
            if (supported) {
              setValues((draft) => ({
                ...draft,
                currencyCode: supported,
                currencySymbol: currencySymbol(supported),
              }));
            }
          }}
        />
      </SettingsField>
      <SettingsField id="currency-symbol" label={t("currencySymbol")}>
        <Input
          id="currency-symbol"
          value={values.currencySymbol}
          className="max-w-40"
          onChange={(event) => setValue("currencySymbol", event.target.value)}
        />
      </SettingsField>
    </>
  );
}
