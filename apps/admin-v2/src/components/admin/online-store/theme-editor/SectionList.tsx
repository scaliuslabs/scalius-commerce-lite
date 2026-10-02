/**
 * The homepage sections in order: drag a row by its handle (or focus the
 * handle, press Space, move with the arrow keys, Space again), select a
 * row to edit it, and each row's menu moves, duplicates or removes it.
 * Hovering a row outlines its section in the preview.
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
import { ChevronRight, GripVertical, MoreHorizontal } from "lucide-react";
import type { StorefrontSection } from "@scalius/shared/storefront-theme";
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

type Section = StorefrontSection;

export interface SectionRowInfo {
  name: string;
  /** Why buyers don't see it (fit, missing content), or an error from a save. */
  note?: ReactNode;
  invalid?: boolean;
}

function SectionRow({ section, info, index, count, canDuplicate, onSelect, onHover, onMove, onDuplicate, onRemove, onToggle }: {
  section: Section;
  info: SectionRowInfo;
  index: number;
  count: number;
  canDuplicate: boolean;
  onSelect: () => void;
  onHover: (hovering: boolean) => void;
  onMove: (to: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onToggle: () => void;
}) {
  const t = useMessages(themeEditorMessages);
  const store = useMessages(onlineStoreMessages);
  const sortable = useSortable({ id: section.id });
  const { transform, isDragging } = sortable;
  return (
    <li
      ref={sortable.setNodeRef}
      // The dragged row and the rows making room move by runtime offsets (custom properties).
      style={{ "--sort-x": `${transform?.x ?? 0}px`, "--sort-y": `${transform?.y ?? 0}px` } as CSSProperties}
      data-section-row={section.id}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      className={cn(
        "flex min-h-12 translate-x-(--sort-x) translate-y-(--sort-y) items-center gap-1 rounded-lg bg-card px-1 hover:bg-muted",
        isDragging ? "relative z-20 opacity-80 shadow-popover" : "transition-[translate] duration-200 motion-reduce:transition-none",
      )}
    >
      <Button
        ref={sortable.setActivatorNodeRef}
        type="button"
        variant="ghost"
        size="icon"
        className="cursor-grab touch-none"
        aria-label={store("reorderItem", { name: info.name })}
        {...sortable.attributes}
        {...sortable.listeners}
      >
        <GripVertical aria-hidden="true" />
      </Button>
      <button
        type="button"
        onClick={onSelect}
        onFocus={() => onHover(true)}
        onBlur={() => onHover(false)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium">{info.name}</span>
          {info.note ? (
            <span className={cn("block text-body", info.invalid ? "text-destructive" : "text-muted-foreground")}>{info.note}</span>
          ) : null}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" aria-label={t("sectionActions", { name: info.name })}>
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={index === 0} onSelect={() => onMove(index - 1)}>{t("moveUp")}</DropdownMenuItem>
          <DropdownMenuItem disabled={index === count - 1} onSelect={() => onMove(index + 1)}>{t("moveDown")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={onToggle}>{t(section.hidden ? "show" : "hide")}</DropdownMenuItem>
          <DropdownMenuItem disabled={!canDuplicate} onSelect={onDuplicate}>{t("duplicate")}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onRemove}>{t("remove")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

export function SectionList({ sections, info, canDuplicate, onSelect, onHover, onMove, onDuplicate, onRemove, onToggle }: {
  sections: readonly Section[];
  info: (section: Section) => SectionRowInfo;
  canDuplicate: (section: Section) => boolean;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  /** Moves a section to another index. */
  onMove: (id: string, to: number) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const t = useMessages(themeEditorMessages);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = sections.map((section) => section.id);
  const nameOf = (id: UniqueIdentifier) => {
    const section = sections.find((each) => each.id === id);
    return section ? info(section).name : String(id);
  };
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
        <ol className="space-y-0.5" aria-label={t("tabSections")}>
          {sections.map((section, index) => (
            <SectionRow
              key={section.id}
              section={section}
              info={info(section)}
              index={index}
              count={sections.length}
              canDuplicate={canDuplicate(section)}
              onSelect={() => onSelect(section.id)}
              onHover={(hovering) => onHover(hovering ? section.id : null)}
              onMove={(to) => onMove(section.id, to)}
              onDuplicate={() => onDuplicate(section.id)}
              onRemove={() => onRemove(section.id)}
              onToggle={() => onToggle(section.id)}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}
