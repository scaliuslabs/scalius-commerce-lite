import { useMemo, type ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CreditCard,
  Database,
  FileText,
  FolderTree,
  Globe2,
  Home,
  ImageIcon,
  Layers3,
  ListTree,
  PanelTop,
  RefreshCw,
  Search,
  ShoppingCart,
  Trash2,
} from "lucide-react";

import { ADMIN_PERMISSIONS } from "@/lib/admin-permissions";
import { cacheGroupsQueryOptions } from "@/lib/api-query-options/cache";
import { useClearCache, useClearCacheGroup } from "@/lib/api-mutations/cache";
import type { CacheGroupDefinition } from "@/lib/api-functions/cache";
import { useHasPermission } from "@/contexts/PermissionContext";
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
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

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
  "product-schema": ShoppingCart,
  search: Search,
  attributes: ListTree,
};

const EMPTY_GROUPS: Record<string, CacheGroupDefinition> = {};
const EMPTY_PATH_MAPPING: Record<string, string[]> = {};

export function CacheManager() {
  const canManageCache = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_CACHE_MANAGE);
  const groupsQuery = useQuery(cacheGroupsQueryOptions());
  const clearGroupMutation = useClearCacheGroup();
  const clearAllMutation = useClearCache();

  const groups = groupsQuery.data?.groups ?? EMPTY_GROUPS;
  const pathMapping = groupsQuery.data?.pathMapping ?? EMPTY_PATH_MAPPING;
  const groupTriggers = useMemo(() => {
    const triggers: Record<string, string[]> = {};
    for (const [path, groupNames] of Object.entries(pathMapping)) {
      for (const groupName of groupNames) {
        (triggers[groupName] ??= []).push(path);
      }
    }
    return triggers;
  }, [pathMapping]);

  const groupNames = Object.keys(groups);
  const clearingGroup = clearGroupMutation.isPending
    ? clearGroupMutation.variables
    : null;
  const clearingAll = clearAllMutation.isPending;

  return (
    <div className="space-y-4">
      <Card className="shadow-none">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base">Public cache</CardTitle>
            <CardDescription>
              Cloudflare caches public API and storefront responses by domain. Merchant
              writes purge the affected domains automatically; the short TTL is the
              correctness fallback.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 gap-1.5 sm:min-h-8"
            onClick={() => void groupsQuery.refetch()}
            disabled={groupsQuery.isFetching}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${groupsQuery.isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </CardHeader>
      </Card>

      {!canManageCache && (
        <Alert>
          <Database className="h-4 w-4" />
          <AlertTitle>Read-only cache access</AlertTitle>
          <AlertDescription>
            You can inspect cache domains. Manual purge actions require cache manage
            permission.
          </AlertDescription>
        </Alert>
      )}

      {groupsQuery.isLoading ? (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="h-40 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : groupsQuery.isError ? (
        <Alert>
          <Database className="h-4 w-4" />
          <AlertTitle>Cache domains unavailable</AlertTitle>
          <AlertDescription>
            The dashboard will not guess domain names. Refresh after the API is healthy.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {groupNames.map((groupName) => {
            const group = groups[groupName];
            const Icon = GROUP_ICONS[groupName] ?? Database;
            const label = group?.label ?? groupName;
            const triggers = groupTriggers[groupName] ?? [];
            const isClearing = clearingGroup === groupName;

            return (
              <Card key={groupName} className="shadow-none">
                <CardHeader className="space-y-2 pb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <CardTitle className="text-sm">{label}</CardTitle>
                  </div>
                  <CardDescription className="min-h-10 text-xs">
                    {group?.description}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    {triggers.length === 0
                      ? "Purged only by explicit domain invalidation."
                      : `Automatically purged by ${triggers.length} mutation ${triggers.length === 1 ? "surface" : "surfaces"}.`}
                  </p>
                  {canManageCache && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 w-full gap-1.5 sm:min-h-8"
                      onClick={() => clearGroupMutation.mutate(groupName)}
                      disabled={clearingGroup !== null || clearingAll}
                    >
                      {isClearing ? (
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                      Purge {label}
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {canManageCache && groupNames.length > 0 && (
        <Card className="border-destructive/30 shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Purge all public caches</CardTitle>
            <CardDescription>
              Use this after an external data repair or when the stale domain is unknown.
              Normal dashboard saves already purge the precise affected domains.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="destructive"
                  className="min-h-11"
                  disabled={clearingAll || clearingGroup !== null}
                >
                  {clearingAll ? (
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="mr-2 h-4 w-4" />
                  )}
                  Purge everything
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Purge every public cache domain?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The next public requests will repopulate cache entries from the
                    authoritative database.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => clearAllMutation.mutate()}>
                    Purge everything
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
