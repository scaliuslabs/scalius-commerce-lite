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
import { cn } from "@scalius/shared/utils";
import { NavigationBuilder } from "../navigation/NavigationBuilder";
import { getSortableStyle } from "../shared/sortable-style";
import type { FooterMenu, NavigationItem } from "./types";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";

const MAX_FOOTER_MENUS = 4;

interface NavigationMenusSectionProps {
  menus: FooterMenu[];
  onChange: (menus: FooterMenu[]) => void;
}

const SortableMenuCard = React.memo(function SortableMenuCard({
  menu,
  onRemove,
  onUpdateTitle,
  onUpdateLinks,
  getStorefrontPath,
}: {
  menu: FooterMenu;
  onRemove: (id: string, e: React.MouseEvent) => void;
  onUpdateTitle: (id: string, title: string) => void;
  onUpdateLinks: (menuId: string, links: NavigationItem[]) => void;
  getStorefrontPath: (path: string) => string;
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
    () => getSortableStyle(transform, transition),
    [transform, transition],
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "rounded-md border bg-card",
        isDragging && "shadow-lg ring-2 ring-primary/30 opacity-50",
      )}
    >
      <AccordionItem value={menu.id} className="border-0">
        <div className="flex items-center bg-muted/10 px-2 py-1.5">
          <div
            {...attributes}
            {...listeners}
            className="mr-1 cursor-grab rounded p-1 hover:bg-muted"
            aria-label={`Reorder ${menu.title}`}
          >
            <GripVertical className="h-4 w-4 text-muted-foreground" />
          </div>

          <AccordionTrigger className="flex-1 py-1 hover:no-underline pr-3">
            <span className="flex items-center gap-2 font-medium text-sm">
              {menu.title || "Untitled menu"}
              <span className="text-xs font-normal text-muted-foreground">
                {menu.links.length} links
              </span>
            </span>
          </AccordionTrigger>

          <div className="ml-auto flex items-center border-l pl-2">
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={(e) => onRemove(menu.id, e)}
              aria-label={`Remove ${menu.title || "footer menu"}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <AccordionContent className="border-t bg-background p-3">
          <div className="mb-3 grid max-w-sm gap-1.5">
            <label htmlFor={`footer-menu-${menu.id}`} className="text-xs font-medium">
              Column heading
            </label>
            <Input
              id={`footer-menu-${menu.id}`}
              value={menu.title}
              onChange={(e) => onUpdateTitle(menu.id, e.target.value)}
              className="h-8"
              placeholder="e.g. Help"
            />
          </div>
          <NavigationBuilder
            navigation={menu.links}
            onChange={(newLinks) => onUpdateLinks(menu.id, newLinks)}
            getStorefrontPath={getStorefrontPath}
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
  const { getStorefrontPath } = useStorefrontUrl();
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
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="text-base font-medium">Footer columns</h3>
          <p className="text-xs text-muted-foreground">
            Up to {MAX_FOOTER_MENUS} focused groups of shopping and help links.
          </p>
        </div>
        <Button onClick={addMenu} size="sm" disabled={menus.length >= MAX_FOOTER_MENUS}>
          <Plus className="h-4 w-4 mr-2" />
          Add column
        </Button>
      </div>

      {menus.length === 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-4 text-muted-foreground">
          <p className="text-sm">No footer columns</p>
          <Button size="sm" onClick={addMenu}>
            <Plus className="h-4 w-4 mr-2" />
            Add first column
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
                    getStorefrontPath={getStorefrontPath}
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
