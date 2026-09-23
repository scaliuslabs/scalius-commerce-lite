import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Globe,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  IDENTITY_HANDOFF_CLAIM_MAX_LENGTH,
  PLATFORM_CORS_ORIGINS_MAX_COUNT,
  normalizeCookieDomain,
  normalizeDashboardUrl,
  normalizeIdentityHandoffConfig,
  normalizeJwksUrl,
  normalizeMediaBaseUrl,
  normalizePlatformOriginUrl,
  type IdentityHandoffConfig,
} from "@scalius/shared/platform-config";

import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { getServerFnError } from "~/lib/api-helpers";
import {
  getApiV1AdminSettingsPlatform,
  putApiV1AdminSettingsPlatform,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiResult } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { SettingsLoadFailure } from "./SettingsLoadFailure";

type PlatformSettingsPayload = ApiResult<typeof getApiV1AdminSettingsPlatform>;
type PlatformUrlKey = PlatformSettingsPayload["readiness"]["missing"][number];
type UpdatePlatformSettingsInput = ApiBody<typeof putApiV1AdminSettingsPlatform>;

export interface PlatformDraft {
  storefrontUrl: string;
  apiUrl: string;
  dashboardUrl: string;
  mediaUrl: string;
  customerAuthCookieDomain: string;
  corsAllowedOrigins: string[];
  setupTokenRequired: boolean;
  identityHandoff: IdentityHandoffConfig;
}

export type PlatformDraftErrors = Partial<
  Record<Exclude<keyof PlatformDraft, "identityHandoff">, string>
> & { identityHandoff?: Partial<Record<keyof IdentityHandoffConfig, string>> };

interface PlatformUrlField {
  key: PlatformUrlKey;
  label: string;
  placeholder: string;
  help: string;
}

export const PLATFORM_URL_FIELDS: readonly PlatformUrlField[] = [
  {
    key: "storefrontUrl",
    label: "Storefront URL",
    placeholder: "https://shop.example.com",
    help: "Public store origin. Required for links, discovery XML, and checkout returns.",
  },
  {
    key: "apiUrl",
    label: "API URL",
    placeholder: "https://api.example.com",
    help: "Origin browsers call for public API requests, agent authorization, and hosted payment callbacks.",
  },
  {
    key: "dashboardUrl",
    label: "Dashboard URL",
    placeholder: "https://dashboard.example.com",
    help: "Admin URL used for sign-in links, password reset emails, and trusted origins. A lowercase path prefix such as https://shop.example.com/dashboard serves the dashboard below that path.",
  },
  {
    key: "mediaUrl",
    label: "Media URL",
    placeholder: "https://cdn.example.com",
    help: "Public media base (R2 custom domain). Feeds, storefront images, and CSP trust use this host.",
  },
] as const;

const URL_LABELS: Record<PlatformUrlKey, string> = Object.fromEntries(
  PLATFORM_URL_FIELDS.map((field) => [field.key, field.label]),
) as Record<PlatformUrlKey, string>;

const ORIGIN_ERROR =
  "Use an HTTPS origin without credentials, path, query, or fragment. HTTP is limited to localhost.";
const DASHBOARD_URL_ERROR =
  "Use an HTTPS origin, optionally followed by a lowercase path prefix such as /dashboard, without credentials, query, or fragment. HTTP is limited to localhost.";
const MEDIA_ERROR =
  "Use an HTTPS base URL without credentials, query, or fragment. HTTP is limited to localhost.";
const COOKIE_DOMAIN_ERROR = "Use a bare hostname such as example.com.";
const CLAIM_ERROR =
  `Use a single value of at most ${IDENTITY_HANDOFF_CLAIM_MAX_LENGTH} characters without spaces.`;
const JWKS_ERROR =
  "Use an HTTPS URL without credentials or fragment, or leave empty to sign tokens with the derived secret.";

export function toPlatformDraft(payload: PlatformSettingsPayload): PlatformDraft {
  return {
    storefrontUrl: payload.storefrontUrl,
    apiUrl: payload.apiUrl,
    dashboardUrl: payload.dashboardUrl,
    mediaUrl: payload.mediaUrl,
    customerAuthCookieDomain: payload.customerAuthCookieDomain,
    corsAllowedOrigins: [...payload.corsAllowedOrigins],
    setupTokenRequired: payload.setupTokenRequired,
    identityHandoff: { ...payload.identityHandoff },
  };
}

function sameHandoff(left: IdentityHandoffConfig, right: IdentityHandoffConfig): boolean {
  return (
    left.enabled === right.enabled
    && left.issuer.trim() === right.issuer
    && left.audience.trim() === right.audience
    && left.jwksUrl.trim() === right.jwksUrl
    && left.localLoginDisabled === right.localLoginDisabled
  );
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** Only fields that changed are sent, so the PUT stays a partial update. */
export function buildPlatformPatch(
  draft: PlatformDraft,
  saved: PlatformDraft,
): UpdatePlatformSettingsInput {
  const patch: UpdatePlatformSettingsInput = {};
  for (const field of PLATFORM_URL_FIELDS) {
    if (draft[field.key].trim() !== saved[field.key]) {
      patch[field.key] = draft[field.key].trim();
    }
  }
  if (draft.customerAuthCookieDomain.trim() !== saved.customerAuthCookieDomain) {
    patch.customerAuthCookieDomain = draft.customerAuthCookieDomain.trim();
  }
  if (!sameList(draft.corsAllowedOrigins, saved.corsAllowedOrigins)) {
    patch.corsAllowedOrigins = [...draft.corsAllowedOrigins];
  }
  if (draft.setupTokenRequired !== saved.setupTokenRequired) {
    patch.setupTokenRequired = draft.setupTokenRequired;
  }
  if (!sameHandoff(draft.identityHandoff, saved.identityHandoff)) {
    // The whole block travels together so the server validates one consistent state.
    patch.identityHandoff = {
      enabled: draft.identityHandoff.enabled,
      issuer: draft.identityHandoff.issuer.trim(),
      audience: draft.identityHandoff.audience.trim(),
      jwksUrl: draft.identityHandoff.jwksUrl.trim(),
      localLoginDisabled: draft.identityHandoff.localLoginDisabled,
    };
  }
  return patch;
}

function validateClaim(value: string): boolean {
  return normalizeIdentityHandoffConfig({ enabled: true, issuer: value, audience: value }).issuer !== "";
}

export function validatePlatformDraft(draft: PlatformDraft): PlatformDraftErrors {
  const errors: PlatformDraftErrors = {};
  if (!draft.storefrontUrl.trim()) {
    errors.storefrontUrl = "Enter the public store origin. It cannot be cleared.";
  } else if (!normalizePlatformOriginUrl(draft.storefrontUrl.trim())) {
    errors.storefrontUrl = ORIGIN_ERROR;
  }
  const apiUrl = draft.apiUrl.trim();
  if (apiUrl && !normalizePlatformOriginUrl(apiUrl)) errors.apiUrl = ORIGIN_ERROR;
  const dashboardUrl = draft.dashboardUrl.trim();
  if (dashboardUrl && !normalizeDashboardUrl(dashboardUrl)) errors.dashboardUrl = DASHBOARD_URL_ERROR;
  const mediaUrl = draft.mediaUrl.trim();
  if (mediaUrl && !normalizeMediaBaseUrl(mediaUrl)) errors.mediaUrl = MEDIA_ERROR;
  const cookieDomain = draft.customerAuthCookieDomain.trim();
  if (cookieDomain && !normalizeCookieDomain(cookieDomain)) {
    errors.customerAuthCookieDomain = COOKIE_DOMAIN_ERROR;
  }

  const handoff = draft.identityHandoff;
  const handoffErrors: NonNullable<PlatformDraftErrors["identityHandoff"]> = {};
  const issuer = handoff.issuer.trim();
  const audience = handoff.audience.trim();
  const jwksUrl = handoff.jwksUrl.trim();
  if (issuer && !validateClaim(issuer)) handoffErrors.issuer = CLAIM_ERROR;
  if (audience && !validateClaim(audience)) handoffErrors.audience = CLAIM_ERROR;
  if (jwksUrl && !normalizeJwksUrl(jwksUrl)) handoffErrors.jwksUrl = JWKS_ERROR;
  if (handoff.enabled) {
    if (!issuer) handoffErrors.issuer = "Enter the issuer before enabling identity handoff.";
    if (!audience) handoffErrors.audience = "Enter the audience before enabling identity handoff.";
  }
  if (handoff.localLoginDisabled && !handoff.enabled) {
    handoffErrors.localLoginDisabled = "Password sign-in can only be disabled while identity handoff is enabled.";
  }
  if (Object.keys(handoffErrors).length > 0) errors.identityHandoff = handoffErrors;
  return errors;
}

export function describeMissingPlatformOrigins(missing: readonly PlatformUrlKey[]): string {
  return missing.map((key) => URL_LABELS[key]).join(", ");
}

export function PlatformSettingsBuilder() {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const queryClient = useQueryClient();
  const platformQuery = useQuery({
    queryKey: queryKeys.settings.platform(),
    queryFn: () => apiData(getApiV1AdminSettingsPlatform()),
  });
  const [draft, setDraft] = useState<PlatformDraft | null>(null);
  const [saved, setSaved] = useState<PlatformDraft | null>(null);
  const [corsDraft, setCorsDraft] = useState("");
  const [corsError, setCorsError] = useState<string | null>(null);

  const dirty = Boolean(
    draft && saved && JSON.stringify(draft) !== JSON.stringify(saved),
  );
  const hasPendingInput = corsDraft.trim().length > 0;

  useEffect(() => {
    if (!platformQuery.data || dirty || hasPendingInput) return;
    const next = toPlatformDraft(platformQuery.data);
    setDraft(next);
    setSaved(next);
  }, [dirty, hasPendingInput, platformQuery.data]);

  const errors = useMemo(() => (draft ? validatePlatformDraft(draft) : {}), [draft]);
  const hasErrors = Object.keys(errors).length > 0;

  const saveMutation = useMutation({
    mutationFn: (patch: UpdatePlatformSettingsInput) =>
      apiData(putApiV1AdminSettingsPlatform({ body: patch })),
    onSuccess: async (payload) => {
      const next = toPlatformDraft(payload);
      setDraft(next);
      setSaved(next);
      setCorsDraft("");
      setCorsError(null);
      queryClient.setQueryData(queryKeys.settings.platform(), payload);
      // The storefront origin is shared with Settings -> Storefront URL, and
      // the Security section shows the inherited origins read-only.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.settings.storefrontUrl() }),
        queryClient.invalidateQueries({ queryKey: ["settings", "security", "inherited-sources"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.settings.seoDiscoveryLiveProbe() }),
      ]);
      toast.success(
        payload.readiness.status === "ready"
          ? "Platform origins saved"
          : `Platform origins saved. Still missing: ${describeMissingPlatformOrigins(payload.readiness.missing)}.`,
      );
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Platform origins could not be saved"));
    },
  });

  const canEdit = canManage && !saveMutation.isPending;

  function setField<K extends keyof PlatformDraft>(key: K, value: PlatformDraft[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  function setHandoffField<K extends keyof IdentityHandoffConfig>(key: K, value: IdentityHandoffConfig[K]) {
    setDraft((current) => (
      current
        ? { ...current, identityHandoff: { ...current.identityHandoff, [key]: value } }
        : current
    ));
  }

  function addCorsOrigin() {
    if (!canEdit || !draft) return;
    const origin = normalizePlatformOriginUrl(corsDraft.trim());
    if (!origin) {
      setCorsError(ORIGIN_ERROR);
      return;
    }
    if (draft.corsAllowedOrigins.includes(origin)) {
      setCorsError("This origin is already listed.");
      return;
    }
    if (draft.corsAllowedOrigins.length >= PLATFORM_CORS_ORIGINS_MAX_COUNT) {
      setCorsError(`At most ${PLATFORM_CORS_ORIGINS_MAX_COUNT} extra origins can be listed.`);
      return;
    }
    setField("corsAllowedOrigins", [...draft.corsAllowedOrigins, origin]);
    setCorsDraft("");
    setCorsError(null);
  }

  if (platformQuery.isError && !draft) {
    return (
      <SettingsLoadFailure
        title="Platform origins unavailable"
        error={platformQuery.error}
        fallback="The current platform origins could not be loaded."
        onRetry={() => void platformQuery.refetch()}
      />
    );
  }

  if (!draft || !saved || !platformQuery.data) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const { readiness, effective, dashboardBasePath } = platformQuery.data;
  const handoffErrors = errors.identityHandoff ?? {};
  const handoffDraft = draft.identityHandoff;

  return (
    <>
      <UnsavedChangesGuard
        isDirty={dirty || hasPendingInput || saveMutation.isPending}
        isSubmitting={false}
        allowSamePathStateNavigation
      />
      <div className="max-w-4xl space-y-5">
        {!canManage ? (
          <Alert>
            <AlertDescription>
              Your role can review the platform origins, but cannot change them.
            </AlertDescription>
          </Alert>
        ) : null}

        {readiness.status === "ready" ? (
          <Alert role="status" data-testid="platform-readiness">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            <AlertTitle>Platform origins configured</AlertTitle>
            <AlertDescription>
              Every Worker resolves these origins at request time. No Wrangler variables are needed.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive" role="alert" data-testid="platform-readiness">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>Platform origins not configured</AlertTitle>
            <AlertDescription>
              Missing: {describeMissingPlatformOrigins(readiness.missing)}. Until every
              origin is saved, sign-in links, discovery XML, media delivery, and payment
              callbacks fall back to the current request origin or stay disabled.
            </AlertDescription>
          </Alert>
        )}

        <section className="rounded-lg border bg-background p-4">
          <div className="flex items-start gap-3">
            <Globe className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">Public origins</h3>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Saved in the database and shared by the API, storefront, and dashboard Workers.
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-4">
            {PLATFORM_URL_FIELDS.map((field) => {
              const value = draft[field.key];
              const error = errors[field.key];
              const effectiveValue = effective[field.key];
              const usesFallback = !saved[field.key] && Boolean(effectiveValue);
              const inputId = `platform-${field.key}`;
              return (
                <div key={field.key} className="space-y-1.5">
                  <Label htmlFor={inputId}>{field.label}</Label>
                  <Input
                    id={inputId}
                    type="url"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={value}
                    disabled={!canEdit}
                    placeholder={field.placeholder}
                    aria-invalid={Boolean(error)}
                    aria-describedby={`${inputId}-help`}
                    className="min-h-11 sm:min-h-9"
                    onChange={(event) => setField(field.key, event.target.value)}
                  />
                  <p
                    id={`${inputId}-help`}
                    className={`text-xs leading-5 ${error ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {error ?? field.help}
                  </p>
                  {usesFallback ? (
                    <p className="text-xs leading-5 text-amber-700 dark:text-amber-300">
                      Not saved. Currently effective: <code>{effectiveValue}</code> (automatic fallback, not a configured value).
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-lg border bg-background p-4">
          <h3 className="text-sm font-semibold">Customer sessions and CORS</h3>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            Optional. The platform origins above are always trusted; list only additional first-party origins.
          </p>

          <div className="mt-4 space-y-1.5">
            <Label htmlFor="platform-customerAuthCookieDomain">Customer cookie domain</Label>
            <Input
              id="platform-customerAuthCookieDomain"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={draft.customerAuthCookieDomain}
              disabled={!canEdit}
              placeholder="example.com"
              aria-invalid={Boolean(errors.customerAuthCookieDomain)}
              aria-describedby="platform-customerAuthCookieDomain-help"
              className="min-h-11 sm:min-h-9"
              onChange={(event) => setField("customerAuthCookieDomain", event.target.value)}
            />
            <p
              id="platform-customerAuthCookieDomain-help"
              className={`text-xs leading-5 ${errors.customerAuthCookieDomain ? "text-destructive" : "text-muted-foreground"}`}
            >
              {errors.customerAuthCookieDomain
                ?? "Cookie Domain attribute for customer sessions shared across subdomains. Leave empty for host-only cookies."}
            </p>
          </div>

          <div className="mt-4 space-y-2">
            <Label htmlFor="platform-cors-draft">Extra CORS origins</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="platform-cors-draft"
                value={corsDraft}
                disabled={!canEdit}
                placeholder="https://app.example.com"
                aria-invalid={Boolean(corsError)}
                aria-describedby="platform-cors-help"
                className="min-h-11 min-w-0 flex-1 sm:min-h-9"
                onChange={(event) => {
                  setCorsDraft(event.target.value);
                  if (corsError) setCorsError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addCorsOrigin();
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                className="min-h-11 shrink-0 sm:min-h-9"
                disabled={!canEdit || !corsDraft.trim()}
                onClick={addCorsOrigin}
              >
                <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                Add origin
              </Button>
            </div>
            <p
              id="platform-cors-help"
              className={`text-xs leading-5 ${corsError ? "text-destructive" : "text-muted-foreground"}`}
            >
              {corsError ?? "Exact HTTPS origins allowed to make credentialed API requests."}
            </p>
            {draft.corsAllowedOrigins.length > 0 ? (
              <div className="divide-y rounded-md border">
                {draft.corsAllowedOrigins.map((origin) => (
                  <div key={origin} className="flex min-w-0 items-center justify-between gap-3 px-3 py-1.5">
                    <code className="min-w-0 truncate text-xs">{origin}</code>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11 shrink-0 sm:h-9 sm:w-9"
                      disabled={!canEdit}
                      onClick={() =>
                        setField(
                          "corsAllowedOrigins",
                          draft.corsAllowedOrigins.filter((item) => item !== origin),
                        )}
                      aria-label={`Remove ${origin}`}
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-md border px-3 py-3 text-xs leading-5 text-muted-foreground">
                No extra origins. The storefront, API, and dashboard origins are trusted automatically.
              </p>
            )}
          </div>
        </section>

        <section className="rounded-lg border bg-background p-4" data-testid="platform-automation">
          <h3 className="text-sm font-semibold">Automated and managed deployments</h3>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            Optional contracts for CI pipelines, one-click installers, and multi-store operators. Everything here is off by default and changes nothing for a self-hosted store.
            {dashboardBasePath ? (
              <> The dashboard is currently served below <code>{dashboardBasePath}</code>.</>
            ) : null}
          </p>

          <div className="mt-4 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <Label htmlFor="platform-setupTokenRequired">Require a setup token for first-admin setup</Label>
              <p className="text-xs leading-5 text-muted-foreground">
                Gates <code>POST /api/v1/setup</code> behind the <code>X-Scalius-Setup-Token</code> header derived from the master secret, so nobody who finds a fresh deployment can become its first administrator.
              </p>
            </div>
            <label htmlFor="platform-setupTokenRequired" className="flex min-h-11 min-w-11 shrink-0 items-center justify-end">
              <Switch
                id="platform-setupTokenRequired"
                checked={draft.setupTokenRequired}
                disabled={!canEdit}
                onCheckedChange={(value) => setField("setupTokenRequired", value)}
              />
            </label>
          </div>

          <div className="mt-5 border-t pt-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Label htmlFor="platform-handoff-enabled">Trusted identity handoff</Label>
                <p className="text-xs leading-5 text-muted-foreground">
                  Lets an operator&apos;s identity provider open this dashboard with a short-lived signed token at <code>/api/auth/handoff</code>. Tokens are HS256-signed with the derived secret unless a JWKS URL is set.
                </p>
              </div>
              <label htmlFor="platform-handoff-enabled" className="flex min-h-11 min-w-11 shrink-0 items-center justify-end">
                <Switch
                  id="platform-handoff-enabled"
                  checked={handoffDraft.enabled}
                  disabled={!canEdit}
                  onCheckedChange={(value) => setHandoffField("enabled", value)}
                />
              </label>
            </div>

            <div className="mt-4 grid gap-4">
              {([
                ["issuer", "Issuer", "https://idp.example.com", "Expected iss claim of handoff tokens."],
                ["audience", "Audience", "scalius:store-1", "Expected aud claim of handoff tokens."],
                ["jwksUrl", "JWKS URL", "https://idp.example.com/.well-known/jwks.json", "Optional. Verifies RS256/ES256 tokens; leave empty to use the derived HS256 secret."],
              ] as const).map(([key, label, placeholder, help]) => {
                const inputId = `platform-handoff-${key}`;
                const error = handoffErrors[key];
                return (
                  <div key={key} className="space-y-1.5">
                    <Label htmlFor={inputId}>{label}</Label>
                    <Input
                      id={inputId}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      value={handoffDraft[key]}
                      disabled={!canEdit}
                      placeholder={placeholder}
                      aria-invalid={Boolean(error)}
                      aria-describedby={`${inputId}-help`}
                      className="min-h-11 sm:min-h-9"
                      onChange={(event) => setHandoffField(key, event.target.value)}
                    />
                    <p
                      id={`${inputId}-help`}
                      className={`text-xs leading-5 ${error ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {error ?? help}
                    </p>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Label htmlFor="platform-handoff-localLoginDisabled">Disable password sign-in</Label>
                <p
                  className={`text-xs leading-5 ${handoffErrors.localLoginDisabled ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {handoffErrors.localLoginDisabled
                    ?? "Hides and refuses the password form while the identity provider owns sign-in. Only available while identity handoff is enabled."}
                </p>
              </div>
              <label htmlFor="platform-handoff-localLoginDisabled" className="flex min-h-11 min-w-11 shrink-0 items-center justify-end">
                <Switch
                  id="platform-handoff-localLoginDisabled"
                  checked={handoffDraft.localLoginDisabled}
                  disabled={!canEdit || !handoffDraft.enabled}
                  onCheckedChange={(value) => setHandoffField("localLoginDisabled", value)}
                />
              </label>
            </div>
          </div>
        </section>

        {dirty || hasPendingInput ? (
          <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 sm:min-h-9"
              disabled={!canEdit}
              onClick={() => {
                setDraft(saved);
                setCorsDraft("");
                setCorsError(null);
              }}
            >
              <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
              Reset
            </Button>
            <Button
              type="button"
              className="min-h-11 sm:min-h-9 sm:min-w-36"
              disabled={!canEdit || !dirty || hasErrors}
              onClick={() => saveMutation.mutate(buildPlatformPatch(draft, saved))}
            >
              {saveMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Save className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              Save platform
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}

export default PlatformSettingsBuilder;
