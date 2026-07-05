// src/components/admin/navigation/SortableNavigationEditor.tsx
import { useCallback, useMemo } from "react";
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
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableNavItem } from "./SortableNavItem";
import type { NavigationItem } from "./types";
import { MAX_NAV_DEPTH } from "./types";

interface SortableNavigationEditorProps {
  navigation: NavigationItem[];
  maxDepth?: number;
  onUpdate: (
    path: string,
    index: number,
    item: Partial<NavigationItem>,
  ) => void;
  onRemove: (path: string, index: number) => void;
  onAddChild: (parentPath: string) => void;
  onIndent: (path: string, index: number) => void;
  onOutdent: (path: string, index: number) => void;
  getStorefrontPath: (path: string) => string;
  onRootReorder: (oldIndex: number, newIndex: number) => void;
  onReorderSubmenu: (parentId: string, oldIndex: number, newIndex: number) => void;
}

export function SortableNavigationEditor({
  navigation,
  maxDepth = MAX_NAV_DEPTH,
  onUpdate,
  onRemove,
  onAddChild,
  onIndent,
  onOutdent,
  getStorefrontPath,
  onRootReorder,
  onReorderSubmenu,
}: SortableNavigationEditorProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const rootItemIds = useMemo(
    () => navigation.map((item) => item.id),
    [navigation],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = navigation.findIndex((item) => item.id === active.id);
      const newIndex = navigation.findIndex((item) => item.id === over.id);
      onRootReorder(oldIndex, newIndex);
    },
    [navigation, onRootReorder],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={rootItemIds}
        strategy={verticalListSortingStrategy}
      >
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead className="w-[60px] pl-3">Order</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>URL</TableHead>
              <TableHead className="w-[100px] text-right pr-3">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {navigation.map((item, index) => (
              <SortableNavItem
                key={item.id}
                item={item}
                index={index}
                depth={0}
                maxDepth={maxDepth}
                onUpdate={onUpdate}
                onRemove={onRemove}
                onAddChild={onAddChild}
                onIndent={onIndent}
                onOutdent={onOutdent}
                parentPath=""
                getStorefrontPath={getStorefrontPath}
                canIndent={index > 0}
                canOutdent={false}
                onReorderSubmenu={onReorderSubmenu}
              />
            ))}
          </TableBody>
        </Table>
      </SortableContext>
    </DndContext>
  );
}
