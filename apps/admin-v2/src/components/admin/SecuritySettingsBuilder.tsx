import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  Plus,
  Server,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  normalizeMerchantCspSource,
  parseMerchantCspSources,
  serializeMerchantCspSources,
} from "@scalius/shared/security-csp";

import {
  ContextualSaveBar,
  EmptyState,
  FieldError,
  InlineHelp,
  SettingsSection,
  SkeletonPage,
  StatusBadge,
} from "~/components/admin/shell";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { getServerFnError } from "~/lib/api-helpers";
import {
  getSecuritySettings,
  updateSecuritySettings,
} from "~/lib/api-functions/settings";
import { getInheritedSecuritySources } from "~/lib/api-functions/security-runtime";
import { queryKeys } from "~/lib/query-keys";
import { SettingsLoadFailure } from "./settings/SettingsLoadFailure";

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
  const [merchantListOpen, setMerchantListOpen] = useState(false);
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

  useEffect(() => {
    if (dirty) setMerchantListOpen(true);
  }, [dirty]);

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

  function discardDraft() {
    setMerchantSources(savedMerchantSources);
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
      <SkeletonPage
        showHeader={false}
        sections={2}
        rowsPerSection={3}
        label="Loading storefront security policy"
      />
    );
  }

  const saveDisabledReason = sourceError
    ? "Fix the highlighted fields before saving."
    : !dirty
      ? "Add the pending origin or clear it before saving."
      : undefined;

  return (
    <div className="max-w-5xl">
      <ContextualSaveBar
        isDirty={dirty || hasPendingInput || saveMutation.isPending}
        saving={saveMutation.isPending}
        saveDisabled={!dirty || Boolean(sourceError)}
        saveDisabledReason={saveDisabledReason}
        canSave={canManage}
        saveLabel="Save policy"
        allowSamePathNavigation
        // The settings section picker is sticky on narrow widths.
        stickyClassName="sticky top-15 z-30 lg:top-0"
        onDiscard={discardDraft}
        onSave={() => saveMutation.mutate(merchantSources)}
      />

      <div className="space-y-6">
        {!canManage && (
          <Alert>
            <AlertDescription>
              Your role can review the storefront security policy, but cannot change it.
            </AlertDescription>
          </Alert>
        )}

        <SettingsSection
          title="Inherited platform trust"
          description="Read-only origins configured in Settings → System → Platform."
          contentClassName="p-0 sm:p-0"
        >
          {inheritedQuery.isError ? (
            <div className="flex flex-col gap-3 px-4 py-3 text-xs text-amber-700 dark:text-amber-300 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
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
            <div role="status" aria-busy="true" className="divide-y">
              <span className="sr-only">Reading deployed origins</span>
              {[0, 1, 2].map((row) => (
                <div key={row} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] sm:items-center sm:px-6">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3.5 w-full max-w-64" />
                  <Skeleton className="h-5 w-20" />
                </div>
              ))}
            </div>
          ) : (
            <div className="divide-y">
              {inheritedQuery.data?.map((source) => (
                <div
                  key={source.key}
                  className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] sm:items-center sm:px-6"
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Server className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
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
                    {!source.source ? (
                      <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                        {source.consequence} Set it in the Platform section.
                      </p>
                    ) : null}
                  </div>
                  <StatusBadge
                    tone={source.source ? "success" : "attention"}
                    srLabel={`${source.label} platform origin:`}
                    className="w-fit"
                  >
                    {source.source ? "Trusted" : "Missing"}
                  </StatusBadge>
                </div>
              ))}
            </div>
          )}
        </SettingsSection>

        <SettingsSection
          title="Additional storefront services"
          description="Add an exact origin required by a payment, analytics, chat, or embedded service."
          footer="Merchant additions currently apply to scripts, connections, frames, images, and workers."
        >
          <div className="space-y-2">
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
                <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                Add origin
              </Button>
            </div>
            {sourceError ? (
              <FieldError id="csp-source-help">{sourceError}</FieldError>
            ) : (
              <InlineHelp id="csp-source-help">
                Exact HTTPS origins stay exact. Use https://*.example.com only when every subdomain is required.
              </InlineHelp>
            )}
          </div>

          {merchantSources.length > 0 ? (
            <details
              className="group mt-4 rounded-md border"
              open={merchantListOpen}
              onToggle={(event) => setMerchantListOpen(event.currentTarget.open)}
            >
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
                {merchantSources.length} trusted {merchantSources.length === 1 ? "origin" : "origins"}
                <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <div className="divide-y border-t">
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
                      <X className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                ))}
              </div>
            </details>
          ) : (
            <EmptyState
              className="mt-4"
              compact
              heading="No merchant-added origins"
              body="Platform and first-class integration defaults still apply. Add an origin above when an embedded service needs one."
            />
          )}
        </SettingsSection>
      </div>
    </div>
  );
}
