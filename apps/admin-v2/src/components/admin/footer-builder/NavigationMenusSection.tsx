// src/components/admin/footer-builder/NavigationMenusSection.tsx
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Plus, Trash2, GripVertical } from "lucide-react";
import { nanoid } from "nanoid";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "~/components/ui/accordion";
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
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@scalius/shared/utils";
import { NavigationBuilder } from "../navigation/NavigationBuilder";
import type { FooterMenu, NavigationItem } from "./types";

interface NavigationMenusSectionProps {
  menus: FooterMenu[];
  onChange: (menus: FooterMenu[]) => void;
}

const SortableMenuCard = React.memo(function SortableMenuCard({
  menu,
  onRemove,
  onUpdateTitle,
  onUpdateLinks,
}: {
  menu: FooterMenu;
  onRemove: (id: string, e: React.MouseEvent) => void;
  onUpdateTitle: (id: string, title: string) => void;
  onUpdateLinks: (menuId: string, links: NavigationItem[]) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: menu.id });

  const style = useMemo(
    () => ({
      transform: CSS.Transform.toString(transform),
      transition,
    }),
    [transform, transition],
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "rounded-lg border bg-card",
        isDragging && "shadow-lg ring-2 ring-primary/30 opacity-50",
      )}
    >
      <AccordionItem value={menu.id} className="border-0">
        <div className="flex items-center px-4 py-2 border-b bg-muted/10">
          <div
            {...attributes}
            {...listeners}
            className="mr-2 cursor-grab"
          >
            <GripVertical className="h-4 w-4 text-muted-foreground" />
          </div>

          <AccordionTrigger className="flex-1 py-1 hover:no-underline pr-4">
            <span className="font-medium text-sm">
              {menu.title}
            </span>
          </AccordionTrigger>

          <div className="flex items-center gap-2 ml-auto pl-4 border-l">
            <Input
              value={menu.title}
              onChange={(e) => onUpdateTitle(menu.id, e.target.value)}
              className="h-8 w-[200px]"
              onClick={(e) => e.stopPropagation()}
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={(e) => onRemove(menu.id, e)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <AccordionContent className="p-4 bg-background">
          <NavigationBuilder
            navigation={menu.links}
            onChange={(newLinks) => onUpdateLinks(menu.id, newLinks)}
            getStorefrontPath={() => "#"}
          />
        </AccordionContent>
      </AccordionItem>
    </div>
  );
});

export function NavigationMenusSection({
  menus,
  onChange,
}: NavigationMenusSectionProps) {
  const [openItems, setOpenItems] = useState<string[]>([]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Memoize menu IDs for SortableContext
  const menuIds = useMemo(() => menus.map((m) => m.id), [menus]);

  // Load accordion state from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("footer-builder-accordions");
    if (saved) {
      try {
        setOpenItems(JSON.parse(saved));
      } catch {
        setOpenItems([]);
      }
    }
  }, []);

  const handleAccordionChange = useCallback((value: string[]) => {
    setOpenItems(value);
    localStorage.setItem("footer-builder-accordions", JSON.stringify(value));
  }, []);

  const addMenu = useCallback(() => {
    const newId = nanoid();
    onChange([
      ...menus,
      { id: newId, title: `Menu ${menus.length + 1}`, links: [] },
    ]);
    setOpenItems((prev) => {
      const next = [...prev, newId];
      localStorage.setItem("footer-builder-accordions", JSON.stringify(next));
      return next;
    });
  }, [menus, onChange]);

  const removeMenu = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      onChange(menus.filter((m) => m.id !== id));
    },
    [menus, onChange],
  );

  const updateMenuTitle = useCallback(
    (id: string, title: string) => {
      onChange(menus.map((m) => (m.id === id ? { ...m, title } : m)));
    },
    [menus, onChange],
  );

  const updateMenuLinks = useCallback(
    (menuId: string, links: NavigationItem[]) => {
      onChange(menus.map((m) => (m.id === menuId ? { ...m, links } : m)));
    },
    [menus, onChange],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = menus.findIndex((m) => m.id === active.id);
      const newIndex = menus.findIndex((m) => m.id === over.id);
      onChange(arrayMove(menus, oldIndex, newIndex));
    },
    [menus, onChange],
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="text-lg font-medium">Navigation Columns</h3>
          <p className="text-sm text-muted-foreground">
            Create and manage footer menu columns.
          </p>
        </div>
        <Button onClick={addMenu}>
          <Plus className="h-4 w-4 mr-2" />
          Add Menu Column
        </Button>
      </div>

      {menus.length === 0 ? (
        <div className="text-center py-8 border-2 border-dashed rounded-lg text-muted-foreground">
          <p className="mb-2">No menus added yet.</p>
          <Button size="sm" onClick={addMenu}>
            <Plus className="h-4 w-4 mr-2" />
            Add First Menu
          </Button>
        </div>
      ) : (
        <Accordion
          type="multiple"
          value={openItems}
          onValueChange={handleAccordionChange}
          className="w-full space-y-2"
        >
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={menuIds}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-2">
                {menus.map((menu) => (
                  <SortableMenuCard
                    key={menu.id}
                    menu={menu}
                    onRemove={removeMenu}
                    onUpdateTitle={updateMenuTitle}
                    onUpdateLinks={updateMenuLinks}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </Accordion>
      )}
    </div>
  );
}
