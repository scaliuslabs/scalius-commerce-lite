import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  LockKeyhole,
  Plus,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  normalizeMerchantCspSource,
  parseMerchantCspSources,
  serializeMerchantCspSources,
} from "@scalius/shared/security-csp";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  getSecuritySettings,
  updateSecuritySettings,
} from "@/lib/api-functions/settings";
import {
  getInheritedSecuritySources,
  type InheritedSecuritySourceKind,
} from "@/lib/api-functions/security-runtime";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { queryKeys } from "@/lib/query-keys";
import { SettingsLoadFailure } from "./settings/SettingsLoadFailure";

interface SecurityValues {
  cspAllowedDomains: string;
}

const SOURCE_KIND_LABELS: Record<InheritedSecuritySourceKind, string> = {
  storefront: "Storefront",
  api: "Connect",
  dashboard: "Admin",
  media: "Media",
};

const fetchSecurity = async (): Promise<SecurityValues> => {
  const data = (await getSecuritySettings()) as Record<string, unknown>;
  return {
    cspAllowedDomains: (data.cspAllowedDomains as string) || "",
  };
};

const saveSecurity = async (values: SecurityValues) => {
  await updateSecuritySettings({
    data: {
      cspAllowedDomains: serializeMerchantCspSources(
        parseMerchantCspSources(values.cspAllowedDomains),
      ),
    },
  });
};

export function SecuritySettingsBuilder() {
  const [sourceDraft, setSourceDraft] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const inheritedQuery = useQuery({
    queryKey: ["settings", "security", "inherited-sources"],
    queryFn: () => getInheritedSecuritySources(),
    staleTime: 1000 * 60 * 10,
  });
  const {
    values,
    setValue,
    isLoading,
    isLoaded,
    isLoadError,
    loadError,
    isSaving,
    handleSubmit,
    refetch,
  } = useSettingsForm<SecurityValues>({
    queryKey: queryKeys.settings.security(),
    fetchFn: fetchSecurity,
    saveFn: saveSecurity,
    defaultValues: { cspAllowedDomains: "" },
    successMessage: "Storefront security policy saved.",
    errorMessage: "Failed to save the storefront security policy.",
  });

  const merchantSources = useMemo(
    () => parseMerchantCspSources(values.cspAllowedDomains),
    [values.cspAllowedDomains],
  );

  function addMerchantSource() {
    const result = normalizeMerchantCspSource(sourceDraft);
    if (!result.value) {
      setSourceError(result.error);
      return;
    }

    setValue(
      "cspAllowedDomains",
      serializeMerchantCspSources([...merchantSources, result.value]),
    );
    setSourceDraft("");
    setSourceError(null);
  }

  function removeMerchantSource(source: string) {
    setValue(
      "cspAllowedDomains",
      serializeMerchantCspSources(
        merchantSources.filter((current) => current !== source),
      ),
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isLoadError) {
    return (
      <SettingsLoadFailure
        title="Security policy unavailable"
        error={loadError}
        fallback="The current storefront content-security policy could not be loaded."
        onRetry={refetch}
      />
    );
  }

  return (
    <div className="max-w-4xl space-y-5">
      <section className="overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">Inherited platform trust</h3>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Scalius reads these origins from the deployed platform
              configuration. They stay trusted without being copied into
              merchant-managed text.
            </p>
          </div>
        </div>

        {inheritedQuery.isError ? (
          <div className="flex items-start gap-2 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Platform origins could not be inspected. Existing runtime trust
              remains unchanged; reload before diagnosing an integration
              failure.
            </p>
          </div>
        ) : inheritedQuery.isLoading ? (
          <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Reading deployed origins…
          </div>
        ) : (
          <div className="divide-y divide-border">
            {inheritedQuery.data?.map((source) => (
              <div
                key={source.key}
                className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Server className="h-3.5 w-3.5 text-muted-foreground" />
                  {source.label}
                </div>
                <div className="min-w-0">
                  {source.source ? (
                    <code className="block truncate text-xs text-foreground">
                      {source.source}
                    </code>
                  ) : (
                    <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
                      Not configured or invalid
                    </span>
                  )}
                  <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                    {source.consequence}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className={
                    source.source
                      ? "w-fit border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
                      : "w-fit border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
                  }
                >
                  {source.source ? (
                    <CheckCircle2 className="mr-1 h-3 w-3" />
                  ) : (
                    <AlertTriangle className="mr-1 h-3 w-3" />
                  )}
                  {SOURCE_KIND_LABELS[source.kind]}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-background p-4">
        <div className="flex items-start gap-3">
          <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">
              Additional storefront services
            </h3>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Add only a host required by a payment, analytics, chat, or
              embedded service. Wildcards are explicit and are never added
              automatically.
            </p>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <Label htmlFor="csp-source-draft">Trusted host</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="csp-source-draft"
              value={sourceDraft}
              onChange={(event) => {
                setSourceDraft(event.target.value);
                if (sourceError) setSourceError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addMerchantSource();
                }
              }}
              placeholder="https://payments.example.com"
              aria-invalid={Boolean(sourceError)}
              aria-describedby="csp-source-help"
              className="min-w-0 flex-1"
            />
            <Button
              type="button"
              variant="outline"
              onClick={addMerchantSource}
              disabled={!sourceDraft.trim()}
              className="shrink-0"
            >
              <Plus className="mr-2 h-4 w-4" />
              Add host
            </Button>
          </div>
          <p
            id="csp-source-help"
            className={`text-xs leading-5 ${sourceError ? "text-destructive" : "text-muted-foreground"}`}
          >
            {sourceError ??
              "Use an exact HTTPS origin. Enter https://*.example.com only when every subdomain is required."}
          </p>
        </div>

        <div className="mt-4 rounded-md border border-border">
          {merchantSources.length > 0 ? (
            <div className="divide-y divide-border">
              {merchantSources.map((source) => (
                <div
                  key={source}
                  className="flex min-w-0 items-center justify-between gap-3 px-3 py-2"
                >
                  <code className="min-w-0 truncate text-xs">{source}</code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => removeMerchantSource(source)}
                    aria-label={`Remove ${source}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="px-3 py-4 text-xs leading-5 text-muted-foreground">
              No merchant-added hosts. Platform origins and first-class
              integration defaults still apply.
            </p>
          )}
        </div>

        <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
          Additional hosts currently apply to storefront scripts, connections,
          frames, images, and workers. Treat each addition as a security
          decision.
        </p>
      </section>

      <div className="flex justify-end border-t border-border pt-4">
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={isSaving || !isLoaded}
          className="min-w-[150px]"
        >
          {isSaving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : (
            "Save security policy"
          )}
        </Button>
      </div>
    </div>
  );
}
