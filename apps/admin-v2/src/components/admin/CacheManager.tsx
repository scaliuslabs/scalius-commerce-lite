import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
} from "lucide-react";
import {
  cacheGroupsQueryOptions,
  cacheLastClearedQueryOptions,
  cacheStatsQueryOptions,
} from "@/lib/api-query-options/cache";
import {
  useClearCache,
  useClearCacheGroup,
} from "@/lib/api-mutations/cache";
import type { CacheGroupDefinition } from "@/lib/api-functions/cache";
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
const GROUP_CONFIG: Record<string, { icon: React.ComponentType<{ className?: string }>; bgColor: string; iconColor: string; hoverBorder: string }> = {
  products: { icon: ShoppingCart, bgColor: "bg-blue-100 dark:bg-blue-900/40", iconColor: "text-blue-600 dark:text-blue-400", hoverBorder: "hover:border-blue-500/50" },
  categories: { icon: FolderTree, bgColor: "bg-green-100 dark:bg-green-900/40", iconColor: "text-green-600 dark:text-green-400", hoverBorder: "hover:border-green-500/50" },
  collections: { icon: Layers3, bgColor: "bg-purple-100 dark:bg-purple-900/40", iconColor: "text-purple-600 dark:text-purple-400", hoverBorder: "hover:border-purple-500/50" },
  pages: { icon: FileText, bgColor: "bg-orange-100 dark:bg-orange-900/40", iconColor: "text-orange-600 dark:text-orange-400", hoverBorder: "hover:border-orange-500/50" },
  layout: { icon: PanelTop, bgColor: "bg-pink-100 dark:bg-pink-900/40", iconColor: "text-pink-600 dark:text-pink-400", hoverBorder: "hover:border-pink-500/50" },
  homepage: { icon: Home, bgColor: "bg-yellow-100 dark:bg-yellow-900/40", iconColor: "text-yellow-600 dark:text-yellow-400", hoverBorder: "hover:border-yellow-500/50" },
  checkout: { icon: CreditCard, bgColor: "bg-emerald-100 dark:bg-emerald-900/40", iconColor: "text-emerald-600 dark:text-emerald-400", hoverBorder: "hover:border-emerald-500/50" },
  search: { icon: Search, bgColor: "bg-cyan-100 dark:bg-cyan-900/40", iconColor: "text-cyan-600 dark:text-cyan-400", hoverBorder: "hover:border-cyan-500/50" },
  attributes: { icon: ListTree, bgColor: "bg-indigo-100 dark:bg-indigo-900/40", iconColor: "text-indigo-600 dark:text-indigo-400", hoverBorder: "hover:border-indigo-500/50" },
};

const EMPTY_GROUPS: Record<string, CacheGroupDefinition> = {};
const EMPTY_PATH_MAPPING: Record<string, string[]> = {};
const EMPTY_TIMESTAMPS: Record<string, number | null> = {};

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

  const statsQuery = useQuery(cacheStatsQueryOptions());
  const timestampsQuery = useQuery(cacheLastClearedQueryOptions());
  const groupsQuery = useQuery(cacheGroupsQueryOptions());
  const clearGroupMutation = useClearCacheGroup();
  const clearAllMutation = useClearCache();

  const stats = statsQuery.data?.stats ?? null;
  const timestamps = timestampsQuery.data?.timestamps ?? EMPTY_TIMESTAMPS;
  const groups = groupsQuery.data?.groups ?? EMPTY_GROUPS;
  const pathMapping = groupsQuery.data?.pathMapping ?? EMPTY_PATH_MAPPING;
  const loading =
    statsQuery.isLoading || timestampsQuery.isLoading || groupsQuery.isLoading;
  const refreshing =
    statsQuery.isFetching ||
    timestampsQuery.isFetching ||
    groupsQuery.isFetching;
  const clearingGroup = clearGroupMutation.isPending
    ? clearGroupMutation.variables
    : null;
  const clearingAll = clearAllMutation.isPending;
  const lastUpdated = Math.max(
    statsQuery.dataUpdatedAt,
    timestampsQuery.dataUpdatedAt,
    groupsQuery.dataUpdatedAt,
  );

  const refreshData = () => {
    void Promise.all([
      statsQuery.refetch(),
      timestampsQuery.refetch(),
      groupsQuery.refetch(),
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

      {/* Dependency visualization (collapsible) */}
      <Card>
        <CardHeader
          className="pb-2 cursor-pointer select-none"
          onClick={() => setShowDeps(!showDeps)}
        >
          <CardTitle className="flex items-center justify-between text-lg">
            <span className="flex items-center">
              <ListTree className="mr-2 h-5 w-5 text-primary" />
              Admin Action → Cache Group Mapping
            </span>
            {showDeps ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </CardTitle>
        </CardHeader>
        {showDeps && (
          <CardContent>
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
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Danger zone */}
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
    </div>
  );
}
