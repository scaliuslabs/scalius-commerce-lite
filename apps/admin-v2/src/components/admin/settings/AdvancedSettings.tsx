import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { toast } from "sonner";
import {
  getApiV1AdminSettingsMedia,
  getApiV1AdminSettingsPlatform,
  getApiV1AdminSettingsSecurity,
  getApiV1AdminSettingsSecurityRuntimeSources,
  postApiV1AdminSettingsMedia,
  postApiV1AdminSettingsSecurity,
  postApiV1CacheClear,
  putApiV1AdminSettingsPlatform,
} from "@scalius/api-client/sdk";
import {
  PLATFORM_CORS_ORIGINS_MAX_COUNT,
  normalizeCookieDomain,
  normalizeIdentityHandoffConfig,
  normalizeJwksUrl,
  normalizePlatformOriginUrl,
} from "@scalius/shared/platform-config";
import {
  normalizeMerchantCspSource,
  parseMerchantCspSources,
  serializeMerchantCspSources,
  type CspSourceProblem,
} from "@scalius/shared/security-csp";
import { Button } from "~/components/ui/button";
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
import { advancedSettingsMessages } from "~/i18n/settings-advanced";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsDialog, SettingsField, SettingsRow, SettingsCardLoading } from "./SettingsPage";
import { platformQuery } from "./StoreSettings";

type Platform = Omit<ApiResult<typeof getApiV1AdminSettingsPlatform>, "revision">;
type Handoff = Platform["identityHandoff"];

function useCanEdit() {
  return useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
}

/** Add/remove list of website origins, with inline validation. */
function OriginList({
  id,
  label,
  origins,
  onChange,
  normalize,
  max,
  disabled,
}: {
  id: string;
  label: string;
  origins: string[];
  onChange: (next: string[]) => void;
  /** The canonical origin, or what's wrong with the entry. */
  normalize: (raw: string) => { value: string | null; error?: CspSourceProblem | null };
  max?: number;
  disabled?: boolean;
}) {
  const t = useMessages(advancedSettingsMessages);
  const common = useMessages(settingsMessages);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function add() {
    const { value: origin, error: problem } = normalize(draft);
    if (!origin) return setError(t(problem === "https" ? "trustedHttps" : problem === "path" ? "trustedPath" : "trustedInvalid"));
    if (origins.includes(origin)) return setError(t("trustedDuplicate"));
    if (max !== undefined && origins.length >= max) return setError(t("corsLimit", { count: max }));
    onChange([...origins, origin]);
    setDraft("");
    setError(null);
  }

  return (
    <div className="space-y-3">
      <SettingsField id={id} label={label}>
        <div className="flex gap-2">
          <Input
            id={id}
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={draft}
            disabled={disabled}
            placeholder={t("trustedPlaceholder")}
            aria-invalid={Boolean(error)}
            aria-describedby={`${id}-note`}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
          />
          <Button type="button" variant="outline" disabled={disabled || !draft.trim()} onClick={add}>
            {common("add")}
          </Button>
        </div>
        {/* Add is an explicit action, so its verdict shows at once (Enter or the button). */}
        {error ? <p id={`${id}-note`} role="alert" className="text-body text-destructive">{error}</p> : null}
      </SettingsField>
      {origins.length > 0 ? (
        <ul className="divide-y divide-border border-y border-border">
          {origins.map((origin) => (
            <li key={origin} className="flex min-h-11 items-center justify-between gap-3">
              <span className="min-w-0 truncate text-body">{origin}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                aria-label={`${common("remove")} ${origin}`}
                onClick={() => onChange(origins.filter((item) => item !== origin))}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body text-muted-foreground">{t("trustedEmpty")}</p>
      )}
    </div>
  );
}

// ── Trusted websites (storefront content security policy) ───────────────

export const trustedWebsitesQuery = {
  queryKey: queryKeys.settings.security(),
  // Platform origins are always trusted, so only merchant additions show.
  queryFn: async () => {
    const [security, inherited] = await Promise.all([
      apiData(getApiV1AdminSettingsSecurity()),
      apiData(getApiV1AdminSettingsSecurityRuntimeSources()),
    ]);
    const platform = new Set(inherited.map((source) => source.source).filter(Boolean));
    return {
      sources: parseMerchantCspSources(security.cspAllowedDomains).filter((source) => !platform.has(source)),
      revision: security.revision,
    };
  },
};

export function TrustedWebsitesCard() {
  const t = useMessages(advancedSettingsMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useCanEdit();
  const { values, setValue, isLoadError, refetch } = useSettingsForm<{ sources: string[] }>({
    label: t("trustedTitle"),
    queryKey: trustedWebsitesQuery.queryKey,
    fetchFn: trustedWebsitesQuery.queryFn,
    saveFn: (draft, expectedRevision) =>
      apiData(postApiV1AdminSettingsSecurity({
        body: { cspAllowedDomains: serializeMerchantCspSources(draft.sources), expectedRevision },
      })),
    defaultValues: { sources: [] },
    errorMessage: common("saveFailed"),
    canEdit,
    fields: { cspAllowedDomains: "trusted-website" },
  });
  if (isLoadError) return <SettingsLoadFailure title={t("trustedLoad")} onRetry={refetch} />;
  return (
    <SettingsCard id="trustedWebsites" title={t("trustedTitle")} description={t("trustedDescription")}>
      <OriginList
        id="trusted-website"
        label={t("websiteLabel")}
        origins={values.sources}
        disabled={!canEdit}
        normalize={normalizeMerchantCspSource}
        onChange={(sources) => setValue("sources", sources)}
      />
    </SettingsCard>
  );
}

// ── Image delivery ──────────────────────────────────────────────────────

interface MediaValues {
  canonicalCdnUrl: string;
  aliases: string;
}

export const mediaQuery = {
  queryKey: queryKeys.settings.media(),
  queryFn: async (): Promise<MediaValues & { revision: number }> => {
    const data = (await apiData(getApiV1AdminSettingsMedia())) as {
      canonicalCdnUrl?: string;
      canonicalHostAliases?: string[];
      revision: number;
    };
    return {
      canonicalCdnUrl: data.canonicalCdnUrl ?? "",
      aliases: (data.canonicalHostAliases ?? []).join("\n"),
      revision: data.revision,
    };
  },
};

function hostsFromLines(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim().replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase())
    .filter(Boolean);
}

function ImageDeliveryFields() {
  const t = useMessages(advancedSettingsMessages);
  const common = useMessages(settingsMessages);
  const { values, setValue } = useSettingsForm<MediaValues>({
    queryKey: mediaQuery.queryKey,
    fetchFn: mediaQuery.queryFn,
    saveFn: (draft, expectedRevision) =>
      apiData(postApiV1AdminSettingsMedia({
        body: {
          canonicalCdnUrl: draft.canonicalCdnUrl.trim(),
          canonicalHostAliases: hostsFromLines(draft.aliases),
          expectedRevision,
        },
      })),
    defaultValues: { canonicalCdnUrl: "", aliases: "" },
    errorMessage: common("saveFailed"),
    canEdit: useCanEdit(),
  });
  return (
    <>
      <SettingsField id="media-host" label={t("imagesHost")} help={t("imagesHostHelp")}>
        <Input
          id="media-host"
          value={values.canonicalCdnUrl}
          placeholder="cdn.yourshop.com"
          aria-describedby="media-host-note"
          onChange={(event) => setValue("canonicalCdnUrl", event.target.value)}
        />
      </SettingsField>
      <SettingsField id="media-aliases" label={t("imagesAliases")} help={t("imagesAliasesHelp")}>
        <Textarea
          id="media-aliases"
          rows={3}
          value={values.aliases}
          aria-describedby="media-aliases-note"
          onChange={(event) => setValue("aliases", event.target.value)}
        />
      </SettingsField>
    </>
  );
}

export function ImageDeliveryCard() {
  const t = useMessages(advancedSettingsMessages);
  const canEdit = useCanEdit();
  const { data, isError, refetch } = useQuery(mediaQuery);
  if (isError) return <SettingsLoadFailure title={t("imagesLoad")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;
  return (
    <SettingsCard id="imageDelivery"
      title={t("imagesTitle")}
      rows={
        <SettingsDialog
          title={t("imagesTitle")}
          trigger={<SettingsRow label={t("imagesRow")} value={data.canonicalCdnUrl || t("imagesDefault")} disabled={!canEdit} />}
        >
          <ImageDeliveryFields />
        </SettingsDialog>
      }
    />
  );
}

// ── Sign-in and access (platform document) ──────────────────────────────

/** The platform PUT is a partial update: each form sends only its fields. */
function usePlatformForm(pick: (draft: Platform) => Partial<Platform>, isValid?: (draft: Platform) => boolean) {
  const common = useMessages(settingsMessages);
  return useSettingsForm<Platform, Platform>({
    queryKey: platformQuery.queryKey,
    fetchFn: platformQuery.queryFn,
    saveFn: (draft, expectedRevision) =>
      apiData(putApiV1AdminSettingsPlatform({ body: { ...pick(draft), expectedRevision } })),
    resolveSavedValues: (payload) => payload,
    defaultValues: {} as Platform,
    errorMessage: common("saveFailed"),
    canEdit: useCanEdit(),
    isValid,
  });
}

type HandoffError = "ssoValueRequired" | "ssoValueInvalid" | "ssoUrlInvalid";

function handoffErrors(handoff: Handoff): Partial<Record<keyof Handoff, HandoffError>> {
  const errors: Partial<Record<keyof Handoff, HandoffError>> = {};
  for (const key of ["issuer", "audience"] as const) {
    const value = handoff[key].trim();
    if (!value && handoff.enabled) errors[key] = "ssoValueRequired";
    else if (value && !normalizeIdentityHandoffConfig({ enabled: true, issuer: value, audience: value }).issuer) {
      errors[key] = "ssoValueInvalid";
    }
  }
  if (handoff.jwksUrl.trim() && !normalizeJwksUrl(handoff.jwksUrl.trim())) errors.jwksUrl = "ssoUrlInvalid";
  return errors;
}

function SingleSignOnFields() {
  const t = useMessages(advancedSettingsMessages);
  const { values, setValues } = usePlatformForm(
    (draft) => ({
      identityHandoff: {
        ...draft.identityHandoff,
        issuer: draft.identityHandoff.issuer.trim(),
        audience: draft.identityHandoff.audience.trim(),
        jwksUrl: draft.identityHandoff.jwksUrl.trim(),
        localLoginDisabled: draft.identityHandoff.enabled && draft.identityHandoff.localLoginDisabled,
      },
    }),
    (draft) => Object.keys(handoffErrors(draft.identityHandoff)).length === 0,
  );
  const handoff = values.identityHandoff;
  if (!handoff) return null;
  const errors = handoffErrors(handoff);
  const set = <K extends keyof Handoff>(key: K, value: Handoff[K]) =>
    setValues((draft) => ({ ...draft, identityHandoff: { ...draft.identityHandoff, [key]: value } }));
  return (
    <>
      <label className="flex min-h-11 items-center justify-between gap-4 text-body font-medium">
        {t("ssoEnabled")}
        <Switch checked={handoff.enabled} onCheckedChange={(enabled) => set("enabled", enabled)} />
      </label>
      {(["issuer", "audience", "jwksUrl"] as const).map((key) => {
        const label = key === "issuer" ? t("ssoIssuer") : key === "audience" ? t("ssoAudience") : t("ssoKeysUrl");
        const error = errors[key];
        return (
          <SettingsField
            key={key}
            id={`sso-${key}`}
            label={label}
            help={key === "jwksUrl" ? t("ssoKeysUrlHelp") : undefined}
            error={error ? t(error) : null}
          >
            <Input
              id={`sso-${key}`}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={handoff[key]}
              aria-invalid={Boolean(error)}
              aria-describedby={`sso-${key}-note`}
              onChange={(event) => set(key, event.target.value)}
            />
          </SettingsField>
        );
      })}
      <label className="flex min-h-11 items-center justify-between gap-4 text-body">
        <span>
          <span className="block font-medium">{t("ssoPasswordOff")}</span>
          <span className="block text-muted-foreground">{t("ssoPasswordOffHelp")}</span>
        </span>
        <Switch
          checked={handoff.enabled && handoff.localLoginDisabled}
          disabled={!handoff.enabled}
          onCheckedChange={(value) => set("localLoginDisabled", value)}
        />
      </label>
    </>
  );
}

function ConnectedSitesFields() {
  const t = useMessages(advancedSettingsMessages);
  const cookieError = (value: string) => Boolean(value.trim()) && !normalizeCookieDomain(value.trim());
  const { values, setValue } = usePlatformForm(
    (draft) => ({
      customerAuthCookieDomain: draft.customerAuthCookieDomain.trim(),
      corsAllowedOrigins: draft.corsAllowedOrigins,
    }),
    (draft) => !cookieError(draft.customerAuthCookieDomain),
  );
  if (values.corsAllowedOrigins === undefined) return null;
  const invalidCookie = cookieError(values.customerAuthCookieDomain);
  return (
    <>
      <p className="text-body text-muted-foreground">{t("connectedDescription")}</p>
      <SettingsField
        id="cookie-domain"
        label={t("cookieDomain")}
        help={t("cookieDomainHelp")}
        error={invalidCookie ? t("cookieDomainInvalid") : null}
      >
        <Input
          id="cookie-domain"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={values.customerAuthCookieDomain}
          aria-invalid={invalidCookie}
          aria-describedby="cookie-domain-note"
          onChange={(event) => setValue("customerAuthCookieDomain", event.target.value)}
        />
      </SettingsField>
      <OriginList
        id="cors-origin"
        label={t("corsLabel")}
        origins={values.corsAllowedOrigins}
        max={PLATFORM_CORS_ORIGINS_MAX_COUNT}
        normalize={(raw) => ({ value: normalizePlatformOriginUrl(raw.trim()) })}
        onChange={(origins) => setValue("corsAllowedOrigins", origins)}
      />
    </>
  );
}

function SetupTokenSwitch() {
  const t = useMessages(advancedSettingsMessages);
  const canEdit = useCanEdit();
  // Inline switch: the page save bar saves it.
  const { values, setValue } = usePlatformForm((draft) => ({ setupTokenRequired: draft.setupTokenRequired }));
  return (
    <label className="flex min-h-14 items-center justify-between gap-4 border-t border-border px-4 py-3 text-body">
      <span>
        <span className="block font-medium">{t("setupTokenLabel")}</span>
        <span className="block text-muted-foreground">{t("setupTokenHelp")}</span>
      </span>
      <Switch
        checked={Boolean(values.setupTokenRequired)}
        disabled={!canEdit}
        onCheckedChange={(value) => setValue("setupTokenRequired", value)}
      />
    </label>
  );
}

export function SignInAccessCard() {
  const t = useMessages(advancedSettingsMessages);
  const canEdit = useCanEdit();
  const { data, isError, refetch } = useQuery(platformQuery);
  if (isError) return <SettingsLoadFailure title={t("platformLoad")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;
  const connected = data.corsAllowedOrigins.length + (data.customerAuthCookieDomain ? 1 : 0);
  return (
    <SettingsCard id="signInAccess"
      title={t("signInTitle")}
      rows={
        <>
          <SettingsDialog
            title={t("ssoRow")}
            description={t("ssoDescription")}
            trigger={
              <SettingsRow
                label={t("ssoRow")}
                value={data.identityHandoff.enabled ? t("ssoOn") : t("ssoOff")}
                disabled={!canEdit}
              />
            }
          >
            <SingleSignOnFields />
          </SettingsDialog>
          <SettingsDialog
            title={t("connectedRow")}
            trigger={
              <SettingsRow
                label={t("connectedRow")}
                value={connected ? t("connectedCount", { count: connected }) : t("connectedNone")}
                disabled={!canEdit}
              />
            }
          >
            <ConnectedSitesFields />
          </SettingsDialog>
          <SetupTokenSwitch />
        </>
      }
    />
  );
}

// ── Refresh store ───────────────────────────────────────────────────────

export function RefreshStoreCard() {
  const t = useMessages(advancedSettingsMessages);
  const common = useMessages(settingsMessages);
  const canRefresh = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_CACHE_MANAGE);
  const [confirming, setConfirming] = useState(false);
  const refresh = useMutation({
    mutationFn: () => apiData(postApiV1CacheClear()),
    onSuccess: () => {
      setConfirming(false);
      toast.success(t("refreshed"));
    },
    onError: () => toast.error(t("refreshFailed")),
  });
  return (
    <>
      <SettingsCard id="refreshStore"
        title={t("refreshTitle")}
        description={t("refreshDescription")}
        action={
          canRefresh ? (
            <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
              {t("refreshButton")}
            </Button>
          ) : null
        }
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("refreshConfirmTitle")}
        description={t("refreshConfirmBody")}
        confirmLabel={t("refreshConfirm")}
        cancelLabel={common("cancel")}
        loadingLabel={t("refreshing")}
        variant="default"
        isLoading={refresh.isPending}
        onConfirm={() => refresh.mutate()}
      />
    </>
  );
}
