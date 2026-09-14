import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, ListTree, MapPin, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  EmptyState,
  IndexFilters,
  IndexTable,
  PageHeader,
  StatusBadge,
  type IndexTableColumn,
} from "~/components/admin/shell";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { getServerFnError } from "~/lib/api-helpers";
import {
  getNavigationMenusAuthority,
  getNavigationPlacementSettings,
  trashNavigationMenuAuthority,
  type NavigationMenuSummary,
} from "~/lib/api-functions/navigation-authority";
import { queryKeys } from "~/lib/query-keys";

import { NavigationCreateMenuDialog } from "./NavigationCreateMenuDialog";
import { NavigationLocationsFields } from "./NavigationLocationsFields";
import { NavigationMenuTrashSheet } from "./NavigationMenuTrashSheet";
import {
  describeMenuTrashBlock,
  filterMenuSummaries,
  formatDateTime,
  getMenuPublishState,
  menuLocationLabels,
  sortMenuSummaries,
  summarizeMenuLocations,
  type MenuSortValue,
} from "./navigation-authority-model";

export interface NavigationMenusIndexProps {
  query: string;
  onQueryChange: (query: string) => void;
  onOpenMenu: (menuId: string) => void;
}

const SORT_OPTIONS = [
  { value: "updated", label: "Last updated" },
  { value: "name", label: "Name" },
  { value: "items", label: "Most items" },
] as const;

/**
 * The menus list. It is the landing view for Navigation: which menus exist,
 * which storefront location each one fills, and whether the live storefront is
 * showing the latest version.
 */
export function NavigationMenusIndex({
  query,
  onQueryChange,
  onOpenMenu,
}: NavigationMenusIndexProps) {
  const queryClient = useQueryClient();
  const [sort, setSort] = useState<MenuSortValue>("updated");
  const [createOpen, setCreateOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [assignMenu, setAssignMenu] = useState<NavigationMenuSummary | null>(null);
  const [trashMenu, setTrashMenu] = useState<NavigationMenuSummary | null>(null);

  const menusQuery = useQuery({
    queryKey: queryKeys.navigation.menus(),
    queryFn: () => getNavigationMenusAuthority({ data: { limit: 100 } }),
  });
  const placementsQuery = useQuery({
    queryKey: queryKeys.navigation.placements(),
    queryFn: () => getNavigationPlacementSettings(),
  });

  const menus = useMemo(() => menusQuery.data?.items ?? [], [menusQuery.data?.items]);
  const placements = placementsQuery.data?.placements ?? [];
  const menusById = useMemo(
    () => new Map(menus.map((menu) => [menu.id, menu.name])),
    [menus],
  );
  const rows = useMemo(
    () => sortMenuSummaries(filterMenuSummaries(menus, query), sort),
    [menus, query, sort],
  );

  const trashMutation = useMutation({
    mutationFn: (menu: NavigationMenuSummary) =>
      trashNavigationMenuAuthority({
        data: { menuId: menu.id, expectedRevision: menu.revision },
      }),
    onSuccess: () => {
      toast.success("Menu moved to trash", {
        description: "Items and publication history were kept.",
      });
      setTrashMenu(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.navigation.menus() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.navigation.placements() });
    },
    onError: (error) =>
      toast.error("Menu was not moved to trash", {
        description: getServerFnError(error, "Menu was not moved to trash"),
      }),
  });

  const columns: Array<IndexTableColumn<NavigationMenuSummary>> = [
    {
      id: "name",
      header: "Menu",
      cell: (menu) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{menu.name}</span>
          <span className="truncate text-xs text-muted-foreground">{menu.handle}</span>
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      mobileLabel: "Status",
      cell: (menu) => {
        const state = getMenuPublishState(menu);
        return (
          <StatusBadge tone={state.badgeTone} srLabel="Publish status:">
            {state.badgeLabel}
          </StatusBadge>
        );
      },
    },
    {
      id: "locations",
      header: "Storefront location",
      mobileLabel: "Location",
      cell: (menu) => {
        const labels = menuLocationLabels(placements, menu.id);
        const summary = summarizeMenuLocations(labels);
        return (
          <StatusBadge tone={summary.tone} dot={labels.length > 0} srLabel="Storefront location:">
            {summary.label}
          </StatusBadge>
        );
      },
    },
    {
      id: "items",
      header: "Items",
      align: "end",
      mobileLabel: "Items",
      cell: (menu) => <span className="text-sm tabular-nums">{menu.itemCount}</span>,
    },
    {
      id: "updated",
      header: "Last updated",
      mobileLabel: "Updated",
      hideOnMobile: true,
      cell: (menu) => (
        <span className="text-xs text-muted-foreground">{formatDateTime(menu.updatedAt)}</span>
      ),
    },
  ];

  const hasNoMenus = !menusQuery.isLoading && menus.length === 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Navigation"
        subtitle="Menus decide what customers can reach from the header and footer."
        primaryAction={{
          id: "create-menu",
          label: "Create menu",
          icon: Plus,
          onClick: () => setCreateOpen(true),
        }}
        secondaryActions={[
          { id: "trash", label: "Trash", icon: Trash2, onClick: () => setTrashOpen(true) },
        ]}
        inlineActionCount={1}
      />

      {hasNoMenus ? (
        <EmptyState
          icon={ListTree}
          heading="No menus yet"
          body="Create a menu, add the destinations customers need, then assign it to the header or footer."
          action={{ label: "Create menu", icon: Plus, onClick: () => setCreateOpen(true) }}
          secondaryAction={{ label: "Open trash", onClick: () => setTrashOpen(true) }}
        />
      ) : (
        <>
          <IndexFilters
            label="Filter menus"
            searchValue={query}
            searchPlaceholder="Search menus"
            onSearchChange={onQueryChange}
            sortOptions={SORT_OPTIONS}
            sortValue={sort}
            onSortChange={(value) => setSort(value as MenuSortValue)}
          />
          <IndexTable
            label="Menus"
            items={rows}
            columns={columns}
            getRowId={(menu) => menu.id}
            loading={menusQuery.isLoading}
            onRowClick={(menu) => onOpenMenu(menu.id)}
            empty={
              <EmptyState
                icon={ListTree}
                heading="No menus match that search"
                body="Try a different name or handle."
                action={{ label: "Clear search", onClick: () => onQueryChange("") }}
              />
            }
            rowActions={(menu) => (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 sm:size-9"
                    aria-label={`Actions for ${menu.name}`}
                  >
                    <Ellipsis className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem onSelect={() => onOpenMenu(menu.id)}>
                    <Pencil className="mr-2 size-4" /> Edit menu
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setAssignMenu(menu)}>
                    <MapPin className="mr-2 size-4" /> Assign location
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setTrashMenu(menu)}
                  >
                    <Trash2 className="mr-2 size-4" /> Move to trash
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          />
        </>
      )}

      <NavigationCreateMenuDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(menuId) => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.navigation.menus() });
          onOpenMenu(menuId);
        }}
      />

      <NavigationMenuTrashSheet
        open={trashOpen}
        onOpenChange={setTrashOpen}
        onRestored={(menuId) => {
          setTrashOpen(false);
          onOpenMenu(menuId);
        }}
      />

      <Dialog open={Boolean(assignMenu)} onOpenChange={(open) => !open && setAssignMenu(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Where this menu appears</DialogTitle>
            <DialogDescription>
              Assigning a slot replaces whatever menu it shows now.
            </DialogDescription>
          </DialogHeader>
          {assignMenu ? (
            <NavigationLocationsFields menu={assignMenu} menusById={menusById} />
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              className="min-h-11 sm:min-h-9"
              onClick={() => setAssignMenu(null)}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(trashMenu)}
        onOpenChange={(open) => !open && setTrashMenu(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move "{trashMenu?.name}" to trash?</AlertDialogTitle>
            <AlertDialogDescription>
              {describeMenuTrashBlock(trashMenu?.placementCount ?? 0)
                ?? "Its items and publication history are kept, and you can restore it from trash."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep menu</AlertDialogCancel>
            {(trashMenu?.placementCount ?? 0) === 0 ? (
              <AlertDialogAction
                variant="destructive"
                disabled={trashMutation.isPending}
                onClick={(event) => {
                  event.preventDefault();
                  if (trashMenu) trashMutation.mutate(trashMenu);
                }}
              >
                {trashMutation.isPending ? "Moving" : "Move to trash"}
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default NavigationMenusIndex;
