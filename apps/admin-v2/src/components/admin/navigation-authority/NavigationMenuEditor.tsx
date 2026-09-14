import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Hash, History, Pencil, Search, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@scalius/shared/utils";
import {
  ContextualSaveBar,
  EmptyState,
  FieldError,
  InlineHelp,
  PageHeader,
  SettingsSection,
  SkeletonPage,
  StatusBadge,
  type PageHeaderAction,
  type PageHeaderLinkProps,
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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { getServerFnError } from "~/lib/api-helpers";
import {
  deleteNavigationMenuItemAuthority,
  getNavigationMenuAuthority,
  getNavigationMenusAuthority,
  moveNavigationMenuItemAuthority,
  publishNavigationMenuAuthority,
  rollbackNavigationMenuAuthority,
  searchNavigationMenuItemsAuthority,
  trashNavigationMenuAuthority,
  updateNavigationMenuMetadataAuthority,
  type NavigationMenuItemRow,
} from "~/lib/api-functions/navigation-authority";
import { queryKeys } from "~/lib/query-keys";

import { NavigationAuthorityMoveDialog } from "./NavigationAuthorityMoveDialog";
import { NavigationHistorySheet } from "./NavigationHistorySheet";
import { NavigationLocationsFields } from "./NavigationLocationsFields";
import { NavigationMenuItemDialog } from "./NavigationMenuItemDialog";
import {
  MenuRow,
  NavigationMenuTree,
  type MoveDestination,
} from "./NavigationMenuTree";
import {
  describeItemDeletion,
  getMenuPublishState,
} from "./navigation-authority-model";

export interface NavigationMenuEditorProps {
  menuId: string;
  /** `"history"` opens the history sheet; `"placements"` scrolls to locations. */
  panel: "items" | "placements" | "history";
  query: string;
  itemId?: string;
  parentId?: string;
  onBackToMenus: () => void;
  onPanelChange: (panel: "items" | "placements" | "history") => void;
  onQueryChange: (query: string) => void;
  onItemChange: (itemId?: string, parentId?: string) => void;
}

const MIN_SEARCH_LENGTH = 2;

interface PendingDelete {
  item: NavigationMenuItemRow;
  childCount: number;
}

/**
 * One menu: its name, its item tree, where it appears on the storefront, and
 * what has been published.
 *
 * Item edits are saved immediately against the menu revision; publishing is the
 * separate step that moves them to the storefront. That is why the save bar
 * says draft changes are not published rather than not saved.
 */
export function NavigationMenuEditor({
  menuId,
  panel,
  query,
  itemId,
  parentId,
  onBackToMenus,
  onPanelChange,
  onQueryChange,
  onItemChange,
}: NavigationMenuEditorProps) {
  const queryClient = useQueryClient();
  const fieldId = useId();
  const locationsRef = useRef<HTMLDivElement | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingHandle, setEditingHandle] = useState(false);
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [showNameError, setShowNameError] = useState(false);
  const [moveDialogItem, setMoveDialogItem] = useState<NavigationMenuItemRow | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [addParent, setAddParent] = useState<{ id: string | null; label?: string } | null>(null);

  const menuQuery = useQuery({
    queryKey: queryKeys.navigation.menu(menuId),
    queryFn: () => getNavigationMenuAuthority({ data: { menuId } }),
  });
  const menusQuery = useQuery({
    queryKey: queryKeys.navigation.menus(),
    queryFn: () => getNavigationMenusAuthority({ data: { limit: 100 } }),
  });
  const menu = menuQuery.data?.menu;
  const menusById = useMemo(
    () => new Map((menusQuery.data?.items ?? []).map((row) => [row.id, row.name])),
    [menusQuery.data?.items],
  );

  const savedName = menu?.name;
  const savedHandle = menu?.handle;
  // Track the saved values, not the menu object: a refetch that changes nothing
  // must not clobber what the operator is typing in the title or handle field.
  useEffect(() => {
    if (savedName === undefined || savedHandle === undefined) return;
    setName(savedName);
    setHandle(savedHandle);
  }, [savedName, savedHandle]);

  useEffect(() => {
    if (panel !== "placements") return;
    locationsRef.current?.scrollIntoView({ block: "start" });
  }, [panel]);

  const invalidateMenu = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.navigation.menus() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.navigation.menu(menuId) }),
    ]);
  }, [queryClient, menuId]);

  const searchQuery = useQuery({
    queryKey: [...queryKeys.navigation.menu(menuId), "search", query],
    queryFn: () =>
      searchNavigationMenuItemsAuthority({ data: { menuId, query, limit: 100 } }),
    enabled: query.trim().length >= MIN_SEARCH_LENGTH,
  });

  const moveMutation = useMutation({
    mutationFn: ({
      itemId: movingItemId,
      destination,
    }: {
      itemId: string;
      destination: MoveDestination;
    }) => {
      if (!menu) throw new Error("Menu is unavailable.");
      return moveNavigationMenuItemAuthority({
        data: { menuId: menu.id, itemId: movingItemId, expectedRevision: menu.revision, ...destination },
      });
    },
    onSuccess: () => {
      toast.success("Menu item moved");
      setMoveDialogItem(null);
      void invalidateMenu();
    },
    onError: (error) =>
      toast.error("Menu item was not moved", {
        description: getServerFnError(error, "Menu item was not moved"),
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: (target: PendingDelete) => {
      if (!menu) throw new Error("Menu is unavailable.");
      return deleteNavigationMenuItemAuthority({
        data: { menuId: menu.id, itemId: target.item.id, expectedRevision: menu.revision },
      });
    },
    onSuccess: (result) => {
      toast.success(
        result.deletedCount > 1
          ? `${result.deletedCount} menu items removed`
          : "Menu item removed",
      );
      setPendingDelete(null);
      void invalidateMenu();
    },
    onError: (error) =>
      toast.error("Menu item was not removed", {
        description: getServerFnError(error, "Menu item was not removed"),
      }),
  });

  const publishMutation = useMutation({
    mutationFn: () => {
      if (!menu) throw new Error("Menu is unavailable.");
      return publishNavigationMenuAuthority({
        data: { menuId: menu.id, expectedRevision: menu.revision },
      });
    },
    onSuccess: () => {
      toast.success("Menu published", { description: "Storefront navigation is refreshing." });
      void invalidateMenu();
      void queryClient.invalidateQueries({ queryKey: queryKeys.navigation.publications(menuId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.navigation.placements() });
    },
    onError: (error) =>
      toast.error("Menu was not published", {
        description: getServerFnError(error, "Menu was not published"),
      }),
  });

  const discardMutation = useMutation({
    mutationFn: () => {
      if (!menu || menu.publishedRevision == null) {
        throw new Error("This menu has no published version to restore.");
      }
      return rollbackNavigationMenuAuthority({
        data: {
          menuId: menu.id,
          expectedRevision: menu.revision,
          sourceRevision: menu.publishedRevision,
        },
      });
    },
    onSuccess: () => {
      toast.success("Draft changes discarded", {
        description: "The published menu was restored.",
      });
      setConfirmDiscard(false);
      void invalidateMenu();
      void queryClient.invalidateQueries({ queryKey: queryKeys.navigation.publications(menuId) });
    },
    onError: (error) =>
      toast.error("Draft changes were not discarded", {
        description: getServerFnError(error, "Draft changes were not discarded"),
      }),
  });

  const renameMutation = useMutation({
    mutationFn: () => {
      if (!menu) throw new Error("Menu is unavailable.");
      return updateNavigationMenuMetadataAuthority({
        data: { menuId: menu.id, expectedRevision: menu.revision, name, handle },
      });
    },
    onSuccess: () => {
      toast.success("Menu details updated");
      setEditingTitle(false);
      setEditingHandle(false);
      setShowNameError(false);
      void invalidateMenu();
    },
    onError: (error) =>
      toast.error("Menu details were not saved", {
        description: getServerFnError(error, "Menu details were not saved"),
      }),
  });

  const breadcrumbLink = useMemo(() => {
    function NavigationBreadcrumbLink({ href, className, children }: PageHeaderLinkProps) {
      return (
        <a
          href={href}
          className={className}
          onClick={(event) => {
            event.preventDefault();
            onBackToMenus();
          }}
        >
          {children}
        </a>
      );
    }
    return NavigationBreadcrumbLink;
  }, [onBackToMenus]);

  const searchRows = useMemo(() => {
    const rows = searchQuery.data?.items ?? [];
    const byId = new Map(rows.map((row) => [row.item.id, row]));
    const depthOf = (item: NavigationMenuItemRow): number => {
      let depth = 0;
      let current = item.parentId ? byId.get(item.parentId)?.item : undefined;
      while (current && depth < 2) {
        depth += 1;
        current = current.parentId ? byId.get(current.parentId)?.item : undefined;
      }
      return depth;
    };
    return [...rows]
      .sort((left, right) =>
        depthOf(left.item) - depthOf(right.item)
        || left.item.position - right.item.position
        || left.item.id.localeCompare(right.item.id))
      .map((row) => ({ ...row, depth: depthOf(row.item) }));
  }, [searchQuery.data?.items]);

  if (menuQuery.isLoading) {
    return <SkeletonPage label="Loading menu" sections={2} />;
  }

  if (menuQuery.isError || !menu) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Navigation"
          breadcrumbs={[{ label: "Navigation", href: "/admin/navigation" }, { label: "Menu" }]}
          linkComponent={breadcrumbLink}
        />
        <EmptyState
          heading="This menu could not be loaded"
          body="It may have been moved to trash. Go back to the menus list and try again."
          action={{ label: "Back to menus", onClick: onBackToMenus }}
          secondaryAction={{ label: "Retry", onClick: () => void menuQuery.refetch() }}
        />
      </div>
    );
  }

  const loadedMenu = menu;
  const publishState = getMenuPublishState(loadedMenu);
  const searching = query.trim().length >= MIN_SEARCH_LENGTH;
  // Every outstanding publication gets the bar; only a menu with a live version
  // can discard back to one.
  const showSaveBar = publishState.hasDraftChanges;
  const nameError = !name.trim() ? "Enter a name so you can find this menu later." : null;

  function startTitleEdit() {
    setShowNameError(false);
    setName(loadedMenu.name);
    setEditingTitle(true);
  }

  function cancelTitleEdit() {
    setEditingTitle(false);
    setShowNameError(false);
    setName(loadedMenu.name);
  }

  function saveTitle() {
    if (nameError) {
      setShowNameError(true);
      return;
    }
    renameMutation.mutate();
  }

  const secondaryActions: PageHeaderAction[] = [
    {
      id: "handle",
      label: editingHandle ? "Close handle" : "Edit handle",
      icon: Hash,
      onClick: () => {
        setHandle(menu.handle);
        setEditingHandle((current) => !current);
      },
    },
    {
      id: "history",
      label: "History",
      icon: History,
      onClick: () => onPanelChange("history"),
    },
    {
      id: "trash",
      label: "Move to trash",
      icon: Trash2,
      onClick: () => setConfirmTrash(true),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title={menu.name}
        renderTitle={editingTitle
          ? ({ id }) => (
              <form
                method="post"
                className="flex min-w-0 flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveTitle();
                }}
              >
                {/* The header is named by its heading, so it stays in the DOM
                    while the input has the focus. */}
                <h1 id={id} className="sr-only">{menu.name}</h1>
                <Input
                  aria-label="Menu name"
                  className="h-11 w-full min-w-0 max-w-xs text-lg font-semibold sm:h-9"
                  value={name}
                  maxLength={100}
                  autoFocus
                  aria-invalid={showNameError && Boolean(nameError)}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") cancelTitleEdit();
                  }}
                />
                <Button
                  type="submit"
                  className="min-h-11 sm:min-h-9"
                  disabled={renameMutation.isPending}
                >
                  {renameMutation.isPending ? "Saving" : "Save"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11 sm:min-h-9"
                  onClick={cancelTitleEdit}
                >
                  Cancel
                </Button>
                {showNameError && nameError ? <FieldError>{nameError}</FieldError> : null}
              </form>
            )
          : undefined}
        titleSlot={editingTitle ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Rename menu"
            className="size-11 shrink-0 text-muted-foreground sm:size-9"
            onClick={startTitleEdit}
          >
            <Pencil className="size-4" aria-hidden />
          </Button>
        )}
        status={(
          <>
            <StatusBadge tone={publishState.badgeTone} srLabel="Publish status:">
              {publishState.badgeLabel}
            </StatusBadge>
            <span className="truncate">{menu.handle}</span>
          </>
        )}
        breadcrumbs={[{ label: "Navigation", href: "/admin/navigation" }, { label: menu.name }]}
        linkComponent={breadcrumbLink}
        secondaryActions={secondaryActions}
        inlineActionCount={1}
        primaryAction={
          showSaveBar
            ? undefined
            : {
                id: "publish",
                label: publishMutation.isPending ? "Publishing" : "Publish",
                icon: Send,
                disabled: !publishState.hasDraftChanges || publishMutation.isPending,
                disabledReason: "Everything in this menu is already published.",
                onClick: () => publishMutation.mutate(),
              }
        }
      />

      {showSaveBar ? (
        <ContextualSaveBar
          isDirty
          // Item edits are already persisted server-side; only publishing is
          // outstanding, so leaving the page loses nothing and must not prompt.
          blockNavigation={false}
          // A menu that was never published has no live version to fall back
          // to, so the bar offers Publish alone rather than a dead Discard.
          hideDiscard={!publishState.canDiscardDraft}
          message={publishState.isUnpublished
            ? "This menu is not published yet"
            : "Draft changes are not published yet"}
          saveLabel="Publish"
          discardLabel="Discard draft"
          saving={publishMutation.isPending || discardMutation.isPending}
          onSave={() => publishMutation.mutate()}
          onDiscard={() => setConfirmDiscard(true)}
        >
          <InlineHelp>
            {publishState.isUnpublished
              ? "Nothing of this menu is on the storefront yet."
              : `Customers still see revision ${menu.publishedRevision}.`}
          </InlineHelp>
        </ContextualSaveBar>
      ) : null}

      {editingHandle ? (
        <SettingsSection
          title="Menu handle"
          description="Themes and integrations reference the menu by its handle. Customers never see it."
        >
          <div className="space-y-1.5 sm:max-w-sm">
            <Label htmlFor={`${fieldId}-handle`}>Handle</Label>
            <Input
              id={`${fieldId}-handle`}
              className="min-h-11 sm:min-h-9"
              value={handle}
              maxLength={80}
              autoFocus
              onChange={(event) => setHandle(event.target.value)}
            />
          </div>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 sm:min-h-9"
              onClick={() => {
                setEditingHandle(false);
                setHandle(menu.handle);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="min-h-11 sm:min-h-9"
              disabled={renameMutation.isPending}
              onClick={() => renameMutation.mutate()}
            >
              {renameMutation.isPending ? "Saving" : "Save handle"}
            </Button>
          </div>
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="Menu items"
        description="Drag an item onto another to nest it, or use the item menu to move it by keyboard."
        contentClassName="p-0 sm:p-0"
        actions={
          <div className="relative w-full sm:w-72">
            <label htmlFor={`${fieldId}-search`} className="sr-only">
              Search menu items
            </label>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id={`${fieldId}-search`}
              type="search"
              value={query}
              placeholder="Search menu items"
              className="min-h-11 pl-9 sm:min-h-9"
              onChange={(event) => onQueryChange(event.target.value)}
            />
          </div>
        }
      >
        {searching ? (
          <div className="p-2" data-testid="navigation-search-results">
            <p className="px-2 pb-2 text-xs text-muted-foreground">
              Clear search to arrange items.
            </p>
            {searchQuery.isLoading ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground" role="status">
                Searching
              </p>
            ) : searchRows.length ? (
              searchRows.map(({ item, childCount, isMatch, depth }) => (
                <MenuRow
                  key={item.id}
                  item={item}
                  childCount={childCount}
                  depth={depth}
                  expanded={false}
                  activeDragId={null}
                  isSearchMatch={isMatch}
                  dragEnabled={false}
                  onToggle={() => undefined}
                  onEdit={() => onItemChange(item.id)}
                  onAddChild={() => {
                    setAddParent({ id: item.id, label: item.label });
                    onItemChange("new", item.id);
                  }}
                  onOpenMove={() => setMoveDialogItem(item)}
                  onDelete={() => setPendingDelete({ item, childCount })}
                  onMove={() => undefined}
                />
              ))
            ) : (
              <EmptyState
                compact
                bordered={false}
                icon={Search}
                heading="No menu items match that search"
                body="Try part of an item label."
                action={{ label: "Clear search", onClick: () => onQueryChange("") }}
              />
            )}
          </div>
        ) : (
          <NavigationMenuTree
            menuId={menu.id}
            revision={menu.revision}
            onEdit={(id) => onItemChange(id)}
            onAddChild={(nextParentId, parentLabel) => {
              setAddParent({ id: nextParentId, label: parentLabel });
              onItemChange("new", nextParentId ?? undefined);
            }}
            onOpenMove={setMoveDialogItem}
            onDelete={(item, childCount) => setPendingDelete({ item, childCount })}
            onMove={(id, destination) => moveMutation.mutate({ itemId: id, destination })}
          />
        )}
      </SettingsSection>

      <div ref={locationsRef}>
        <SettingsSection
          id="navigation-locations"
          title="Where this menu appears"
          description="Pick the storefront slots that should show this menu. A slot shows one menu at a time."
        >
          <NavigationLocationsFields
            menu={menu}
            menusById={menusById}
            onChanged={() => void invalidateMenu()}
          />
        </SettingsSection>
      </div>

      <NavigationHistorySheet
        menu={menu}
        open={panel === "history"}
        onOpenChange={(open) => {
          if (!open) onPanelChange("items");
        }}
        onRestored={() => {
          onPanelChange("items");
          void invalidateMenu();
        }}
      />

      {itemId ? (
        <NavigationMenuItemDialog
          menu={menu}
          itemId={itemId}
          parentId={parentId}
          parentLabel={addParent?.id === (parentId ?? null) ? addParent?.label : undefined}
          onClose={() => {
            setAddParent(null);
            onItemChange(undefined);
          }}
          onSaved={() => {
            setAddParent(null);
            onItemChange(undefined);
            void invalidateMenu();
          }}
        />
      ) : null}

      {moveDialogItem ? (
        <NavigationAuthorityMoveDialog
          open
          menu={menu}
          item={moveDialogItem}
          moving={moveMutation.isPending}
          onOpenChange={(open) => {
            if (!open) setMoveDialogItem(null);
          }}
          onMove={(destination) =>
            moveMutation.mutate({ itemId: moveDialogItem.id, destination })}
        />
      ) : null}

      <AlertDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this menu item?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? describeItemDeletion(pendingDelete.item.label, pendingDelete.childCount)
                : null}{" "}
              Publish the menu to apply it to the storefront.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep item</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (pendingDelete) deleteMutation.mutate(pendingDelete);
              }}
            >
              {deleteMutation.isPending ? "Removing" : "Remove item"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard draft changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Revision {menu.publishedRevision} is restored and published again, and the draft
              edits made since then are lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={discardMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                discardMutation.mutate();
              }}
            >
              {discardMutation.isPending ? "Discarding" : "Discard changes"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <MenuTrashConfirm
        menu={menu}
        open={confirmTrash}
        onOpenChange={setConfirmTrash}
        onTrashed={() => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.navigation.menus() });
          void queryClient.invalidateQueries({ queryKey: queryKeys.navigation.placements() });
          onBackToMenus();
        }}
      />
    </div>
  );
}

function MenuTrashConfirm({
  menu,
  open,
  onOpenChange,
  onTrashed,
}: {
  menu: { id: string; name: string; revision: number; placementCount: number };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTrashed: () => void;
}) {
  const mutation = useMutation({
    mutationFn: () =>
      trashNavigationMenuAuthority({
        data: { menuId: menu.id, expectedRevision: menu.revision },
      }),
    onSuccess: () => {
      toast.success("Menu moved to trash", {
        description: "Items and publication history were kept.",
      });
      onOpenChange(false);
      onTrashed();
    },
    onError: (error) =>
      toast.error("Menu was not moved to trash", {
        description: getServerFnError(error, "Menu was not moved to trash"),
      }),
  });
  const blocked = menu.placementCount > 0;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Move "{menu.name}" to trash?</AlertDialogTitle>
          <AlertDialogDescription>
            {blocked
              ? `Remove it from ${menu.placementCount} storefront ${
                  menu.placementCount === 1 ? "location" : "locations"
                } first, then try again.`
              : "Items and publication history can be restored later."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep menu</AlertDialogCancel>
          {blocked ? null : (
            <AlertDialogAction
              variant="destructive"
              disabled={mutation.isPending}
              className={cn(mutation.isPending && "pointer-events-none")}
              onClick={(event) => {
                event.preventDefault();
                mutation.mutate();
              }}
            >
              {mutation.isPending ? "Moving" : "Move to trash"}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default NavigationMenuEditor;
