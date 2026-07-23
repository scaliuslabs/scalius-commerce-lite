import { useMemo, useState, type ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDate } from "@scalius/shared/timestamps";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import {
  Trash2,
  RefreshCw,
  AlertCircle,
  Database,
  Clock,
  ShoppingCart,
  FolderTree,
  Layers3,
  FileText,
  PanelTop,
  Home,
  CreditCard,
  Search,
  ListTree,
  Eraser,
  Info,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  ImageIcon,
  Globe2,
} from "lucide-react";
import { ADMIN_PERMISSIONS } from "@/lib/admin-permissions";
import { useHasPermission } from "@/contexts/PermissionContext";
import {
  cacheGroupsQueryOptions,
  cacheLastClearedQueryOptions,
  cacheStatsQueryOptions,
  STOREFRONT_CACHE_DLQ_LIMIT,
  storefrontCacheDlqQueryOptions,
} from "@/lib/api-query-options/cache";
import {
  useClearCache,
  useClearCacheGroup,
  useIgnoreStorefrontCacheDlqFailure,
  useReplayStorefrontCacheDlqFailure,
} from "@/lib/api-mutations/cache";
import type {
  CacheGroupDefinition,
  StorefrontCacheQueueFailureRecord,
} from "@/lib/api-functions/cache";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../ui/alert-dialog";

const GROUP_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  products: ShoppingCart,
  categories: FolderTree,
  collections: Layers3,
  pages: FileText,
  layout: PanelTop,
  media: ImageIcon,
  homepage: Home,
  discovery: Globe2,
  checkout: CreditCard,
  search: Search,
  attributes: ListTree,
};

const EMPTY_GROUPS: Record<string, CacheGroupDefinition> = {};
const EMPTY_PATH_MAPPING: Record<string, string[]> = {};
const EMPTY_TIMESTAMPS: Record<string, number | null> = {};
const EMPTY_STOREFRONT_DLQ_FAILURES: StorefrontCacheQueueFailureRecord[] = [];

function humanizeCacheQueueValue(value: string | null | undefined): string {
  const text = value?.trim();
  if (!text) return "Unknown";
  const normalized = text
    .replace(/^storefront\./, "")
    .replace(/^cache_/, "cache ")
    .replace(/[._:-]+/g, " ");
  return normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cacheQueueAttemptLabel(attempts: number): string {
  return `${attempts} attempt${attempts === 1 ? "" : "s"}`;
}

function cacheQueueErrorLabel(error: string | null): string {
  const text = error?.trim();
  if (!text) return "No error detail recorded.";
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function getRelativeTime(timestamp: number | null): string {
  if (!timestamp) return "Never";
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function CacheManager() {
  const [showDeps, setShowDeps] = useState(false);
  const canManageCache = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_CACHE_MANAGE);

  const statsQuery = useQuery(cacheStatsQueryOptions());
  const timestampsQuery = useQuery(cacheLastClearedQueryOptions());
  const groupsQuery = useQuery(cacheGroupsQueryOptions());
  const storefrontDlqQuery = useQuery(
    storefrontCacheDlqQueryOptions({
      status: "pending",
      limit: STOREFRONT_CACHE_DLQ_LIMIT,
    }),
  );
  const clearGroupMutation = useClearCacheGroup();
  const clearAllMutation = useClearCache();
  const replayStorefrontDlqMutation = useReplayStorefrontCacheDlqFailure();
  const ignoreStorefrontDlqMutation = useIgnoreStorefrontCacheDlqFailure();

  const stats = statsQuery.data?.stats ?? null;
  const timestamps = timestampsQuery.data?.timestamps ?? EMPTY_TIMESTAMPS;
  const groups = groupsQuery.data?.groups ?? EMPTY_GROUPS;
  const pathMapping = groupsQuery.data?.pathMapping ?? EMPTY_PATH_MAPPING;
  const pendingStorefrontDlqFailures =
    storefrontDlqQuery.data?.failures ?? EMPTY_STOREFRONT_DLQ_FAILURES;
  const loading =
    statsQuery.isLoading || timestampsQuery.isLoading || groupsQuery.isLoading;
  const cacheReadError =
    statsQuery.isError || timestampsQuery.isError || groupsQuery.isError;
  const refreshing =
    statsQuery.isFetching ||
    timestampsQuery.isFetching ||
    groupsQuery.isFetching ||
    storefrontDlqQuery.isFetching;
  const clearingGroup = clearGroupMutation.isPending
    ? clearGroupMutation.variables
    : null;
  const clearingAll = clearAllMutation.isPending;
  const storefrontDlqActionId = replayStorefrontDlqMutation.isPending
    ? replayStorefrontDlqMutation.variables
    : ignoreStorefrontDlqMutation.isPending
      ? ignoreStorefrontDlqMutation.variables
      : null;
  const lastUpdated = Math.max(
    statsQuery.dataUpdatedAt,
    timestampsQuery.dataUpdatedAt,
    groupsQuery.dataUpdatedAt,
    storefrontDlqQuery.dataUpdatedAt,
  );

  const refreshData = () => {
    void Promise.all([
      statsQuery.refetch(),
      timestampsQuery.refetch(),
      groupsQuery.refetch(),
      storefrontDlqQuery.refetch(),
    ]);
  };

  // Build reverse mapping: group -> which paths trigger it
  const groupTriggers = useMemo(() => {
    const triggers: Record<string, string[]> = {};
    for (const [path, groupList] of Object.entries(pathMapping)) {
      for (const group of groupList) {
        if (!triggers[group]) triggers[group] = [];
        triggers[group].push(path);
      }
    }
    return triggers;
  }, [pathMapping]);

  const groupNames = Object.keys(groups);
  const storefrontDlqCount = pendingStorefrontDlqFailures.length;
  const storefrontDlqMayHaveMore =
    storefrontDlqCount >= STOREFRONT_CACHE_DLQ_LIMIT;
  const storefrontDlqCountLabel = storefrontDlqQuery.isError
    ? "Unavailable"
    : storefrontDlqQuery.isLoading
      ? "Loading"
      : storefrontDlqMayHaveMore
        ? `${storefrontDlqCount}+ pending`
        : `${storefrontDlqCount} pending`;
  const showFailedCacheWork =
    storefrontDlqQuery.isError || storefrontDlqCount > 0;
  const storefrontDlqError =
    storefrontDlqQuery.error instanceof Error
      ? storefrontDlqQuery.error.message
      : "Could not load storefront cache queue failures.";
  const backendCacheLabel = stats
    ? stats.size === -1
      ? `${(stats.cacheType || "KV").toUpperCase()} managed`
      : `${stats.size} entries`
    : "Unavailable";

  return (
    <div className="space-y-4">
      <Card className="shadow-none">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Cache health</CardTitle>
              <CardDescription>
                Live backend, invalidation, and recovery state.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 gap-1.5 sm:min-h-8"
              onClick={refreshData}
              disabled={refreshing}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {Array.from({ length: 4 }, (_, index) => (
                <div
                  key={index}
                  className="h-16 animate-pulse rounded-md bg-muted"
                />
              ))}
            </div>
          ) : (
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-md border bg-muted/20 px-3 py-2">
                <dt className="text-xs text-muted-foreground">Backend cache</dt>
                <dd className="mt-1 text-sm font-medium">{backendCacheLabel}</dd>
              </div>
              <div className="rounded-md border bg-muted/20 px-3 py-2">
                <dt className="text-xs text-muted-foreground">Groups</dt>
                <dd className="mt-1 text-sm font-medium">
                  {groupsQuery.isError ? "Unavailable" : groupNames.length}
                </dd>
              </div>
              <div className="rounded-md border bg-muted/20 px-3 py-2">
                <dt className="text-xs text-muted-foreground">Failed work</dt>
                <dd className="mt-1 text-sm font-medium">
                  {storefrontDlqCountLabel}
                </dd>
              </div>
              <div className="rounded-md border bg-muted/20 px-3 py-2">
                <dt className="text-xs text-muted-foreground">Updated</dt>
                <dd
                  className="mt-1 text-sm font-medium"
                  suppressHydrationWarning
                >
                  {lastUpdated ? getRelativeTime(lastUpdated) : "Never"}
                </dd>
              </div>
            </dl>
          )}
          {cacheReadError && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Some cache data is unavailable</AlertTitle>
              <AlertDescription>
                Refresh to retry. Clear actions stay limited to data that loaded
                successfully.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {!canManageCache && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>Read-only cache access</AlertTitle>
          <AlertDescription>
            You can review cache health and queue status. Replay, mark resolved,
            and clear actions require cache manage permission.
          </AlertDescription>
        </Alert>
      )}

      {showFailedCacheWork && (
        <Card className="border border-border/60 shadow-none">
          <CardHeader className="pb-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  <AlertCircle className="h-4 w-4 text-muted-foreground" />
                  Failed cache work
                  <Badge variant="outline" className="font-normal">
                    {storefrontDlqCountLabel}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  Purge or warm jobs that exhausted automatic retries.
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 gap-1.5 self-start sm:min-h-8"
                onClick={() => void storefrontDlqQuery.refetch()}
                disabled={storefrontDlqQuery.isFetching}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${storefrontDlqQuery.isFetching ? "animate-spin" : ""}`}
                />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {storefrontDlqQuery.isError ? (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Queue status unavailable</AlertTitle>
                <AlertDescription>{storefrontDlqError}</AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-2">
                {pendingStorefrontDlqFailures.map((failure) => {
                  const isReplaying =
                    replayStorefrontDlqMutation.isPending &&
                    storefrontDlqActionId === failure.id;
                  const isIgnoring =
                    ignoreStorefrontDlqMutation.isPending &&
                    storefrontDlqActionId === failure.id;
                  const actionBusy = storefrontDlqActionId !== null;

                  return (
                    <div
                      key={failure.id}
                      className="grid gap-3 rounded-md border border-border bg-background/70 p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto]"
                    >
                      <div className="min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="secondary" className="font-normal">
                            {humanizeCacheQueueValue(failure.messageType)}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            Source: {humanizeCacheQueueValue(failure.source)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {cacheQueueAttemptLabel(failure.attempts)}
                          </span>
                          <span
                            className="text-xs text-muted-foreground"
                            suppressHydrationWarning
                          >
                            Failed {formatDate(failure.failedAt)}
                          </span>
                        </div>
                        <div
                          className="line-clamp-2 text-xs text-muted-foreground"
                          title={failure.lastError ?? undefined}
                        >
                          {cacheQueueErrorLabel(failure.lastError)}
                        </div>
                      </div>
                      {canManageCache ? (
                        <div className="flex items-center gap-2 sm:justify-end">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-h-11 gap-1.5 sm:min-h-8"
                            disabled={actionBusy}
                            onClick={() =>
                              replayStorefrontDlqMutation.mutate(failure.id)
                            }
                          >
                            <RefreshCw
                              className={`h-3.5 w-3.5 ${isReplaying ? "animate-spin" : ""}`}
                            />
                            Replay
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="min-h-11 gap-1.5 sm:min-h-8"
                                disabled={actionBusy}
                              >
                                <CheckCircle2
                                  className={`h-3.5 w-3.5 ${isIgnoring ? "animate-pulse" : ""}`}
                                />
                                Mark resolved
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>
                                  Mark cache queue failure resolved?
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                  This archives the failure without replaying it.
                                  Use this only when the cache message no longer
                                  needs to run.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() =>
                                    ignoreStorefrontDlqMutation.mutate(failure.id)
                                  }
                                >
                                  Mark resolved
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      ) : (
                        <div className="flex items-center text-xs text-muted-foreground sm:justify-end">
                          Manage permission required
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {!storefrontDlqQuery.isError && storefrontDlqMayHaveMore && (
              <p className="text-xs text-muted-foreground">
                Showing the latest {STOREFRONT_CACHE_DLQ_LIMIT} pending items.
                Replay or ignore an item to reveal older pending failures.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <section className="space-y-3" aria-labelledby="cache-groups-title">
        <div>
          <h2 id="cache-groups-title" className="text-base font-semibold">
            Invalidation groups
          </h2>
          <p className="text-sm text-muted-foreground">
            Clear the smallest group that contains stale data.
          </p>
        </div>
        {groupsQuery.isLoading ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <div
                key={index}
                className="h-32 animate-pulse rounded-lg bg-muted"
              />
            ))}
          </div>
        ) : groupsQuery.isError ? (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Invalidation groups unavailable</AlertTitle>
            <AlertDescription>
              Refresh before clearing a group. No group defaults were assumed.
            </AlertDescription>
          </Alert>
        ) : groupNames.length === 0 ? (
          <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
            No invalidation groups are configured.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {groupNames.map((groupName) => {
              const group = groups[groupName];
              const Icon = GROUP_ICONS[groupName] || Database;
              const lastCleared = timestamps[groupName];
              const isClearing = clearingGroup === groupName;
              const label = group?.label || groupName;

              return (
                <Card key={groupName} className="shadow-none">
                  <CardHeader className="px-4 pb-2 pt-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted">
                          <Icon className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <CardTitle className="truncate text-sm font-semibold">
                          {label}
                        </CardTitle>
                      </div>
                      <Badge variant="outline" className="shrink-0 font-normal">
                        {group?.bumpsHtml ? "Warms pages" : "Data only"}
                      </Badge>
                    </div>
                    <CardDescription className="mt-1 min-h-8 text-xs">
                      {group?.description}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="px-4 pb-3">
                    <div className="flex items-center justify-between gap-3 border-t pt-3">
                      <span className="flex items-center text-xs text-muted-foreground">
                        <Clock className="mr-1 h-3 w-3" />
                        {timestampsQuery.isError
                          ? "Clear history unavailable"
                          : lastCleared
                            ? `Cleared ${getRelativeTime(lastCleared)}`
                            : "Not cleared manually"}
                      </span>
                      {canManageCache && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="min-h-11 text-xs sm:min-h-8"
                          aria-label={`Clear ${label} cache`}
                          onClick={() => clearGroupMutation.mutate(groupName)}
                          disabled={clearingGroup !== null || clearingAll}
                        >
                          {isClearing ? (
                            <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
                          ) : (
                            <Trash2 className="mr-1 h-3 w-3" />
                          )}
                          Clear
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <Card className="shadow-none">
        <CardHeader className="p-0">
          <Button
            type="button"
            variant="ghost"
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-4 py-3 text-left hover:bg-muted/50"
            aria-expanded={showDeps}
            aria-controls="cache-dependency-mapping"
            onClick={() => setShowDeps((current) => !current)}
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <ListTree className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="block text-sm font-semibold">
                  Invalidation dependencies
                </span>
                <span className="block text-xs font-normal text-muted-foreground">
                  Admin writes that clear each group.
                </span>
              </span>
            </span>
            {showDeps ? (
              <ChevronUp className="h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
            )}
          </Button>
        </CardHeader>
        {showDeps && (
          <CardContent id="cache-dependency-mapping" className="border-t pt-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              {groupNames.map((groupName) => {
                const triggers = groupTriggers[groupName] || [];
                const Icon = GROUP_ICONS[groupName] || Database;
                return (
                  <div key={groupName} className="rounded-md border p-3 text-sm">
                    <div className="mb-2 flex items-center gap-2 font-medium">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      {groups[groupName]?.label || groupName}
                    </div>
                    <div className="space-y-1 pl-6">
                      {triggers.length > 0 ? (
                        triggers.map((path) => (
                          <div
                            key={path}
                            className="break-all font-mono text-xs text-muted-foreground"
                          >
                            {path}
                          </div>
                        ))
                      ) : (
                        <div className="text-xs text-muted-foreground">
                          Cleared by another group.
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        )}
      </Card>

      {canManageCache && (
        <Card className="border border-destructive/30 shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center text-base">
              <Eraser className="mr-2 h-4 w-4 text-destructive" />
              Clear all caches
            </CardTitle>
            <CardDescription>
              Use only when stale data spans several groups. The storefront may
              be slower while caches rebuild.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  disabled={clearingAll || clearingGroup !== null}
                  className="min-h-11 w-full sm:min-h-9 sm:w-auto"
                >
                  {clearingAll ? (
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="mr-2 h-4 w-4" />
                  )}
                  Clear all caches
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear all caches?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This clears backend API cache and purges storefront cache.
                    The site may be slower for a few moments while caches
                    rebuild.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => clearAllMutation.mutate()}>
                    Clear all caches
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
