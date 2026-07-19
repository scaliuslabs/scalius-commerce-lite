import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type CollisionDetection,
} from "@dnd-kit/core";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Ellipsis,
  GripVertical,
  History,
  Link2,
  ListTree,
  MapPin,
  Pencil,
  Plus,
  Search,
  Send,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { getServerFnError } from "~/lib/api-helpers";
import { getNavigationItems } from "~/lib/api-functions/navigation";
import {
  createNavigationMenuAuthority,
  createNavigationMenuItemAuthority,
  deleteNavigationMenuItemAuthority,
  getNavigationMenuAuthority,
  getNavigationMenuItemAuthority,
  getNavigationMenuItemPage,
  getNavigationMenusAuthority,
  getNavigationPlacementSettings,
  getNavigationPublications,
  publishNavigationMenuAuthority,
  rollbackNavigationMenuAuthority,
  saveNavigationPlacementAuthority,
  searchNavigationMenuItemsAuthority,
  updateNavigationMenuItemAuthority,
  updateNavigationMenuMetadataAuthority,
  moveNavigationMenuItemAuthority,
  type NavigationItemDraft,
  type NavigationMenuItemRow,
  type NavigationMenuSummary,
  type NavigationPlacementSetting,
} from "~/lib/api-functions/navigation-authority";
import { queryKeys } from "~/lib/query-keys";

export type NavigationWorkspacePanel = "items" | "placements" | "history";

interface NavigationWorkspaceProps {
  selectedMenuId?: string;
  panel: NavigationWorkspacePanel;
  query: string;
  itemId?: string;
  parentId?: string;
  onMenuChange: (menuId: string) => void;
  onPanelChange: (panel: NavigationWorkspacePanel) => void;
  onQueryChange: (query: string) => void;
  onItemChange: (itemId?: string, parentId?: string) => void;
}

interface MoveDestination {
  parentId: string | null;
  beforeId?: string;
  afterId?: string;
}

const SYSTEM_DESTINATIONS = [
  ["home", "Home"],
  ["catalog", "Catalog"],
  ["search", "Search"],
  ["account", "Customer account"],
  ["cart", "Cart"],
  ["checkout", "Checkout"],
  ["order_lookup", "Order lookup"],
] as const;

const TARGET_LABELS: Record<NavigationMenuItemRow["targetType"], string> = {
  label: "Heading",
  system: "Store page",
  page: "Page",
  category: "Category",
  collection: "Collection",
  product: "Product",
  internal_path: "Store path",
  external_url: "Web address",
};

function mutationError(error: unknown, fallback: string) {
  toast.error(fallback, { description: getServerFnError(error, fallback) });
}

function formatDate(value: string | number) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown date"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function destinationSummary(item: NavigationMenuItemRow) {
  if (item.targetType === "label") return "Heading";
  if (item.targetType === "system") {
    return SYSTEM_DESTINATIONS.find(([key]) => key === item.targetValue)?.[1] ?? "Store page";
  }
  if (item.targetType === "internal_path" || item.targetType === "external_url") {
    return item.targetValue ?? TARGET_LABELS[item.targetType];
  }
  return `${TARGET_LABELS[item.targetType]} · ${item.targetId ?? "Unavailable"}`;
}

const treeCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length ? pointerCollisions : closestCenter(args);
};

function RowDropZones({
  item,
  active,
}: {
  item: NavigationMenuItemRow;
  active: boolean;
}) {
  const before = useDroppable({
    id: `before:${item.id}`,
    data: {
      destination: { parentId: item.parentId, beforeId: item.id } satisfies MoveDestination,
      targetId: item.id,
      mode: "before",
    },
    disabled: !active,
  });
  const inside = useDroppable({
    id: `inside:${item.id}`,
    data: {
      destination: { parentId: item.id } satisfies MoveDestination,
      targetId: item.id,
      mode: "inside",
    },
    disabled: !active,
  });
  const after = useDroppable({
    id: `after:${item.id}`,
    data: {
      destination: { parentId: item.parentId, afterId: item.id } satisfies MoveDestination,
      targetId: item.id,
      mode: "after",
    },
    disabled: !active,
  });

  return (
    <div className={cn("pointer-events-none absolute inset-0 z-20", !active && "hidden")} aria-hidden>
      <div ref={before.setNodeRef} className="absolute inset-x-0 top-0 h-1/4">
        {before.isOver && (
          <div className="absolute inset-x-2 top-0 h-0.5 rounded-full bg-primary shadow-[0_0_0_1px_hsl(var(--background))]">
            <span className="absolute -left-0.5 -top-[3px] size-2 rounded-full bg-primary" />
          </div>
        )}
      </div>
      <div ref={inside.setNodeRef} className="absolute inset-x-0 top-1/4 h-1/2">
        {inside.isOver && (
          <div className="absolute inset-0 rounded-lg border-2 border-primary bg-primary/10" />
        )}
      </div>
      <div ref={after.setNodeRef} className="absolute inset-x-0 bottom-0 h-1/4">
        {after.isOver && (
          <div className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary shadow-[0_0_0_1px_hsl(var(--background))]">
            <span className="absolute -left-0.5 -top-[3px] size-2 rounded-full bg-primary" />
          </div>
        )}
      </div>
    </div>
  );
}

interface MenuRowProps {
  item: NavigationMenuItemRow;
  childCount: number;
  depth: number;
  expanded: boolean;
  activeDragId: string | null;
  isSearchMatch?: boolean;
  dragEnabled?: boolean;
  previous?: NavigationMenuItemRow;
  next?: NavigationMenuItemRow;
  parent?: NavigationMenuItemRow;
  onToggle: () => void;
  onEdit: () => void;
  onAddChild: () => void;
  onMove: (destination: MoveDestination) => void;
}

function MenuRow({
  item,
  childCount,
  depth,
  expanded,
  activeDragId,
  isSearchMatch,
  dragEnabled = true,
  previous,
  next,
  parent,
  onToggle,
  onEdit,
  onAddChild,
  onMove,
}: MenuRowProps) {
  const draggable = useDraggable({ id: `item:${item.id}`, data: { item }, disabled: !dragEnabled });
  const isDragging = activeDragId === item.id;
  const dragActive = Boolean(activeDragId) && !isDragging;
  const style = { "--menu-depth": depth } as CSSProperties;
  const draggedRowStyle = draggable.transform
    ? {
        transform: `translate3d(${draggable.transform.x}px, ${draggable.transform.y}px, 0)`,
      }
    : undefined;

  return (
    <div className="relative py-0.5" style={style}>
      <div
        style={draggedRowStyle}
        className={cn(
          "group flex min-h-12 items-center gap-1.5 rounded-lg border border-transparent px-2 transition-colors",
          "hover:border-border hover:bg-muted/45",
          isDragging && "pointer-events-none relative z-30 border-primary bg-background opacity-40 shadow-lg",
          !item.isEnabled && "opacity-60",
          isSearchMatch && "bg-primary/5",
        )}
      >
        <div className="w-[calc(var(--menu-depth)*1.125rem)] shrink-0" aria-hidden />
        {childCount ? (
          <button
            type="button"
            className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onToggle}
            aria-label={expanded ? `Collapse ${item.label}` : `Expand ${item.label}`}
          >
            {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        ) : (
          <div className="size-8 shrink-0" aria-hidden />
        )}
        {dragEnabled ? (
          <button
            ref={draggable.setNodeRef}
            type="button"
            className="grid size-9 shrink-0 touch-none place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`Drag ${item.label}`}
            {...draggable.attributes}
            {...draggable.listeners}
          >
            <GripVertical className="size-4" />
          </button>
        ) : (
          <div className="grid size-9 shrink-0 place-items-center text-muted-foreground">
            <Search className="size-3.5" />
          </div>
        )}
        <button
          type="button"
          onClick={onEdit}
          className="min-w-0 flex-1 py-2 text-left"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{item.label}</span>
            {item.labelMode === "resource" && (
              <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-medium">Follows source</Badge>
            )}
            {!item.isEnabled && (
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-medium">Hidden</Badge>
            )}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {destinationSummary(item)}
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-9 shrink-0" aria-label={`Actions for ${item.label}`}>
              <Ellipsis className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil className="mr-2 size-4" /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onAddChild} disabled={depth >= 3}>
              <Plus className="mr-2 size-4" /> Add child
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!previous}
              onSelect={() => previous && onMove({ parentId: item.parentId, beforeId: previous.id })}
            >
              Move earlier
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!next}
              onSelect={() => next && onMove({ parentId: item.parentId, afterId: next.id })}
            >
              Move later
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!previous || depth >= 3}
              onSelect={() => previous && onMove({ parentId: previous.id })}
            >
              Nest under previous
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!parent}
              onSelect={() => parent && onMove({ parentId: parent.parentId, afterId: parent.id })}
            >
              Move up a level
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <RowDropZones item={item} active={dragActive} />
    </div>
  );
}

interface MenuLevelProps {
  menuId: string;
  parentId: string | null;
  parent?: NavigationMenuItemRow;
  depth: number;
  revision: number;
  expandedIds: Set<string>;
  activeDragId: string | null;
  onToggle: (itemId: string) => void;
  onEdit: (itemId: string) => void;
  onAddChild: (parentId: string) => void;
  onMove: (itemId: string, destination: MoveDestination) => void;
}

function MenuLevel({
  menuId,
  parentId,
  parent,
  depth,
  revision,
  expandedIds,
  activeDragId,
  onToggle,
  onEdit,
  onAddChild,
  onMove,
}: MenuLevelProps) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.navigation.menuItems(menuId, parentId),
    queryFn: ({ pageParam }) => getNavigationMenuItemPage({
      data: { menuId, parentId, cursor: pageParam, limit: 100 },
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];

  if (query.isLoading) {
    return <div className="px-4 py-3 text-sm text-muted-foreground">Loading menu…</div>;
  }
  if (query.isError) {
    return (
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-destructive">
        <span>This section could not be loaded.</span>
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>Retry</Button>
      </div>
    );
  }
  if (!rows.length && depth === 0) {
    return (
      <div className="grid min-h-48 place-items-center px-6 text-center">
        <div>
          <ListTree className="mx-auto mb-3 size-6 text-muted-foreground" />
          <p className="text-sm font-medium">This menu is empty</p>
          <p className="mt-1 text-xs text-muted-foreground">Add the first customer-facing destination.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {rows.map(({ item, childCount }, index) => {
        const previous = rows[index - 1]?.item;
        const next = rows[index + 1]?.item;
        const expanded = expandedIds.has(item.id);
        return (
          <div key={`${item.id}:${revision}`}>
            <MenuRow
              item={item}
              childCount={childCount}
              depth={depth}
              expanded={expanded}
              activeDragId={activeDragId}
              previous={previous}
              next={next}
              parent={parent}
              onToggle={() => onToggle(item.id)}
              onEdit={() => onEdit(item.id)}
              onAddChild={() => onAddChild(item.id)}
              onMove={(destination) => onMove(item.id, destination)}
            />
            {expanded && childCount > 0 && depth < 2 && (
              <MenuLevel
                menuId={menuId}
                parentId={item.id}
                parent={item}
                depth={depth + 1}
                revision={revision}
                expandedIds={expandedIds}
                activeDragId={activeDragId}
                onToggle={onToggle}
                onEdit={onEdit}
                onAddChild={onAddChild}
                onMove={onMove}
              />
            )}
          </div>
        );
      })}
      {query.hasNextPage && (
        <div className="px-3 py-2" style={{ paddingLeft: `${depth * 18 + 12}px` }}>
          <Button
            size="sm"
            variant="ghost"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load 100 more"}
          </Button>
        </div>
      )}
    </div>
  );
}

function itemRowToDraft(item: NavigationMenuItemRow): NavigationItemDraft {
  const base = {
    label: item.label,
    labelMode: item.labelMode,
    openInNewTab: item.openInNewTab,
    isEnabled: item.isEnabled,
  } as const;
  if (["page", "category", "collection", "product"].includes(item.targetType)) {
    return {
      ...base,
      target: {
        type: "resource",
        resourceType: item.targetType as "page" | "category" | "collection" | "product",
        resourceId: item.targetId ?? "",
        ...(item.targetQuery ? { query: item.targetQuery } : {}),
      },
    };
  }
  if (item.targetType === "system") {
    return {
      ...base,
      labelMode: "custom",
      target: {
        type: "system",
        key: (item.targetValue ?? "home") as Extract<NavigationItemDraft["target"], { type: "system" }>["key"],
      },
    };
  }
  if (item.targetType === "internal_path") {
    return { ...base, labelMode: "custom", target: { type: "internal_path", path: item.targetValue ?? "/" } };
  }
  if (item.targetType === "external_url") {
    return { ...base, labelMode: "custom", target: { type: "external_url", url: item.targetValue ?? "https://" } };
  }
  return { ...base, labelMode: "custom", target: { type: "label" } };
}

function MenuItemDialog({
  menu,
  itemId,
  parentId,
  onClose,
  onSaved,
}: {
  menu: NavigationMenuSummary;
  itemId: string;
  parentId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = itemId !== "new";
  const itemQuery = useQuery({
    queryKey: [...queryKeys.navigation.menu(menu.id), "item", itemId],
    queryFn: () => getNavigationMenuItemAuthority({ data: { menuId: menu.id, itemId } }),
    enabled: editing,
  });
  const sourcesQuery = useQuery({
    queryKey: queryKeys.navigation.items(),
    queryFn: () => getNavigationItems(),
    staleTime: 5 * 60_000,
  });
  const [draft, setDraft] = useState<NavigationItemDraft>({
    label: "",
    labelMode: "custom",
    target: { type: "internal_path", path: "/" },
    openInNewTab: false,
    isEnabled: true,
  });
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (itemQuery.data?.item) setDraft(itemRowToDraft(itemQuery.data.item));
  }, [itemQuery.data?.item]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (editing) {
        return updateNavigationMenuItemAuthority({
          data: {
            ...draft,
            menuId: menu.id,
            itemId,
            expectedRevision: menu.revision,
          },
        });
      }
      return createNavigationMenuItemAuthority({
        data: {
          ...draft,
          menuId: menu.id,
          expectedRevision: menu.revision,
          parentId: parentId ?? null,
        },
      });
    },
    onSuccess: () => {
      toast.success(editing ? "Menu item updated" : "Menu item added");
      onSaved();
    },
    onError: (error) => mutationError(error, "Menu item was not saved"),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteNavigationMenuItemAuthority({
      data: { menuId: menu.id, itemId, expectedRevision: menu.revision },
    }),
    onSuccess: (result) => {
      toast.success(result.deletedCount > 1 ? `${result.deletedCount} menu items removed` : "Menu item removed");
      onSaved();
    },
    onError: (error) => mutationError(error, "Menu item was not removed"),
  });

  const targetType = draft.target.type === "resource" ? draft.target.resourceType : draft.target.type;
  const sources = sourcesQuery.data?.items;
  const sourceKeyByType = {
    page: "pages",
    category: "categories",
    collection: "collections",
    product: "products",
  } as const;
  const resourceOptions = draft.target.type === "resource"
    ? sources?.[sourceKeyByType[draft.target.resourceType]] ?? []
    : [];
  const selectedResourceId = draft.target.type === "resource"
    ? draft.target.resourceId
    : "";

  const changeTargetType = (value: string) => {
    if (["page", "category", "collection", "product"].includes(value)) {
      setDraft((current) => ({
        ...current,
        labelMode: "resource",
        target: {
          type: "resource",
          resourceType: value as "page" | "category" | "collection" | "product",
          resourceId: "",
        },
      }));
      return;
    }
    if (value === "system") {
      setDraft((current) => ({ ...current, labelMode: "custom", target: { type: "system", key: "home" } }));
    } else if (value === "external_url") {
      setDraft((current) => ({ ...current, labelMode: "custom", target: { type: "external_url", url: "https://" } }));
    } else if (value === "label") {
      setDraft((current) => ({ ...current, labelMode: "custom", target: { type: "label" } }));
    } else {
      setDraft((current) => ({ ...current, labelMode: "custom", target: { type: "internal_path", path: "/" } }));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit menu item" : "Add menu item"}</DialogTitle>
          <DialogDescription>Choose the label and where it should take customers.</DialogDescription>
        </DialogHeader>
        {editing && itemQuery.isLoading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">Loading item…</div>
        ) : (
          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="navigation-item-label">Label</Label>
              <Input
                id="navigation-item-label"
                value={draft.label}
                maxLength={100}
                autoFocus
                onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Destination</Label>
                <Select value={targetType} onValueChange={changeTargetType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">Store page</SelectItem>
                    <SelectItem value="category">Category</SelectItem>
                    <SelectItem value="collection">Collection</SelectItem>
                    <SelectItem value="product">Product</SelectItem>
                    <SelectItem value="page">Page</SelectItem>
                    <SelectItem value="internal_path">Store path</SelectItem>
                    <SelectItem value="external_url">Web address</SelectItem>
                    <SelectItem value="label">Heading only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {draft.target.type === "resource" && (
                <div className="space-y-1.5">
                  <Label>Label source</Label>
                  <Select
                    value={draft.labelMode}
                    onValueChange={(value: "custom" | "resource") => setDraft((current) => ({ ...current, labelMode: value }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="resource">Follow source title</SelectItem>
                      <SelectItem value="custom">Keep custom label</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {draft.target.type === "resource" && (
              <>
                <div className="space-y-1.5">
                  <Label>Resource</Label>
                  <Select
                    value={selectedResourceId}
                    onValueChange={(resourceId) => setDraft((current) => current.target.type === "resource"
                      ? { ...current, target: { ...current.target, resourceId } }
                      : current)}
                  >
                    <SelectTrigger><SelectValue placeholder="Choose resource" /></SelectTrigger>
                    <SelectContent>
                      {selectedResourceId && !resourceOptions.some((option) => option.id === selectedResourceId) && (
                        <SelectItem value={selectedResourceId}>{selectedResourceId}</SelectItem>
                      )}
                      {resourceOptions.map((option) => (
                        <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="navigation-item-query">Optional query</Label>
                  <Input
                    id="navigation-item-query"
                    placeholder="?sort=newest"
                    value={draft.target.query ?? ""}
                    onChange={(event) => setDraft((current) => current.target.type === "resource"
                      ? { ...current, target: { ...current.target, query: event.target.value } }
                      : current)}
                  />
                </div>
              </>
            )}
            {draft.target.type === "system" && (
              <div className="space-y-1.5">
                <Label>Store page</Label>
                <Select
                  value={draft.target.key}
                  onValueChange={(key: Extract<NavigationItemDraft["target"], { type: "system" }>["key"]) =>
                    setDraft((current) => ({ ...current, target: { type: "system", key } }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SYSTEM_DESTINATIONS.map(([key, label]) => (
                      <SelectItem key={key} value={key}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {draft.target.type === "internal_path" && (
              <div className="space-y-1.5">
                <Label htmlFor="navigation-item-path">Store path</Label>
                <Input
                  id="navigation-item-path"
                  placeholder="/search"
                  value={draft.target.path}
                  onChange={(event) => setDraft((current) => ({ ...current, target: { type: "internal_path", path: event.target.value } }))}
                />
              </div>
            )}
            {draft.target.type === "external_url" && (
              <div className="space-y-1.5">
                <Label htmlFor="navigation-item-url">HTTPS address</Label>
                <Input
                  id="navigation-item-url"
                  inputMode="url"
                  value={draft.target.url}
                  onChange={(event) => setDraft((current) => ({ ...current, target: { type: "external_url", url: event.target.value } }))}
                />
              </div>
            )}

            <div className="grid gap-2 rounded-lg border p-3">
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>Visible in menu</span>
                <Switch
                  checked={draft.isEnabled !== false}
                  onCheckedChange={(isEnabled) => setDraft((current) => ({ ...current, isEnabled }))}
                />
              </label>
              {draft.target.type !== "label" && (
                <label className="flex items-center justify-between gap-4 border-t pt-2 text-sm">
                  <span>Open in new tab</span>
                  <Switch
                    checked={draft.openInNewTab === true}
                    onCheckedChange={(openInNewTab) => setDraft((current) => ({ ...current, openInNewTab }))}
                  />
                </label>
              )}
            </div>
          </div>
        )}
        <DialogFooter className="sm:justify-between">
          <div>
            {editing && !confirmDelete && (
              <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="mr-2 size-4" /> Remove
              </Button>
            )}
            {confirmDelete && (
              <div className="flex items-center gap-2">
                <Button
                  variant="destructive"
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate()}
                >
                  Remove branch
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
              </div>
            )}
          </div>
          {!confirmDelete && (
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button
                disabled={
                  saveMutation.isPending
                  || !draft.label.trim()
                  || (draft.target.type === "resource" && !draft.target.resourceId)
                }
                onClick={() => saveMutation.mutate()}
              >
                {saveMutation.isPending ? "Saving…" : "Save item"}
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MenuMetadataDialog({
  menu,
  open,
  onOpenChange,
  onSaved,
}: {
  menu?: NavigationMenuSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (menuId: string) => void;
}) {
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  useEffect(() => {
    setName(menu?.name ?? "");
    setHandle(menu?.handle ?? "");
  }, [menu, open]);
  const mutation = useMutation({
    mutationFn: async () => {
      if (menu) {
        await updateNavigationMenuMetadataAuthority({
          data: { menuId: menu.id, expectedRevision: menu.revision, name, handle },
        });
        return menu.id;
      }
      const result = await createNavigationMenuAuthority({ data: { name, ...(handle ? { handle } : {}) } });
      return result.menu.id;
    },
    onSuccess: (menuId) => {
      toast.success(menu ? "Menu details updated" : "Menu created");
      onOpenChange(false);
      onSaved(menuId);
    },
    onError: (error) => mutationError(error, "Menu was not saved"),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{menu ? "Menu details" : "New menu"}</DialogTitle>
          <DialogDescription>Use a clear internal name; customers see item labels.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="navigation-menu-name">Name</Label>
            <Input id="navigation-menu-name" value={name} maxLength={100} autoFocus onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="navigation-menu-handle">Handle</Label>
            <Input id="navigation-menu-handle" value={handle} maxLength={80} placeholder="Generated from name" onChange={(event) => setHandle(event.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "Saving…" : menu ? "Save details" : "Create menu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlacementPanel({
  menus,
  onChanged,
}: {
  menus: NavigationMenuSummary[];
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const placementsQuery = useQuery({
    queryKey: queryKeys.navigation.placements(),
    queryFn: () => getNavigationPlacementSettings(),
  });
  const mutation = useMutation({
    mutationFn: (input: {
      placement: NavigationPlacementSetting | undefined;
      surface: string;
      slot: string;
      position: number;
      menuId: string | null;
    }) => {
      if (!input.menuId && !input.placement) return Promise.resolve(null);
      const current = input.placement?.placement;
      return saveNavigationPlacementAuthority({
        data: {
          placementId: current?.id ?? `placement_${input.surface}_${input.slot}_${input.position}`,
          expectedRevision: current?.revision ?? 0,
          surface: input.surface,
          slot: input.slot,
          position: input.position,
          menuId: input.menuId ?? current!.menuId,
          labelOverride: current?.labelOverride ?? null,
          isEnabled: Boolean(input.menuId),
        },
      });
    },
    onSuccess: () => {
      toast.success("Storefront location updated");
      void queryClient.invalidateQueries({ queryKey: queryKeys.navigation.placements() });
      onChanged();
    },
    onError: (error) => mutationError(error, "Storefront location was not updated"),
  });
  const placements = placementsQuery.data?.placements ?? [];
  const slots = [
    { surface: "header", slot: "primary", position: 0, label: "Header" },
    ...Array.from({ length: 4 }, (_, position) => ({
      surface: "footer",
      slot: "column",
      position,
      label: `Footer column ${position + 1}`,
    })),
  ];
  const publishedMenus = menus.filter((menu) => menu.publishedRevision != null);

  return (
    <Card className="overflow-hidden">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Storefront locations</h2>
        <p className="text-xs text-muted-foreground">Assign published menus without changing their content.</p>
      </div>
      <div className="divide-y">
        {slots.map((slot) => {
          const placement = placements.find(({ placement: current }) => (
            current.surface === slot.surface
            && current.slot === slot.slot
            && current.position === slot.position
          ));
          const value = placement?.placement.isEnabled ? placement.placement.menuId : "off";
          return (
            <div key={`${slot.surface}:${slot.position}`} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(220px,320px)] sm:items-center">
              <div>
                <p className="text-sm font-medium">{slot.label}</p>
                <p className="text-xs text-muted-foreground">
                  {slot.surface === "header" ? "Primary desktop and mobile menu" : "Footer link group"}
                </p>
              </div>
              <Select
                value={value}
                disabled={mutation.isPending}
                onValueChange={(menuId) => mutation.mutate({
                  placement,
                  surface: slot.surface,
                  slot: slot.slot,
                  position: slot.position,
                  menuId: menuId === "off" ? null : menuId,
                })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Not used</SelectItem>
                  {publishedMenus.map((menu) => (
                    <SelectItem key={menu.id} value={menu.id}>{menu.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function PublicationHistory({
  menu,
  onChanged,
}: {
  menu: NavigationMenuSummary;
  onChanged: () => void;
}) {
  const query = useQuery({
    queryKey: queryKeys.navigation.publications(menu.id),
    queryFn: () => getNavigationPublications({ data: { menuId: menu.id, limit: 50 } }),
  });
  const [restoreRevision, setRestoreRevision] = useState<number | null>(null);
  const mutation = useMutation({
    mutationFn: (sourceRevision: number) => rollbackNavigationMenuAuthority({
      data: { menuId: menu.id, expectedRevision: menu.revision, sourceRevision },
    }),
    onSuccess: () => {
      toast.success("Earlier version restored as a new publication");
      setRestoreRevision(null);
      onChanged();
    },
    onError: (error) => mutationError(error, "Menu version was not restored"),
  });
  return (
    <Card className="overflow-hidden">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Publication history</h2>
        <p className="text-xs text-muted-foreground">Restoring keeps history linear and auditable.</p>
      </div>
      <div className="divide-y">
        {query.data?.items.map((publication) => {
          const current = publication.revision === menu.publishedRevision;
          return (
            <div key={publication.revision} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
                  {current ? <Check className="size-4" /> : <Clock3 className="size-4 text-muted-foreground" />}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium">Revision {publication.revision}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {publication.itemCount} items · {formatDate(publication.publishedAt)}
                  </p>
                </div>
              </div>
              {current ? (
                <Badge variant="secondary">Live</Badge>
              ) : restoreRevision === publication.revision ? (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setRestoreRevision(null)}>Cancel</Button>
                  <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate(publication.revision)}>
                    Restore
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setRestoreRevision(publication.revision)}>
                  Restore this version
                </Button>
              )}
            </div>
          );
        })}
        {!query.isLoading && !query.data?.items.length && (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">No publications yet.</div>
        )}
      </div>
    </Card>
  );
}

export function NavigationWorkspace({
  selectedMenuId,
  panel,
  query,
  itemId,
  parentId,
  onMenuChange,
  onPanelChange,
  onQueryChange,
  onItemChange,
}: NavigationWorkspaceProps) {
  const queryClient = useQueryClient();
  const menusQuery = useQuery({
    queryKey: queryKeys.navigation.menus(),
    queryFn: () => getNavigationMenusAuthority({ data: { limit: 100 } }),
  });
  const menus = menusQuery.data?.items ?? [];
  const selectedId = selectedMenuId && menus.some((menu) => menu.id === selectedMenuId)
    ? selectedMenuId
    : menus[0]?.id;
  const menuQuery = useQuery({
    queryKey: queryKeys.navigation.menu(selectedId ?? "none"),
    queryFn: () => getNavigationMenuAuthority({ data: { menuId: selectedId! } }),
    enabled: Boolean(selectedId),
  });
  const menu = menuQuery.data?.menu;
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [activeDrag, setActiveDrag] = useState<NavigationMenuItemRow | null>(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [editMenuOpen, setEditMenuOpen] = useState(false);
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingExpandIdRef = useRef<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  useEffect(() => {
    if (!selectedMenuId && selectedId) onMenuChange(selectedId);
  }, [onMenuChange, selectedId, selectedMenuId]);
  useEffect(() => {
    setExpandedIds(new Set());
  }, [selectedId]);
  useEffect(() => () => {
    if (expandTimerRef.current) clearTimeout(expandTimerRef.current);
  }, []);

  const searchQuery = useQuery({
    queryKey: [...queryKeys.navigation.menu(selectedId ?? "none"), "search", query],
    queryFn: () => searchNavigationMenuItemsAuthority({
      data: { menuId: selectedId!, query, limit: 100 },
    }),
    enabled: Boolean(selectedId && query.trim().length >= 2),
  });

  const invalidateMenu = useCallback(async () => {
    if (!selectedId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.navigation.menus() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.navigation.menu(selectedId) }),
    ]);
  }, [queryClient, selectedId]);

  const moveMutation = useMutation({
    mutationFn: ({ itemId: movingItemId, destination }: { itemId: string; destination: MoveDestination }) => {
      if (!menu) throw new Error("Menu is unavailable.");
      return moveNavigationMenuItemAuthority({
        data: {
          menuId: menu.id,
          itemId: movingItemId,
          expectedRevision: menu.revision,
          ...destination,
        },
      });
    },
    onSuccess: () => {
      toast.success("Menu item moved");
      void invalidateMenu();
    },
    onError: (error) => mutationError(error, "Menu item was not moved"),
  });
  const publishMutation = useMutation({
    mutationFn: () => publishNavigationMenuAuthority({
      data: { menuId: menu!.id, expectedRevision: menu!.revision },
    }),
    onSuccess: () => {
      toast.success("Menu published", { description: "Storefront navigation is refreshing." });
      void invalidateMenu();
      void queryClient.invalidateQueries({ queryKey: queryKeys.navigation.publications(menu!.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.navigation.placements() });
    },
    onError: (error) => mutationError(error, "Menu was not published"),
  });

  const handleDragEnd = (event: DragEndEvent) => {
    const movingId = String(event.active.id).replace(/^item:/, "");
    const destination = event.over?.data.current?.destination as MoveDestination | undefined;
    setActiveDrag(null);
    if (!destination || movingId === String(event.over?.id).split(":")[1]) return;
    if (destination.parentId) {
      setExpandedIds((current) => new Set(current).add(destination.parentId!));
    }
    moveMutation.mutate({ itemId: movingId, destination });
  };
  const clearExpandTimer = () => {
    if (expandTimerRef.current) clearTimeout(expandTimerRef.current);
    expandTimerRef.current = null;
    pendingExpandIdRef.current = null;
  };
  const handleDragOver = (event: DragOverEvent) => {
    const data = event.over?.data.current;
    const targetId = data?.mode === "inside" ? String(data.targetId ?? "") : "";
    if (!targetId || expandedIds.has(targetId) || targetId === activeDrag?.id) {
      clearExpandTimer();
      return;
    }
    if (pendingExpandIdRef.current === targetId) return;
    clearExpandTimer();
    pendingExpandIdRef.current = targetId;
    expandTimerRef.current = setTimeout(() => {
      setExpandedIds((current) => new Set(current).add(targetId));
      clearExpandTimer();
    }, 500);
  };

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
    return [...rows].sort((left, right) => (
      depthOf(left.item) - depthOf(right.item)
      || left.item.position - right.item.position
      || left.item.id.localeCompare(right.item.id)
    )).map((row) => ({ ...row, depth: depthOf(row.item) }));
  }, [searchQuery.data?.items]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Navigation</h1>
          <p className="mt-1 text-sm text-muted-foreground">Build reusable menus, publish safely, and place them across the storefront.</p>
        </div>
        <Button onClick={() => setNewMenuOpen(true)}><Plus className="mr-2 size-4" /> New menu</Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <Card className="h-fit overflow-hidden">
          <div className="flex items-center justify-between border-b px-3 py-2.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Menus</span>
            <Badge variant="secondary">{menus.length}</Badge>
          </div>
          <div className="max-h-[65vh] overflow-y-auto p-1.5">
            {menus.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => onMenuChange(candidate.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
                  candidate.id === selectedId ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                )}
              >
                <ListTree className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{candidate.name}</span>
                  <span className={cn(
                    "block truncate text-[11px]",
                    candidate.id === selectedId ? "text-primary-foreground/70" : "text-muted-foreground",
                  )}>
                    {candidate.itemCount} {candidate.itemCount === 1 ? "item" : "items"} · {candidate.placementCount} {candidate.placementCount === 1 ? "location" : "locations"}
                  </span>
                </span>
                {candidate.revision !== candidate.publishedRevision && (
                  <CircleDot className="size-3 shrink-0" aria-label="Unpublished changes" />
                )}
              </button>
            ))}
            {!menusQuery.isLoading && !menus.length && (
              <div className="px-3 py-10 text-center text-xs text-muted-foreground">No menus yet.</div>
            )}
          </div>
        </Card>

        <div className="min-w-0 space-y-3">
          {menu ? (
            <>
              <Card className="overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-base font-semibold">{menu.name}</h2>
                      {menu.revision === menu.publishedRevision ? (
                        <Badge variant="secondary" className="gap-1"><Check className="size-3" /> Published</Badge>
                      ) : (
                        <Badge className="gap-1"><CircleDot className="size-3" /> Draft changes</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{menu.handle} · revision {menu.revision}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setEditMenuOpen(true)}>
                      <Pencil className="mr-2 size-3.5" /> Details
                    </Button>
                    <Button
                      size="sm"
                      disabled={menu.revision === menu.publishedRevision || publishMutation.isPending}
                      onClick={() => publishMutation.mutate()}
                    >
                      <Send className="mr-2 size-3.5" /> {publishMutation.isPending ? "Publishing…" : "Publish"}
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <Tabs value={panel} onValueChange={(value) => onPanelChange(value as NavigationWorkspacePanel)}>
                    <TabsList className="h-9">
                      <TabsTrigger value="items" className="gap-1.5"><ListTree className="size-3.5" /> Items</TabsTrigger>
                      <TabsTrigger value="placements" className="gap-1.5"><MapPin className="size-3.5" /> Locations</TabsTrigger>
                      <TabsTrigger value="history" className="gap-1.5"><History className="size-3.5" /> History</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  {panel === "items" && (
                    <Button size="sm" variant="outline" onClick={() => onItemChange("new")}>
                      <Plus className="mr-2 size-3.5" /> Add item
                    </Button>
                  )}
                </div>
              </Card>

              {panel === "items" && (
                <Card className="overflow-hidden">
                  <div className="flex flex-col gap-2 border-b p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="relative min-w-0 flex-1 sm:max-w-sm">
                      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={query}
                        onChange={(event) => onQueryChange(event.target.value)}
                        placeholder="Find any menu item"
                        className="pl-9"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {query.trim().length >= 2 ? "Clear search to arrange items" : "Drag to an edge or inside another item"}
                    </p>
                  </div>
                  {query.trim().length >= 2 ? (
                    <div className="p-2">
                      {searchQuery.isLoading ? (
                        <div className="px-4 py-8 text-center text-sm text-muted-foreground">Searching…</div>
                      ) : searchRows.length ? searchRows.map(({ item, childCount, isMatch, depth }) => (
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
                          onAddChild={() => onItemChange("new", item.id)}
                          onMove={() => undefined}
                        />
                      )) : (
                        <div className="px-4 py-10 text-center text-sm text-muted-foreground">No menu items found.</div>
                      )}
                    </div>
                  ) : (
                    <DndContext
                      sensors={sensors}
                      collisionDetection={treeCollisionDetection}
                      onDragStart={(event: DragStartEvent) => setActiveDrag(event.active.data.current?.item as NavigationMenuItemRow)}
                      onDragOver={handleDragOver}
                      onDragCancel={() => {
                        clearExpandTimer();
                        setActiveDrag(null);
                      }}
                      onDragEnd={(event) => {
                        clearExpandTimer();
                        handleDragEnd(event);
                      }}
                    >
                      <div className="p-2">
                        <MenuLevel
                          menuId={menu.id}
                          parentId={null}
                          depth={0}
                          revision={menu.revision}
                          expandedIds={expandedIds}
                          activeDragId={activeDrag?.id ?? null}
                          onToggle={(id) => setExpandedIds((current) => {
                            const next = new Set(current);
                            if (next.has(id)) next.delete(id);
                            else next.add(id);
                            return next;
                          })}
                          onEdit={(id) => onItemChange(id)}
                          onAddChild={(id) => onItemChange("new", id)}
                          onMove={(id, destination) => moveMutation.mutate({ itemId: id, destination })}
                        />
                      </div>
                    </DndContext>
                  )}
                </Card>
              )}
              {panel === "placements" && (
                <PlacementPanel menus={menus} onChanged={() => void invalidateMenu()} />
              )}
              {panel === "history" && (
                <PublicationHistory menu={menu} onChanged={() => void invalidateMenu()} />
              )}
            </>
          ) : (
            <Card className="grid min-h-72 place-items-center p-6 text-center">
              <div>
                <Link2 className="mx-auto mb-3 size-7 text-muted-foreground" />
                <p className="text-sm font-medium">Choose or create a menu</p>
              </div>
            </Card>
          )}
        </div>
      </div>

      <MenuMetadataDialog
        open={newMenuOpen}
        onOpenChange={setNewMenuOpen}
        onSaved={(menuId) => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.navigation.menus() });
          onMenuChange(menuId);
        }}
      />
      <MenuMetadataDialog
        menu={menu}
        open={editMenuOpen}
        onOpenChange={setEditMenuOpen}
        onSaved={() => void invalidateMenu()}
      />
      {menu && itemId && (
        <MenuItemDialog
          menu={menu}
          itemId={itemId}
          parentId={parentId}
          onClose={() => onItemChange(undefined)}
          onSaved={() => {
            onItemChange(undefined);
            void invalidateMenu();
          }}
        />
      )}
    </div>
  );
}
