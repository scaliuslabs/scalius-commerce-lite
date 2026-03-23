// src/components/admin/shared/SortableList.tsx
// Reusable DnD sortable list component for non-table drag-and-drop scenarios.
// Designed to replace the boilerplate DndContext+SortableContext pattern in
// SocialLinksSection, NavigationMenusSection, AdditionalInfoManager, etc.

import { useCallback, useMemo, type ReactNode } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  rectSortingStrategy,
  useSortable,
  sortableKeyboardCoordinates,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@scalius/shared/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SortableItemRenderProps {
  /** Spread these onto the drag handle element */
  dragHandleProps: Record<string, unknown>;
  /** Whether this item is currently being dragged */
  isDragging: boolean;
  /** Ref to set on the item's root DOM node */
  ref: (node: HTMLElement | null) => void;
  /** Style to apply on the item's root DOM node (transform + transition) */
  style: React.CSSProperties;
}

export interface SortableListProps<T extends { id: string }> {
  /** The items array. Each must have a string `id`. */
  items: T[];
  /** Called with the reordered array after a drag completes. */
  onReorder: (items: T[]) => void;
  /** Render function for each item — receives the item and sortable props. */
  renderItem: (item: T, props: SortableItemRenderProps) => ReactNode;
  /** Sorting strategy: "vertical" (default) for lists, "grid" for grid layouts. */
  strategy?: "vertical" | "grid";
  /** Optional className for the items wrapper div. */
  className?: string;
  /** Minimum distance (px) before drag activates. Default 5. */
  activationDistance?: number;
}

// ---------------------------------------------------------------------------
// Hook: useSortableItem — for consumers that want manual control
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper around `useSortable` that returns a flat props object
 * matching `SortableItemRenderProps`. Use this when you want to build your
 * own item component without going through `<SortableList>`.
 */
export function useSortableItem(id: string): SortableItemRenderProps {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  return {
    ref: setNodeRef,
    style: {
      transform: CSS.Transform.toString(transform),
      transition: transition ?? undefined,
      opacity: isDragging ? 0.5 : 1,
    },
    dragHandleProps: {
      ...attributes,
      ...listeners,
    },
    isDragging,
  };
}

// ---------------------------------------------------------------------------
// Internal SortableItem wrapper
// ---------------------------------------------------------------------------

function SortableItemWrapper<T extends { id: string }>({
  item,
  renderItem,
}: {
  item: T;
  renderItem: (item: T, props: SortableItemRenderProps) => ReactNode;
}) {
  const props = useSortableItem(item.id);
  return <>{renderItem(item, props)}</>;
}

// ---------------------------------------------------------------------------
// SortableList component
// ---------------------------------------------------------------------------

export function SortableList<T extends { id: string }>({
  items,
  onReorder,
  renderItem,
  strategy = "vertical",
  className,
  activationDistance = 5,
}: SortableListProps<T>) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: activationDistance },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const itemIds = useMemo(() => items.map((item) => item.id), [items]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = items.findIndex((item) => item.id === active.id);
      const newIndex = items.findIndex((item) => item.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      onReorder(arrayMove(items, oldIndex, newIndex));
    },
    [items, onReorder],
  );

  const sortingStrategy =
    strategy === "grid" ? rectSortingStrategy : verticalListSortingStrategy;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={itemIds} strategy={sortingStrategy}>
        <div className={cn(strategy === "vertical" ? "space-y-2" : "grid gap-2", className)}>
          {items.map((item) => (
            <SortableItemWrapper
              key={item.id}
              item={item}
              renderItem={renderItem}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
