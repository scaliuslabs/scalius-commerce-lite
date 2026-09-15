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
  PLATFORM_CORS_ORIGINS_MAX_COUNT,
  normalizeCookieDomain,
  normalizeMediaBaseUrl,
  normalizePlatformOriginUrl,
} from "@scalius/shared/platform-config";

import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { getServerFnError } from "~/lib/api-helpers";
import {
  getPlatformSettings,
  updatePlatformSettings,
  type PlatformSettingsPayload,
  type PlatformUrlKey,
  type UpdatePlatformSettingsInput,
} from "~/lib/api-functions/platform";
import { queryKeys } from "~/lib/query-keys";
import { SettingsLoadFailure } from "./SettingsLoadFailure";

export interface PlatformDraft {
  storefrontUrl: string;
  apiUrl: string;
  dashboardUrl: string;
  mediaUrl: string;
  customerAuthCookieDomain: string;
  corsAllowedOrigins: string[];
}

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
    help: "Public store origin. Required for links, discovery XML, purge callbacks, and checkout returns.",
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
    help: "Admin origin used for sign-in links, password reset emails, and trusted origins.",
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
const MEDIA_ERROR =
  "Use an HTTPS base URL without credentials, query, or fragment. HTTP is limited to localhost.";
const COOKIE_DOMAIN_ERROR = "Use a bare hostname such as example.com.";

export function toPlatformDraft(payload: PlatformSettingsPayload): PlatformDraft {
  return {
    storefrontUrl: payload.storefrontUrl,
    apiUrl: payload.apiUrl,
    dashboardUrl: payload.dashboardUrl,
    mediaUrl: payload.mediaUrl,
    customerAuthCookieDomain: payload.customerAuthCookieDomain,
    corsAllowedOrigins: [...payload.corsAllowedOrigins],
  };
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
  return patch;
}

export function validatePlatformDraft(
  draft: PlatformDraft,
): Partial<Record<keyof PlatformDraft, string>> {
  const errors: Partial<Record<keyof PlatformDraft, string>> = {};
  if (!draft.storefrontUrl.trim()) {
    errors.storefrontUrl = "Enter the public store origin. It cannot be cleared.";
  } else if (!normalizePlatformOriginUrl(draft.storefrontUrl.trim())) {
    errors.storefrontUrl = ORIGIN_ERROR;
  }
  for (const key of ["apiUrl", "dashboardUrl"] as const) {
    const value = draft[key].trim();
    if (value && !normalizePlatformOriginUrl(value)) errors[key] = ORIGIN_ERROR;
  }
  const mediaUrl = draft.mediaUrl.trim();
  if (mediaUrl && !normalizeMediaBaseUrl(mediaUrl)) errors.mediaUrl = MEDIA_ERROR;
  const cookieDomain = draft.customerAuthCookieDomain.trim();
  if (cookieDomain && !normalizeCookieDomain(cookieDomain)) {
    errors.customerAuthCookieDomain = COOKIE_DOMAIN_ERROR;
  }
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
    queryFn: getPlatformSettings,
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
    mutationFn: (patch: UpdatePlatformSettingsInput) => updatePlatformSettings({ data: patch }),
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

  const { readiness, effective } = platformQuery.data;

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
