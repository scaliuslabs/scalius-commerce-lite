import { memo, type ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  Link2,
  Move,
  Pencil,
  Type,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { getSortableStyle } from "~/components/admin/shared/sortable-style";
import type {
  NavigationDragIntent,
  NavigationOutlineRow,
} from "./navigation-workspace";
import { NAVIGATION_TREE_INDENT } from "./navigation-workspace";
import { getNavigationItemHref, getNavigationItemLabel } from "./types";

interface NavigationMapProps {
  rows: NavigationOutlineRow[];
  selectedId: string | null;
  normalizedQuery: string;
  activeDragId: string | null;
  dragIntent: NavigationDragIntent | null;
  dragDisabled: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onMove: (id: string) => void;
  renderEditor: (row: NavigationOutlineRow) => ReactNode;
}

type SortableNavigationRowProps = Omit<NavigationMapProps, "rows"> & {
  row: NavigationOutlineRow;
};

function SortableNavigationRow({
  row,
  selectedId,
  normalizedQuery,
  activeDragId,
  dragIntent,
  dragDisabled,
  onSelect,
  onToggle,
  onMove,
  renderEditor,
}: SortableNavigationRowProps) {
  const { item, depth, hasChildren, isExpanded, matchesQuery } = row;
  const isSelected = selectedId === item.id;
  const isActiveDrag = activeDragId === item.id;
  const label = getNavigationItemLabel(item);
  const href = getNavigationItemHref(item);
  const isDropTarget = dragIntent?.overId === item.id;
  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
    transform,
    transition,
  } = useSortable({
    id: item.id,
    disabled: dragDisabled,
    data: {
      type: "navigation-item",
      parentId: row.parentId,
      depth: row.depth,
    },
  });
  const isDragSource = isDragging || isActiveDrag;
  const sortableStyle = getSortableStyle(isDragSource ? null : transform, transition, {
    paddingLeft: `${Math.min(depth, 3) * NAVIGATION_TREE_INDENT + 2}px`,
  });

  return (
    <li
      data-navigation-row-id={item.id}
      className={cn(isSelected && "bg-muted/20")}
    >
      <div
        ref={setNodeRef}
        style={sortableStyle}
        data-drag-intent={isDropTarget ? dragIntent.type : undefined}
        className={cn(
          "group relative flex min-h-11 min-w-0 items-center gap-0.5 bg-background px-1 transition-[background-color,box-shadow,opacity] hover:bg-muted/45 sm:gap-1 sm:px-1.5",
          isSelected && "bg-muted/45",
          isDragSource && "opacity-40",
          isDropTarget && dragIntent.type === "move" && dragIntent.operation === "inside" &&
            "bg-primary/10 ring-2 ring-inset ring-primary/55 hover:bg-primary/10",
          isDropTarget && dragIntent.type === "invalid" && "ring-2 ring-inset ring-destructive/35",
        )}
      >
        {isDropTarget && dragIntent.type === "move" && dragIntent.operation !== "inside" ? (
          <span
            data-navigation-insertion-line
            data-edge={dragIntent.operation}
            data-depth={dragIntent.depth}
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute right-2 z-30 h-0.5 rounded-full bg-primary shadow-[0_0_0_1px_hsl(var(--background))]",
              dragIntent.operation === "before" ? "top-0" : "bottom-0",
            )}
            style={{ left: `${dragIntent.depth * NAVIGATION_TREE_INDENT + 10}px` }}
          >
            <span className="absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full border-2 border-primary bg-background" />
          </span>
        ) : null}

        {isDropTarget && dragIntent.type === "move" && dragIntent.operation === "inside" ? (
          <span
            data-navigation-inside-target
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-1/2 z-30 -translate-y-1/2 rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground shadow-sm"
          >
            Place inside
          </span>
        ) : null}

        <>
            <button
              type="button"
              {...attributes}
              {...listeners}
              disabled={dragDisabled}
              className={cn(
                "grid h-10 w-10 shrink-0 touch-none place-items-center rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                dragDisabled
                  ? "cursor-not-allowed opacity-35"
                  : "cursor-grab hover:bg-muted hover:text-foreground active:cursor-grabbing",
              )}
              aria-label={`Drag ${label}`}
              aria-describedby={dragDisabled ? "navigation-drag-search-help" : undefined}
              title={dragDisabled ? "Clear search to arrange menu items" : `Drag ${label}`}
            >
              <GripVertical className="h-4 w-4" aria-hidden="true" />
            </button>

            {hasChildren ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-10 w-10 shrink-0"
                disabled={Boolean(normalizedQuery)}
                onClick={() => onToggle(item.id)}
                aria-expanded={isExpanded}
                aria-label={`${isExpanded ? "Collapse" : "Expand"} ${label}`}
              >
                {isExpanded ? <ChevronDown /> : <ChevronRight />}
              </Button>
            ) : (
              <span className="h-10 w-10 shrink-0" aria-hidden="true" />
            )}

            <button
              type="button"
              className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-sm px-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              onClick={() => onSelect(item.id)}
              aria-expanded={isSelected}
              aria-label={`Edit ${label}, level ${depth + 1}`}
            >
              {href ? (
                <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <Type className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-3">
                <span className="block truncate text-sm font-medium">{label}</span>
                <span className="block truncate text-xs text-muted-foreground sm:flex-1">
                  {href || "Label only"}
                </span>
              </span>
              {normalizedQuery && !matchesQuery ? (
                <Badge variant="outline" className="hidden h-5 px-1.5 text-[10px] font-normal sm:inline-flex">
                  Parent
                </Badge>
              ) : null}
              {hasChildren ? (
                <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground min-[420px]:inline">
                  {item.subMenu?.length} {item.subMenu?.length === 1 ? "child" : "children"}
                </span>
              ) : null}
            </button>

            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn("h-10 w-10 shrink-0", activeDragId && "invisible")}
              data-navigation-move-action
              onClick={() => onMove(item.id)}
              aria-label={`Move ${label}`}
              title={`Move ${label} to an exact parent and position`}
              tabIndex={activeDragId ? -1 : undefined}
            >
              <Move />
            </Button>

            <Button
              type="button"
              variant={isSelected ? "secondary" : "ghost"}
              size="sm"
              className={cn("h-10 shrink-0 px-2", activeDragId && "invisible")}
              onClick={() => onSelect(item.id)}
              aria-label={`${isSelected ? "Close editor for" : "Edit"} ${label}`}
              tabIndex={activeDragId ? -1 : undefined}
            >
              <Pencil />
              <span className="hidden sm:inline">{isSelected ? "Done" : "Edit"}</span>
            </Button>
          </>
      </div>

      {isSelected && !isDragSource ? renderEditor(row) : null}
    </li>
  );
}

/**
 * A compact, flat render projection of the menu hierarchy. The hierarchy is
 * encoded by depth and disclosure controls, while the active editor stays
 * directly under its row instead of occupying a permanent second pane.
 */
export const NavigationMap = memo(function NavigationMap({
  rows,
  selectedId,
  normalizedQuery,
  activeDragId,
  dragIntent,
  dragDisabled,
  onSelect,
  onToggle,
  onMove,
  renderEditor,
}: NavigationMapProps) {
  return (
    <ol aria-label="Menu items" className="divide-y">
      {rows.map((row) => (
        <SortableNavigationRow
          key={row.item.id}
          row={row}
          selectedId={selectedId}
          normalizedQuery={normalizedQuery}
          activeDragId={activeDragId}
          dragIntent={dragIntent}
          dragDisabled={dragDisabled}
          onSelect={onSelect}
          onToggle={onToggle}
          onMove={onMove}
          renderEditor={renderEditor}
        />
      ))}
    </ol>
  );
});
