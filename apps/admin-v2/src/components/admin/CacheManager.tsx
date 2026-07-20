import { useMemo, useState, type ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDate } from "@scalius/shared/timestamps";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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
import { Separator } from "../ui/separator";
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

// Group display config: icon, styling
const GROUP_CONFIG: Record<string, { icon: ComponentType<{ className?: string }>; bgColor: string; iconColor: string; hoverBorder: string }> = {
  products: { icon: ShoppingCart, bgColor: "bg-blue-100 dark:bg-blue-900/40", iconColor: "text-blue-600 dark:text-blue-400", hoverBorder: "hover:border-blue-500/50" },
  categories: { icon: FolderTree, bgColor: "bg-green-100 dark:bg-green-900/40", iconColor: "text-green-600 dark:text-green-400", hoverBorder: "hover:border-green-500/50" },
  collections: { icon: Layers3, bgColor: "bg-purple-100 dark:bg-purple-900/40", iconColor: "text-purple-600 dark:text-purple-400", hoverBorder: "hover:border-purple-500/50" },
  pages: { icon: FileText, bgColor: "bg-orange-100 dark:bg-orange-900/40", iconColor: "text-orange-600 dark:text-orange-400", hoverBorder: "hover:border-orange-500/50" },
  layout: { icon: PanelTop, bgColor: "bg-pink-100 dark:bg-pink-900/40", iconColor: "text-pink-600 dark:text-pink-400", hoverBorder: "hover:border-pink-500/50" },
  media: { icon: ImageIcon, bgColor: "bg-rose-100 dark:bg-rose-900/40", iconColor: "text-rose-600 dark:text-rose-400", hoverBorder: "hover:border-rose-500/50" },
  homepage: { icon: Home, bgColor: "bg-yellow-100 dark:bg-yellow-900/40", iconColor: "text-yellow-600 dark:text-yellow-400", hoverBorder: "hover:border-yellow-500/50" },
  discovery: { icon: Globe2, bgColor: "bg-teal-100 dark:bg-teal-900/40", iconColor: "text-teal-600 dark:text-teal-400", hoverBorder: "hover:border-teal-500/50" },
  checkout: { icon: CreditCard, bgColor: "bg-emerald-100 dark:bg-emerald-900/40", iconColor: "text-emerald-600 dark:text-emerald-400", hoverBorder: "hover:border-emerald-500/50" },
  search: { icon: Search, bgColor: "bg-cyan-100 dark:bg-cyan-900/40", iconColor: "text-cyan-600 dark:text-cyan-400", hoverBorder: "hover:border-cyan-500/50" },
  attributes: { icon: ListTree, bgColor: "bg-indigo-100 dark:bg-indigo-900/40", iconColor: "text-indigo-600 dark:text-indigo-400", hoverBorder: "hover:border-indigo-500/50" },
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
  const storefrontDlqError =
    storefrontDlqQuery.error instanceof Error
      ? storefrontDlqQuery.error.message
      : "Could not load storefront cache queue failures.";

  return (
    <div className="space-y-6">
      {/* Overview */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="bg-gradient-to-br from-blue-50/50 to-indigo-50/50 dark:from-blue-950/20 dark:to-indigo-950/20 border-blue-100/50 dark:border-blue-900/50 shadow-sm shadow-blue-900/5">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center text-lg text-blue-900 dark:text-blue-100">
              <Database className="mr-2 h-5 w-5 text-blue-600 dark:text-blue-400" />
              Backend KV Cache
            </CardTitle>
            <CardDescription className="text-blue-700/70 dark:text-blue-300/70">Cloudflare KV cache statistics</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                <div className="h-4 bg-muted rounded animate-pulse" />
                <div className="h-4 bg-muted rounded animate-pulse w-3/4" />
              </div>
            ) : stats ? (
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Type</span>
                  <span className="font-medium capitalize">{stats.cacheType || "kv"}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Entries</span>
                  <span className="font-medium">{stats.size === -1 ? "Managed" : stats.size}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Memory</span>
                  <span className="font-medium">{stats.memory}</span>
                </div>
              </div>
            ) : (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Unavailable</AlertTitle>
                <AlertDescription>Could not fetch cache statistics</AlertDescription>
              </Alert>
            )}
          </CardContent>
          <CardFooter className="pt-1">
            <div className="w-full flex justify-between items-center">
              <span className="text-xs text-muted-foreground flex items-center">
                <Clock className="h-3 w-3 mr-1" />
                {lastUpdated ? (
                  <span suppressHydrationWarning>
                    {new Date(lastUpdated).toLocaleTimeString()}
                  </span>
                ) : (
                  "\u2014"
                )}
              </span>
              <Button variant="outline" size="sm" onClick={refreshData} disabled={refreshing}>
                <RefreshCw className={`mr-1 h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </CardFooter>
        </Card>

        <Card className="lg:col-span-2 bg-gradient-to-br from-amber-50/50 to-orange-50/50 dark:from-amber-950/20 dark:to-orange-950/20 border-amber-100/50 dark:border-amber-900/50 shadow-sm shadow-amber-900/5">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center text-lg text-amber-900 dark:text-amber-100">
              <Info className="mr-2 h-5 w-5 text-amber-600 dark:text-amber-400" />
              How it works
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-amber-800/80 dark:text-amber-200/80 leading-relaxed">
              Cache is organized into <strong>invalidation groups</strong>. When you edit content in the admin,
              only the relevant groups are cleared. Groups marked{" "}
              <Badge variant="secondary" className="inline-flex text-xs px-1.5 py-0 bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border border-green-200 dark:border-green-800">Warms HTML</Badge>{" "}
              are directly HTML-affecting. Groups marked{" "}
              <Badge variant="secondary" className="inline-flex text-xs px-1.5 py-0 bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 border border-blue-200 dark:border-blue-800">Data prefixes</Badge>{" "}
              clear matching API/storefront data prefixes; critical pages are warmed whenever the storefront cache version moves.
            </div>
          </CardContent>
        </Card>
      </div>

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

      {/* Storefront queue recovery */}
      <Card className="border border-border/60 shadow-none">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
                <RefreshCw className="h-5 w-5 text-primary" />
                Storefront queue recovery
                <Badge variant="outline" className="font-normal">
                  {storefrontDlqCountLabel}
                </Badge>
              </CardTitle>
              <CardDescription>
                Recent cache purge and warm messages that are waiting for replay or ignore.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 self-start"
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
          {storefrontDlqQuery.isLoading ? (
            <div className="space-y-2">
              <div className="h-14 rounded-md bg-muted animate-pulse" />
              <div className="h-14 rounded-md bg-muted/70 animate-pulse" />
            </div>
          ) : storefrontDlqQuery.isError ? (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Queue status unavailable</AlertTitle>
              <AlertDescription>{storefrontDlqError}</AlertDescription>
            </Alert>
          ) : storefrontDlqCount === 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              No pending storefront cache queue failures.
            </div>
          ) : (
            <>
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
                            className="h-8 gap-1.5"
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
                                className="h-8 gap-1.5"
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
              {storefrontDlqMayHaveMore && (
                <p className="text-xs text-muted-foreground">
                  Showing the latest {STOREFRONT_CACHE_DLQ_LIMIT} pending items.
                  Replay or ignore an item to reveal older pending failures.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Dependency visualization (collapsible) */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">
            <Button
              type="button"
              variant="ghost"
              className="flex h-auto w-full items-center justify-between gap-3 p-0 text-left text-lg font-semibold hover:bg-transparent"
              aria-expanded={showDeps}
              aria-controls="cache-dependency-mapping"
              onClick={() => setShowDeps((current) => !current)}
            >
              <span className="flex items-center">
                <ListTree className="mr-2 h-5 w-5 text-primary" />
                Admin Action → Cache Group Mapping
              </span>
              {showDeps ? (
                <ChevronUp className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
            </Button>
          </CardTitle>
        </CardHeader>
        {showDeps && (
          <CardContent id="cache-dependency-mapping">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {groupNames.map((groupName) => {
                const triggers = groupTriggers[groupName] || [];
                const config = GROUP_CONFIG[groupName];
                return (
                  <div key={groupName} className="text-sm p-3 rounded-lg bg-muted/40 border border-border/50 hover:bg-muted/60 transition-colors">
                    <div className="font-semibold flex items-center gap-2 mb-2">
                      {config?.icon && <config.icon className="h-4 w-4 text-muted-foreground" />}
                      {groups[groupName]?.label || groupName}
                    </div>
                    <div className="pl-5 space-y-0.5">
                      {triggers.length > 0 ? (
                        triggers.map((path) => (
                          <div key={path} className="text-xs text-muted-foreground font-mono">
                            {path}
                          </div>
                        ))
                      ) : (
                        <div className="text-xs text-muted-foreground italic">Triggered as dependency</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        )}
      </Card>

      {/* Group grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {groupNames.map((groupName) => {
          const group = groups[groupName];
          const config = GROUP_CONFIG[groupName] || {
            icon: Database,
            bgColor: "bg-gray-100 dark:bg-gray-900/40",
            iconColor: "text-gray-600 dark:text-gray-400",
            hoverBorder: "hover:border-gray-500/50"
          };
          const Icon = config.icon;
          const lastCleared = timestamps[groupName];
          const isClearing = clearingGroup === groupName;

          return (
            <Card key={groupName} className={`transition-all duration-300 border border-border/40 hover:shadow-md ${config.hoverBorder}`}>
              <CardHeader className="pb-2 pt-4 px-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${config.bgColor}`}>
                      <Icon className={`h-4 w-4 ${config.iconColor}`} />
                    </div>
                    <CardTitle className="text-sm font-semibold">{group?.label || groupName}</CardTitle>
                  </div>
                  {group?.bumpsHtml ? (
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                      Warms HTML
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
                      Data prefixes
                    </Badge>
                  )}
                </div>
                <CardDescription className="text-xs mt-1">
                  {group?.description}
                </CardDescription>
              </CardHeader>
              <CardContent className="pb-3 px-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground flex items-center">
                    <Clock className="h-3 w-3 mr-1" />
                    {getRelativeTime(lastCleared)}
                  </span>
                  {canManageCache && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
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

      {/* Danger zone */}
      {canManageCache && (
        <>
          <Separator />
          <Card className="border border-destructive/30 bg-destructive/5 dark:bg-destructive/10 shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center text-lg text-destructive">
                <Eraser className="mr-2 h-5 w-5" />
                Danger Zone
              </CardTitle>
              <CardDescription className="text-destructive/80">
                Clear all backend and storefront caches. This will cause a temporary performance
                dip while caches rebuild.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="destructive"
                    disabled={clearingAll || clearingGroup !== null}
                    className="w-full sm:w-auto"
                  >
                    {clearingAll ? (
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 h-4 w-4" />
                    )}
                    Clear All Cache
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Clear all cache?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will clear all backend API cache and purge the storefront cache.
                      The site may be slower for a few moments while caches rebuild.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => clearAllMutation.mutate()}>
                      Clear all cache
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
