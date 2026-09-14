import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { EditorSheet, EmptyState } from "~/components/admin/shell";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { getServerFnError } from "~/lib/api-helpers";
import {
  getNavigationMenusAuthority,
  restoreNavigationMenuAuthority,
  type NavigationMenuSummary,
} from "~/lib/api-functions/navigation-authority";
import { queryKeys } from "~/lib/query-keys";

import { formatDateTime } from "./navigation-authority-model";

export interface NavigationMenuTrashSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestored: (menuId: string) => void;
}

/**
 * Trashed menus keep their items and publication history. A restored menu comes
 * back unpublished and unassigned so it cannot silently reappear on the
 * storefront.
 */
export function NavigationMenuTrashSheet({
  open,
  onOpenChange,
  onRestored,
}: NavigationMenuTrashSheetProps) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [...queryKeys.navigation.menus(), "trash"],
    queryFn: () => getNavigationMenusAuthority({ data: { limit: 100, includeTrash: true } }),
    enabled: open,
  });
  const trashedMenus = (query.data?.items ?? []).filter((menu) => Boolean(menu.deletedAt));
  const mutation = useMutation({
    mutationFn: (menu: NavigationMenuSummary) =>
      restoreNavigationMenuAuthority({
        data: { menuId: menu.id, expectedRevision: menu.revision },
      }),
    onSuccess: async (_result, menu) => {
      toast.success("Menu restored", {
        description: "Storefront locations stay disabled until you assign them again.",
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.navigation.menus() });
      onRestored(menu.id);
    },
    onError: (error) =>
      toast.error("Menu was not restored", {
        description: getServerFnError(error, "Menu was not restored"),
      }),
  });

  return (
    <EditorSheet
      open={open}
      onOpenChange={onOpenChange}
      width="sm"
      title="Menu trash"
      description="Restored menus stay unpublished and unassigned."
    >
      <div className="divide-y divide-border rounded-lg border border-border">
        {query.isLoading ? (
          <div className="space-y-3 p-3" role="status" aria-busy="true">
            <span className="sr-only">Loading trash</span>
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        ) : null}
        {query.isError ? (
          <div className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm text-destructive">
            <span>Trash could not be loaded.</span>
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : null}
        {trashedMenus.map((menu) => (
          <div
            key={menu.id}
            data-testid="navigation-trash-row"
            className="flex flex-wrap items-center justify-between gap-3 p-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{menu.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {menu.itemCount} {menu.itemCount === 1 ? "item" : "items"} · deleted{" "}
                {formatDateTime(menu.deletedAt!)}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="min-h-11 sm:min-h-9"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(menu)}
            >
              <RotateCcw className="mr-2 size-3.5" aria-hidden /> Restore
            </Button>
          </div>
        ))}
        {!query.isLoading && !query.isError && !trashedMenus.length ? (
          <EmptyState
            compact
            bordered={false}
            icon={Trash2}
            heading="Trash is empty"
            body="Menus you delete stay here until you restore them."
          />
        ) : null}
      </div>
    </EditorSheet>
  );
}

export default NavigationMenuTrashSheet;
