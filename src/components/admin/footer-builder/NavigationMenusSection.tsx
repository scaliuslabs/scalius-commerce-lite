// src/components/admin/footer-builder/NavigationMenusSection.tsx
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Trash2, GripVertical } from "lucide-react";
import { nanoid } from "nanoid";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  DragDropContext,
  Droppable,
  Draggable,
  type DropResult,
} from "@hello-pangea/dnd";
import { cn } from "@/lib/utils";
import { NavigationBuilder } from "../navigation";
import type { FooterMenu, NavigationItem } from "./types";

interface NavigationMenusSectionProps {
  menus: FooterMenu[];
  onChange: (menus: FooterMenu[]) => void;
}

export function NavigationMenusSection({
  menus,
  onChange,
}: NavigationMenusSectionProps) {
  const [openItems, setOpenItems] = useState<string[]>([]);

  // Load accordion state from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("footer-builder-accordions");
    if (saved) {
      try {
        setOpenItems(JSON.parse(saved));
      } catch (e) {
        setOpenItems([]);
      }
    }
  }, []);

  const handleAccordionChange = (value: string[]) => {
    setOpenItems(value);
    localStorage.setItem("footer-builder-accordions", JSON.stringify(value));
  };

  const addMenu = () => {
    const newId = nanoid();
    onChange([
      ...menus,
      { id: newId, title: `Menu ${menus.length + 1}`, links: [] },
    ]);
    handleAccordionChange([...openItems, newId]);
  };

  const removeMenu = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(menus.filter((m) => m.id !== id));
  };

  const updateMenuTitle = (id: string, title: string) => {
    onChange(menus.map((m) => (m.id === id ? { ...m, title } : m)));
  };

  const updateMenuLinks = (menuId: string, links: NavigationItem[]) => {
    onChange(menus.map((m) => (m.id === menuId ? { ...m, links } : m)));
  };

  const handleDragEnd = (result: DropResult) => {
    if (!result.destination || result.type !== "MENU") return;
    const items = Array.from(menus);
    const [reordered] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, reordered);
    onChange(items);
  };

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
          <DragDropContext onDragEnd={handleDragEnd}>
            <Droppable droppableId="menus" type="MENU">
              {(provided) => (
                <div
                  {...provided.droppableProps}
                  ref={provided.innerRef}
                  className="space-y-2"
                >
                  {menus.map((menu, index) => (
                    <Draggable
                      key={menu.id}
                      draggableId={menu.id}
                      index={index}
                    >
                      {(provided, snapshot) => (
                        <div
                          ref={provided.innerRef}
                          {...provided.draggableProps}
                          className={cn(
                            "rounded-lg border bg-card",
                            snapshot.isDragging &&
                              "shadow-lg ring-2 ring-primary/30",
                          )}
                        >
                          <AccordionItem value={menu.id} className="border-0">
                            <div className="flex items-center px-4 py-2 border-b bg-muted/10">
                              <div
                                {...provided.dragHandleProps}
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
                                  onChange={(e) =>
                                    updateMenuTitle(menu.id, e.target.value)
                                  }
                                  className="h-8 w-[200px]"
                                  onClick={(e) => e.stopPropagation()}
                                />
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                  onClick={(e) => removeMenu(menu.id, e)}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                            <AccordionContent className="p-4 bg-background">
                              <NavigationBuilder
                                navigation={menu.links}
                                onChange={(newLinks) =>
                                  updateMenuLinks(menu.id, newLinks)
                                }
                                getStorefrontPath={() => "#"}
                              />
                            </AccordionContent>
                          </AccordionItem>
                        </div>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>
        </Accordion>
      )}
    </div>
  );
}
