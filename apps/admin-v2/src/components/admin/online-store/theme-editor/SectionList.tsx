/**
 * The rows of a page's sections or blocks, Shopify's tree: select a row to
 * edit it, drag it by its handle (or focus the handle, press Space, move with
 * the arrow keys, Space again), show or hide it with the eye, and each row's
 * menu moves, duplicates or removes it. Hovering a row outlines it in the
 * preview.
 */
import type { CSSProperties, ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Eye, EyeOff, GripVertical, MoreHorizontal } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { themeEditorMessages } from "~/i18n/theme-editor";

export interface TreeRow {
  id: string;
  name: string;
  /** Why buyers don't see it (fit, missing content), or an error from a save. */
  note?: ReactNode;
  invalid?: boolean;
  hidden?: boolean;
  /** Fixed rows (hidden product modules) select and toggle, but do not move. */
  fixed?: boolean;
  canDuplicate?: boolean;
  canRemove?: boolean;
}

function Row({ row, index, count, selected, onSelect, onHover, onMove, onDuplicate, onRemove, onToggle }: {
  row: TreeRow;
  index: number;
  count: number;
  selected: boolean;
  onSelect: () => void;
  onHover: (hovering: boolean) => void;
  onMove: (to: number) => void;
  onDuplicate?: () => void;
  onRemove?: () => void;
  onToggle?: () => void;
}) {
  const t = useMessages(themeEditorMessages);
  const store = useMessages(onlineStoreMessages);
  const sortable = useSortable({ id: row.id, disabled: row.fixed });
  const { transform, isDragging } = sortable;
  const menu = !row.fixed && (onDuplicate || onRemove);
  return (
    <li
      ref={sortable.setNodeRef}
      // The dragged row and the rows making room move by runtime offsets (custom properties).
      style={{ "--sort-x": `${transform?.x ?? 0}px`, "--sort-y": `${transform?.y ?? 0}px` } as CSSProperties}
      data-section-row={row.id}
      aria-current={selected ? "true" : undefined}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      className={cn(
        "group flex min-h-10 translate-x-(--sort-x) translate-y-(--sort-y) items-center gap-0.5 rounded-lg px-1 hover:bg-muted",
        selected && "bg-accent",
        isDragging ? "relative z-20 bg-card opacity-80 shadow-popover" : "transition-[translate] duration-200 motion-reduce:transition-none",
      )}
    >
      {row.fixed ? (
        <span className="size-9 shrink-0" aria-hidden="true" />
      ) : (
        <Button
          ref={sortable.setActivatorNodeRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          className="cursor-grab touch-none"
          aria-label={store("reorderItem", { name: row.name })}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          <GripVertical aria-hidden="true" />
        </Button>
      )}
      <button
        type="button"
        onClick={onSelect}
        onFocus={() => onHover(true)}
        onBlur={() => onHover(false)}
        className="flex min-w-0 flex-1 items-center rounded-md py-1.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-body", row.hidden && "text-muted-foreground")}>{row.name}</span>
          {row.note ? (
            <span className={cn("block text-body", row.invalid ? "text-destructive" : "text-muted-foreground")}>{row.note}</span>
          ) : null}
        </span>
      </button>
      {onToggle ? (
        // A shown row's eye appears on hover or focus (always on touch screens); a hidden row's stays, so the state reads at a glance.
        <span className={cn("flex", !row.hidden && "opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100")}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t(row.hidden ? "showItem" : "hideItem", { name: row.name })}
            aria-pressed={!row.hidden}
            onClick={onToggle}
          >
            {row.hidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </Button>
        </span>
      ) : null}
      {menu ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t("sectionActions", { name: row.name })}>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={index === 0} onSelect={() => onMove(index - 1)}>{t("moveUp")}</DropdownMenuItem>
            <DropdownMenuItem disabled={index === count - 1} onSelect={() => onMove(index + 1)}>{t("moveDown")}</DropdownMenuItem>
            {onToggle ? <DropdownMenuItem onSelect={onToggle}>{t(row.hidden ? "show" : "hide")}</DropdownMenuItem> : null}
            {onDuplicate ? <DropdownMenuItem disabled={!row.canDuplicate} onSelect={onDuplicate}>{t("duplicate")}</DropdownMenuItem> : null}
            {onRemove ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={row.canRemove === false} onSelect={onRemove}>{t("remove")}</DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}

export function SectionList({ rows, label, selectedId, onSelect, onHover, onMove, onDuplicate, onRemove, onToggle }: {
  rows: readonly TreeRow[];
  /** The list's accessible name (the template's name). */
  label: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  /** Moves a row to another index among the movable rows. */
  onMove: (id: string, to: number) => void;
  onDuplicate?: (id: string) => void;
  onRemove?: (id: string) => void;
  onToggle?: (id: string) => void;
}) {
  const t = useMessages(themeEditorMessages);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const movable = rows.filter((row) => !row.fixed);
  const ids = movable.map((row) => row.id);
  const nameOf = (id: UniqueIdentifier) => rows.find((row) => row.id === id)?.name ?? String(id);
  const position = (id: UniqueIdentifier | undefined) => ({ position: ids.indexOf(String(id)) + 1, count: ids.length });
  const announcements: Announcements = {
    onDragStart: ({ active }) => t("pickedUp", { name: nameOf(active.id) }),
    onDragOver: ({ active, over }) => (over ? t("movedOver", { name: nameOf(active.id), ...position(over.id) }) : undefined),
    onDragEnd: ({ active, over }) => (over ? t("dropped", { name: nameOf(active.id), ...position(over.id) }) : undefined),
    onDragCancel: ({ active }) => t("cancelled", { name: nameOf(active.id) }),
  };
  const finish = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const to = ids.indexOf(String(over.id));
    if (to >= 0) onMove(String(active.id), to);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={finish}
      accessibility={{ announcements, screenReaderInstructions: { draggable: t("dragInstructions") } }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ol className="space-y-0.5" aria-label={label}>
          {rows.map((row) => {
            const index = ids.indexOf(row.id);
            return (
              <Row
                key={row.id}
                row={row}
                index={index}
                count={ids.length}
                selected={row.id === selectedId}
                onSelect={() => onSelect(row.id)}
                onHover={(hovering) => onHover(hovering ? row.id : null)}
                onMove={(to) => onMove(row.id, to)}
                onDuplicate={onDuplicate ? () => onDuplicate(row.id) : undefined}
                onRemove={onRemove ? () => onRemove(row.id) : undefined}
                onToggle={onToggle ? () => onToggle(row.id) : undefined}
              />
            );
          })}
        </ol>
      </SortableContext>
    </DndContext>
  );
}
