import { useRef, useState, type CSSProperties } from "react";
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
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Ellipsis,
  GripVertical,
  ListTree,
  Move,
  Pencil,
  Plus,
  Search,
  TriangleAlert,
  Trash2,
} from "lucide-react";

import { cn } from "@scalius/shared/utils";
import { EmptyState } from "~/components/admin/shell";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Skeleton } from "~/components/ui/skeleton";
import { getNavigationMenuItemPage, type NavigationMenuItemRow } from "~/lib/api-functions/navigation-authority";
import { queryKeys } from "~/lib/query-keys";

import {
  MAX_MENU_DEPTH,
  destinationSummary,
  isDestinationUnavailable,
} from "./navigation-authority-model";

export interface MoveDestination {
  parentId: string | null;
  beforeId?: string;
  afterId?: string;
  index?: number;
}

const treeCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length ? pointerCollisions : closestCenter(args);
};

/** Time an item must hover over a collapsed parent before it opens. */
const HOVER_EXPAND_MS = 500;

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
    <div
      className={cn("pointer-events-none absolute inset-0 z-20", !active && "hidden")}
      aria-hidden
    >
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
  onOpenMove: () => void;
  onDelete: () => void;
  onMove: (destination: MoveDestination) => void;
}

export function MenuRow({
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
  onOpenMove,
  onDelete,
  onMove,
}: MenuRowProps) {
  const draggable = useDraggable({
    id: `item:${item.id}`,
    data: { item },
    disabled: !dragEnabled,
  });
  const isDragging = activeDragId === item.id;
  const dragActive = Boolean(activeDragId) && !isDragging;
  const style = { "--menu-depth": depth } as CSSProperties;
  const draggedRowStyle = draggable.transform
    ? { transform: `translate3d(${draggable.transform.x}px, ${draggable.transform.y}px, 0)` }
    : undefined;
  const unavailable = isDestinationUnavailable(item);

  return (
    <div className="relative py-0.5" style={style} data-testid="navigation-item-row">
      <div
        style={draggedRowStyle}
        className={cn(
          "group flex min-h-12 items-center gap-1 rounded-lg border border-transparent px-2 transition-colors",
          "hover:border-border hover:bg-muted/45 focus-within:border-border focus-within:bg-muted/45",
          isDragging
            && "pointer-events-none relative z-30 border-primary bg-background opacity-40 shadow-lg",
          !item.isEnabled && "opacity-60",
          isSearchMatch && "bg-primary/5",
        )}
      >
        <div className="w-[calc(var(--menu-depth)*1.125rem)] shrink-0" aria-hidden />
        {childCount ? (
          <button
            type="button"
            className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground sm:size-8"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={expanded ? `Collapse ${item.label}` : `Expand ${item.label}`}
          >
            {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        ) : (
          <div className="size-11 shrink-0 sm:size-8" aria-hidden />
        )}
        {dragEnabled ? (
          <button
            ref={draggable.setNodeRef}
            type="button"
            className="grid size-11 shrink-0 touch-none place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground sm:size-9"
            aria-label={`Drag ${item.label}`}
            {...draggable.attributes}
            {...draggable.listeners}
          >
            <GripVertical className="size-4" />
          </button>
        ) : (
          <div className="grid size-11 shrink-0 place-items-center text-muted-foreground sm:size-9">
            <Search className="size-3.5" aria-hidden />
          </div>
        )}

        <button
          type="button"
          onClick={onEdit}
          data-testid="navigation-item-open"
          className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 py-2 text-left"
        >
          <span className="truncate text-sm font-medium">{item.label}</span>
          <span
            className={cn(
              "inline-flex min-w-0 items-center gap-1 truncate text-xs",
              unavailable ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {unavailable ? <TriangleAlert className="size-3 shrink-0" aria-hidden /> : null}
            {destinationSummary(item)}
          </span>
          {item.labelMode === "resource" && (
            <span className="truncate text-xs text-muted-foreground">· follows source</span>
          )}
          {!item.isEnabled && (
            <span className="truncate text-xs text-muted-foreground">· hidden</span>
          )}
        </button>

        <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="size-11 sm:size-9"
            aria-label={`Edit ${item.label}`}
            onClick={onEdit}
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 text-muted-foreground hover:text-destructive sm:size-9"
            aria-label={`Remove ${item.label}`}
            onClick={onDelete}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 sm:size-9"
              aria-label={`More actions for ${item.label}`}
            >
              <Ellipsis className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem
              onSelect={onAddChild}
              disabled={depth >= MAX_MENU_DEPTH - 1}
            >
              <Plus className="mr-2 size-4" /> Add nested item
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenMove}>
              <Move className="mr-2 size-4" /> Move to position…
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
              disabled={!previous || depth >= MAX_MENU_DEPTH - 1}
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

/**
 * Shopify's inline add row: every level ends with the affordance that adds to
 * that level, so the operator never has to re-pick the parent.
 */
function AddItemRow({
  depth,
  parentLabel,
  disabled,
  onAdd,
}: {
  depth: number;
  parentLabel?: string;
  disabled?: boolean;
  onAdd: () => void;
}) {
  return (
    <div
      className="py-0.5"
      style={{ paddingLeft: `calc(${depth} * 1.125rem + 0.5rem)` }}
    >
      <button
        type="button"
        disabled={disabled}
        data-testid="navigation-add-item-row"
        aria-label={parentLabel ? `Add menu item under ${parentLabel}` : "Add menu item"}
        onClick={onAdd}
        className={cn(
          "flex min-h-11 w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 text-sm text-muted-foreground transition-colors",
          "hover:border-foreground/30 hover:bg-muted/40 hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        {depth > 0 ? <CornerDownRight className="size-3.5 shrink-0" aria-hidden /> : null}
        <Plus className="size-4 shrink-0" aria-hidden />
        Add menu item
      </button>
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
  onAddChild: (parentId: string | null, parentLabel?: string) => void;
  onOpenMove: (item: NavigationMenuItemRow) => void;
  onDelete: (item: NavigationMenuItemRow, childCount: number) => void;
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
  onOpenMove,
  onDelete,
  onMove,
}: MenuLevelProps) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.navigation.menuItems(menuId, parentId),
    queryFn: ({ pageParam }) =>
      getNavigationMenuItemPage({ data: { menuId, parentId, cursor: pageParam, limit: 100 } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];

  if (query.isLoading) {
    return (
      <div className="space-y-2 px-2 py-2" role="status" aria-busy="true">
        <span className="sr-only">Loading menu items</span>
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-2/3" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm text-destructive">
        <span>This section could not be loaded.</span>
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!rows.length && depth === 0) {
    return (
      <EmptyState
        compact
        bordered={false}
        icon={ListTree}
        heading="This menu is empty"
        body="Add the first destination customers should see."
        action={{ label: "Add menu item", icon: Plus, onClick: () => onAddChild(null) }}
      />
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
              onAddChild={() => onAddChild(item.id, item.label)}
              onOpenMove={() => onOpenMove(item)}
              onDelete={() => onDelete(item, childCount)}
              onMove={(destination) => onMove(item.id, destination)}
            />
            {expanded && depth < MAX_MENU_DEPTH - 1 && (
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
                onOpenMove={onOpenMove}
                onDelete={onDelete}
                onMove={onMove}
              />
            )}
          </div>
        );
      })}
      {query.hasNextPage && (
        <div className="px-3 py-2" style={{ paddingLeft: `calc(${depth} * 1.125rem + 0.75rem)` }}>
          <Button
            size="sm"
            variant="ghost"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? "Loading" : "Load 100 more"}
          </Button>
        </div>
      )}
      <AddItemRow
        depth={depth}
        parentLabel={parent?.label}
        onAdd={() => onAddChild(parentId, parent?.label)}
      />
    </div>
  );
}

export interface NavigationMenuTreeProps {
  menuId: string;
  revision: number;
  onEdit: (itemId: string) => void;
  onAddChild: (parentId: string | null, parentLabel?: string) => void;
  onOpenMove: (item: NavigationMenuItemRow) => void;
  onDelete: (item: NavigationMenuItemRow, childCount: number) => void;
  onMove: (itemId: string, destination: MoveDestination) => void;
}

/**
 * The drag-and-drop item tree. Pointer drags land on explicit before / inside /
 * after zones, and the same destinations are reachable from the keyboard
 * through the row menu, so reordering never requires a mouse.
 */
export function NavigationMenuTree({
  menuId,
  revision,
  onEdit,
  onAddChild,
  onOpenMove,
  onDelete,
  onMove,
}: NavigationMenuTreeProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [activeDrag, setActiveDrag] = useState<NavigationMenuItemRow | null>(null);
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingExpandIdRef = useRef<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

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
    }, HOVER_EXPAND_MS);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const movingId = String(event.active.id).replace(/^item:/, "");
    const destination = event.over?.data.current?.destination as MoveDestination | undefined;
    setActiveDrag(null);
    if (!destination || movingId === String(event.over?.id).split(":")[1]) return;
    if (destination.parentId) {
      setExpandedIds((current) => new Set(current).add(destination.parentId!));
    }
    onMove(movingId, destination);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={treeCollisionDetection}
      onDragStart={(event: DragStartEvent) =>
        setActiveDrag(event.active.data.current?.item as NavigationMenuItemRow)}
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
      <div className="p-2" data-testid="navigation-menu-tree">
        <MenuLevel
          menuId={menuId}
          parentId={null}
          depth={0}
          revision={revision}
          expandedIds={expandedIds}
          activeDragId={activeDrag?.id ?? null}
          onToggle={(id) =>
            setExpandedIds((current) => {
              const next = new Set(current);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })}
          onEdit={onEdit}
          onAddChild={onAddChild}
          onOpenMove={onOpenMove}
          onDelete={onDelete}
          onMove={onMove}
        />
      </div>
    </DndContext>
  );
}

export default NavigationMenuTree;
