import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  LockKeyhole,
  Plus,
  RotateCcw,
  Save,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  normalizeMerchantCspSource,
  parseMerchantCspSources,
  serializeMerchantCspSources,
} from "@scalius/shared/security-csp";

import { UnsavedChangesGuard } from "@/components/admin/shared/UnsavedChangesGuard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePermissions } from "@/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "@/lib/admin-permissions";
import { getServerFnError } from "@/lib/api-helpers";
import {
  getSecuritySettings,
  updateSecuritySettings,
} from "@/lib/api-functions/settings";
import {
  getInheritedSecuritySources,
  type InheritedSecuritySourceKind,
} from "@/lib/api-functions/security-runtime";
import { queryKeys } from "@/lib/query-keys";
import { SettingsLoadFailure } from "./settings/SettingsLoadFailure";

const SOURCE_KIND_LABELS: Record<InheritedSecuritySourceKind, string> = {
  storefront: "Storefront",
  api: "Connect",
  dashboard: "Admin",
  media: "Media",
};

function sourcesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((source, index) => source === right[index]);
}

function visibleMerchantSources(
  value: unknown,
  inheritedSources: readonly (string | null | undefined)[],
): string[] {
  const inherited = new Set(inheritedSources.filter((source): source is string => Boolean(source)));
  return parseMerchantCspSources(value).filter((source) => !inherited.has(source));
}

export function SecuritySettingsBuilder() {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const queryClient = useQueryClient();
  const securityQuery = useQuery({
    queryKey: queryKeys.settings.security(),
    queryFn: getSecuritySettings,
  });
  const inheritedQuery = useQuery({
    queryKey: ["settings", "security", "inherited-sources"],
    queryFn: getInheritedSecuritySources,
    staleTime: 1000 * 60 * 10,
  });
  const [merchantSources, setMerchantSources] = useState<string[] | null>(null);
  const [savedMerchantSources, setSavedMerchantSources] = useState<string[] | null>(null);
  const [sourceDraft, setSourceDraft] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const dirty = Boolean(
    merchantSources
    && savedMerchantSources
    && !sourcesEqual(merchantSources, savedMerchantSources),
  );
  const hasPendingInput = sourceDraft.trim().length > 0;

  const inheritedOrigins = useMemo(
    () => inheritedQuery.data?.map((source) => source.source) ?? [],
    [inheritedQuery.data],
  );

  useEffect(() => {
    if (!securityQuery.data || dirty || hasPendingInput) return;
    const nextSources = visibleMerchantSources(
      securityQuery.data.cspAllowedDomains,
      inheritedOrigins,
    );
    setMerchantSources(nextSources);
    setSavedMerchantSources(nextSources);
  }, [dirty, hasPendingInput, inheritedOrigins, securityQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (nextSources: string[]) => updateSecuritySettings({
      data: { cspAllowedDomains: serializeMerchantCspSources(nextSources) },
    }),
    onSuccess: (_response, saved) => {
      const serialized = serializeMerchantCspSources(saved);
      setMerchantSources(saved);
      setSavedMerchantSources(saved);
      setSourceDraft("");
      setSourceError(null);
      queryClient.setQueryData(queryKeys.settings.security(), {
        cspAllowedDomains: serialized,
      });
      toast.success("Storefront security policy saved");
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Storefront security policy could not be saved"));
    },
  });

  const canEdit = canManage && !saveMutation.isPending;

  function addMerchantSource() {
    if (!canEdit || !merchantSources) return;
    const result = normalizeMerchantCspSource(sourceDraft);
    if (!result.value) {
      setSourceError(result.error);
      return;
    }
    if (inheritedOrigins.includes(result.value)) {
      setSourceError("This origin is already trusted by the platform.");
      return;
    }
    if (merchantSources.includes(result.value)) {
      setSourceError("This origin is already in the policy.");
      return;
    }
    setMerchantSources([...merchantSources, result.value]);
    setSourceDraft("");
    setSourceError(null);
  }

  if (securityQuery.isLoading || !merchantSources || !savedMerchantSources) {
    if (securityQuery.isError) {
      return (
        <SettingsLoadFailure
          title="Security policy unavailable"
          error={securityQuery.error}
          fallback="The current storefront content-security policy could not be loaded."
          onRetry={() => void securityQuery.refetch()}
        />
      );
    }
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <UnsavedChangesGuard
        isDirty={dirty || hasPendingInput}
        isSubmitting={saveMutation.isPending}
      />
      <div className="max-w-4xl space-y-5 pb-24">
        {!canManage && (
          <Alert>
            <AlertDescription>
              Your role can review the storefront security policy, but cannot change it.
            </AlertDescription>
          </Alert>
        )}

        <section className="overflow-hidden rounded-lg border bg-background">
          <div className="flex items-start gap-3 border-b px-4 py-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">Inherited platform trust</h3>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Read-only origins from the deployed platform. They do not belong in merchant additions.
              </p>
            </div>
          </div>

          {inheritedQuery.isError ? (
            <div className="flex flex-col gap-3 px-4 py-3 text-xs text-amber-700 dark:text-amber-300 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>Platform origins could not be inspected. Runtime trust is unchanged.</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-11 sm:min-h-9"
                onClick={() => void inheritedQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : inheritedQuery.isLoading ? (
            <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading deployed origins…
            </div>
          ) : (
            <div className="divide-y">
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
                      <code className="block truncate text-xs">{source.source}</code>
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
                    className={source.source
                      ? "w-fit border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
                      : "w-fit border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"}
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

        <section className="rounded-lg border bg-background p-4">
          <div className="flex items-start gap-3">
            <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">Additional storefront services</h3>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Add an exact origin required by a payment, analytics, chat, or embedded service.
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-2">
            <Label htmlFor="csp-source-draft">Trusted origin</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="csp-source-draft"
                value={sourceDraft}
                disabled={!canEdit}
                placeholder="https://payments.example.com"
                aria-invalid={Boolean(sourceError)}
                aria-describedby="csp-source-help"
                className="min-h-11 min-w-0 flex-1 sm:min-h-9"
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
              />
              <Button
                type="button"
                variant="outline"
                className="min-h-11 shrink-0 sm:min-h-9"
                disabled={!canEdit || !sourceDraft.trim()}
                onClick={addMerchantSource}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add origin
              </Button>
            </div>
            <p
              id="csp-source-help"
              className={`text-xs leading-5 ${sourceError ? "text-destructive" : "text-muted-foreground"}`}
            >
              {sourceError ?? "Exact HTTPS origins stay exact. Use https://*.example.com only when every subdomain is required."}
            </p>
          </div>

          <div className="mt-4 rounded-md border">
            {merchantSources.length > 0 ? (
              <div className="divide-y">
                {merchantSources.map((source) => (
                  <div key={source} className="flex min-w-0 items-center justify-between gap-3 px-3 py-1.5">
                    <code className="min-w-0 truncate text-xs">{source}</code>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11 shrink-0 sm:h-9 sm:w-9"
                      disabled={!canEdit}
                      onClick={() => setMerchantSources((current) => current?.filter((item) => item !== source) ?? [])}
                      aria-label={`Remove ${source}`}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="px-3 py-4 text-xs leading-5 text-muted-foreground">
                No merchant-added origins. Platform and first-class integration defaults still apply.
              </p>
            )}
          </div>

          <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
            Merchant additions currently apply to scripts, connections, frames, images, and workers.
          </p>
        </section>

        <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            disabled={!canEdit || (!dirty && !hasPendingInput)}
            onClick={() => {
              setMerchantSources(savedMerchantSources);
              setSourceDraft("");
              setSourceError(null);
            }}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset
          </Button>
          <Button
            type="button"
            className="min-h-11 sm:min-h-9 sm:min-w-36"
            disabled={!canEdit || !dirty}
            onClick={() => saveMutation.mutate(merchantSources)}
          >
            {saveMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save policy
          </Button>
        </div>
      </div>
    </>
  );
}
