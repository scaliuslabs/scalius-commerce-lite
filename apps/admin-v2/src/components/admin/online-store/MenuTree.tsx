import { useState, type CSSProperties, type ReactNode } from "react";
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
} from "@dnd-kit/core";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Ellipsis, GripVertical } from "lucide-react";
import { getApiV1AdminNavigationMenusByMenuIdItems } from "@scalius/api-client/sdk";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { apiData } from "~/lib/api";
import type { NavigationMenuItemRow } from "~/lib/api-query-options/navigation";
import type { NavigationMenuRecord } from "~/lib/api-query-options/online-store";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";

/** Menus nest at most three levels deep. */
const MAX_DEPTH = 3;

export interface MoveDestination {
  parentId: string | null;
  beforeId?: string;
  afterId?: string;
}

interface TreeHandlers {
  onEdit: (itemId: string) => void;
  onDelete: (item: NavigationMenuItemRow) => void;
  onAddChild: (parentId: string) => void;
  onMove: (itemId: string, destination: MoveDestination) => void;
}

const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : closestCenter(args);
};

/** Drop above, onto (nest) or below a row while another row is dragged. */
function DropZones({ item, active }: { item: NavigationMenuItemRow; active: boolean }) {
  const before = useDroppable({
    id: `before:${item.id}`,
    data: { destination: { parentId: item.parentId, beforeId: item.id } },
    disabled: !active,
  });
  const inside = useDroppable({
    id: `inside:${item.id}`,
    data: { destination: { parentId: item.id } },
    disabled: !active,
  });
  const after = useDroppable({
    id: `after:${item.id}`,
    data: { destination: { parentId: item.parentId, afterId: item.id } },
    disabled: !active,
  });
  if (!active) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 grid grid-rows-4" aria-hidden>
      <div ref={before.setNodeRef} className={cn(before.isOver && "border-t-2 border-primary")} />
      <div
        ref={inside.setNodeRef}
        className={cn("row-span-2 rounded-lg", inside.isOver && "border-2 border-primary bg-primary/10")}
      />
      <div ref={after.setNodeRef} className={cn(after.isOver && "border-b-2 border-primary")} />
    </div>
  );
}

function MenuRow({
  item,
  childCount,
  depth,
  expanded,
  dragging,
  previous,
  next,
  parent,
  onToggle,
  handlers,
}: {
  item: NavigationMenuItemRow;
  childCount: number;
  depth: number;
  expanded: boolean;
  dragging: string | null;
  previous?: NavigationMenuItemRow;
  next?: NavigationMenuItemRow;
  parent?: NavigationMenuItemRow;
  onToggle: () => void;
  handlers: TreeHandlers;
}) {
  const t = useMessages(onlineStoreMessages);
  const draggable = useDraggable({ id: item.id, data: { item } });
  const isDragging = dragging === item.id;
  const move = (destination: MoveDestination) => handlers.onMove(item.id, destination);
  // Where the link goes: the page's name, a path or address, or the kind of resource.
  const destination = item.targetType === "system"
    ? t(`system_${item.targetValue ?? "home"}` as "system_home")
    : item.targetType === "internal_path" || item.targetType === "external_url"
      ? item.targetValue ?? ""
      : t(`link_${item.targetType}` as "link_label");

  return (
    <div className="relative">
      <div
        // The dragged row follows the pointer (runtime offset as custom properties).
        style={{
          "--drag-x": `${draggable.transform?.x ?? 0}px`,
          "--drag-y": `${draggable.transform?.y ?? 0}px`,
        } as CSSProperties}
        className={cn(
          "flex min-h-12 items-center gap-1 rounded-lg bg-card px-1 hover:bg-muted",
          isDragging && "relative z-20 translate-x-(--drag-x) translate-y-(--drag-y) opacity-80 shadow-popover",
          !item.isEnabled && "text-muted-foreground",
        )}
      >
        {Array.from({ length: depth }, (_, index) => (
          <span key={index} className="w-6 shrink-0" aria-hidden />
        ))}
        <Button
          ref={draggable.setNodeRef}
          type="button"
          variant="ghost"
          size="icon"
          className="cursor-grab touch-none"
          aria-label={t("reorderItem", { name: item.label })}
          {...draggable.attributes}
          {...draggable.listeners}
        >
          <GripVertical />
        </Button>
        <button
          type="button"
          onClick={() => handlers.onEdit(item.id)}
          className="min-w-0 flex-1 py-2 text-left"
        >
          <span className="block truncate text-body font-medium">{item.label}</span>
          <span className="block truncate text-body text-muted-foreground">
            {item.isEnabled ? destination : `${t("hiddenItem")} · ${destination}`}
          </span>
        </button>
        {childCount > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t(expanded ? "collapse" : "expand", { name: item.label })}
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? <ChevronDown /> : <ChevronRight />}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" aria-label={t("itemActions", { name: item.label })}>
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => handlers.onEdit(item.id)}>{t("edit")}</DropdownMenuItem>
            <DropdownMenuItem disabled={depth + 1 >= MAX_DEPTH} onSelect={() => handlers.onAddChild(item.id)}>
              {t("addSubItem")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!previous}
              onSelect={() => previous && move({ parentId: item.parentId, beforeId: previous.id })}
            >
              {t("moveUp")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!next}
              onSelect={() => next && move({ parentId: item.parentId, afterId: next.id })}
            >
              {t("moveDown")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!previous || depth + 1 >= MAX_DEPTH}
              onSelect={() => previous && move({ parentId: previous.id })}
            >
              {t("nestUnderPrevious")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!parent}
              onSelect={() => parent && move({ parentId: parent.parentId, afterId: parent.id })}
            >
              {t("moveOutOfGroup")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => handlers.onDelete(item)}>
              {t("delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <DropZones item={item} active={Boolean(dragging) && !isDragging} />
    </div>
  );
}

function MenuLevel({
  menu,
  parent,
  depth,
  collapsed,
  dragging,
  onToggle,
  handlers,
  empty,
}: {
  menu: NavigationMenuRecord;
  empty?: ReactNode;
  parent?: NavigationMenuItemRow;
  depth: number;
  collapsed: Set<string>;
  dragging: string | null;
  onToggle: (itemId: string) => void;
  handlers: TreeHandlers;
}) {
  const t = useMessages(onlineStoreMessages);
  const parentId = parent?.id ?? null;
  const query = useInfiniteQuery({
    queryKey: queryKeys.navigation.menuItems(menu.id, parentId),
    queryFn: ({ pageParam }) => apiData(getApiV1AdminNavigationMenusByMenuIdItems({
      path: { menuId: menu.id },
      query: { parentId: parentId ?? undefined, cursor: pageParam || undefined, limit: 100 },
    })),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  if (query.isSuccess && rows.length === 0) return <>{empty}</>;

  if (query.isError) {
    return (
      <div className="flex items-center justify-between gap-3 px-2 py-3 text-body">
        <span className="text-destructive">{t("loadFailed")}</span>
        <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
          {t("retry")}
        </Button>
      </div>
    );
  }

  return (
    <>
      {rows.map(({ item, childCount }, index) => {
        const expanded = !collapsed.has(item.id);
        return (
          <div key={item.id}>
            <MenuRow
              item={item}
              childCount={childCount}
              depth={depth}
              expanded={expanded}
              dragging={dragging}
              previous={rows[index - 1]?.item}
              next={rows[index + 1]?.item}
              parent={parent}
              onToggle={() => onToggle(item.id)}
              handlers={handlers}
            />
            {expanded && childCount > 0 && depth + 1 < MAX_DEPTH ? (
              <MenuLevel
                menu={menu}
                parent={item}
                depth={depth + 1}
                collapsed={collapsed}
                dragging={dragging}
                onToggle={onToggle}
                handlers={handlers}
              />
            ) : null}
          </div>
        );
      })}
      {query.hasNextPage ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t("loadMore")}
        </Button>
      ) : null}
    </>
  );
}

/** The menu's items as an indented tree: drag to reorder or nest. */
export function MenuTree({
  menu,
  empty,
  ...handlers
}: { menu: NavigationMenuRecord; empty: ReactNode } & TreeHandlers) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const finish = (event: DragEndEvent) => {
    setDragging(null);
    const destination = event.over?.data.current?.destination as MoveDestination | undefined;
    const itemId = String(event.active.id);
    if (!destination || destination.parentId === itemId) return;
    handlers.onMove(itemId, destination);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={(event) => setDragging(String(event.active.id))}
      onDragCancel={() => setDragging(null)}
      onDragEnd={finish}
    >
      <div className="-mx-1">
        <MenuLevel
          menu={menu}
          empty={empty}
          depth={0}
          collapsed={collapsed}
          dragging={dragging}
          onToggle={(itemId) => setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(itemId)) next.delete(itemId);
            else next.add(itemId);
            return next;
          })}
          handlers={handlers}
        />
      </div>
    </DndContext>
  );
}
