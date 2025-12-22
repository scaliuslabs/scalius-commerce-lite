// src/components/admin/navigation/NavigationBuilder.tsx
import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Menu, Layers } from "lucide-react";
import { DragDropContext, Droppable } from "@hello-pangea/dnd";
import type { DropResult } from "@hello-pangea/dnd";
import { cn } from "@/lib/utils";
import { SortableNavItem } from "./SortableNavItem";
import { AddNavItemDialog } from "./AddNavItemDialog";
import type { NavigationItem, NavigationBuilderProps } from "./types";
import { MAX_NAV_DEPTH } from "./types";

export function NavigationBuilder({
  navigation,
  onChange,
  getStorefrontPath,
}: NavigationBuilderProps) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [addToParentPath, setAddToParentPath] = useState<string | null>(null);
  const [addToParentLabel, setAddToParentLabel] = useState<string | undefined>(
    undefined,
  );

  // Helper: Get item at path
  const getItemAtPath = useCallback(
    (path: string): NavigationItem | null => {
      const parts = path.split(".").map(Number);
      let items = navigation;
      let item: NavigationItem | null = null;

      for (const idx of parts) {
        if (!items || idx >= items.length) return null;
        item = items[idx];
        items = item.subMenu || [];
      }

      return item;
    },
    [navigation],
  );

  // Update item at path
  const updateItem = useCallback(
    (path: string, index: number, updates: Partial<NavigationItem>) => {
      const updateAtPath = (
        items: NavigationItem[],
        parts: number[],
      ): NavigationItem[] => {
        if (parts.length === 0) {
          return items.map((item, i) =>
            i === index ? { ...item, ...updates } : item,
          );
        }
        const [first, ...rest] = parts;
        return items.map((item, i) =>
          i === first && item.subMenu
            ? { ...item, subMenu: updateAtPath(item.subMenu, rest) }
            : item,
        );
      };
      const parts = path ? path.split(".").map(Number) : [];
      onChange(updateAtPath(navigation, parts));
    },
    [navigation, onChange],
  );

  // Remove item at path
  const removeItem = useCallback(
    (path: string, index: number) => {
      const removeAtPath = (
        items: NavigationItem[],
        parts: number[],
      ): NavigationItem[] => {
        if (parts.length === 0) {
          return items.filter((_, i) => i !== index);
        }
        const [first, ...rest] = parts;
        return items.map((item, i) =>
          i === first && item.subMenu
            ? { ...item, subMenu: removeAtPath(item.subMenu, rest) }
            : item,
        );
      };
      const parts = path ? path.split(".").map(Number) : [];
      onChange(removeAtPath(navigation, parts));
    },
    [navigation, onChange],
  );

  // Add items to path
  const addItemsToPath = useCallback(
    (items: NavigationItem[], parentPath: string | null) => {
      if (!parentPath) {
        // Add to root
        onChange([...navigation, ...items]);
        return;
      }

      const addAtPath = (
        navItems: NavigationItem[],
        parts: number[],
      ): NavigationItem[] => {
        if (parts.length === 1) {
          return navItems.map((item, i) =>
            i === parts[0]
              ? { ...item, subMenu: [...(item.subMenu || []), ...items] }
              : item,
          );
        }
        const [first, ...rest] = parts;
        return navItems.map((item, i) =>
          i === first && item.subMenu
            ? { ...item, subMenu: addAtPath(item.subMenu, rest) }
            : item,
        );
      };

      const pathParts = parentPath.split(".").map(Number);
      onChange(addAtPath(navigation, pathParts));
    },
    [navigation, onChange],
  );

  // Handle add child click
  const handleAddChild = useCallback(
    (parentPath: string) => {
      const item = getItemAtPath(parentPath);
      setAddToParentPath(parentPath);
      setAddToParentLabel(item?.title);
      setIsDialogOpen(true);
    },
    [getItemAtPath],
  );

  // Handle add root
  const handleAddRoot = useCallback(() => {
    setAddToParentPath(null);
    setAddToParentLabel(undefined);
    setIsDialogOpen(true);
  }, []);

  // Indent: Make item a child of the previous sibling
  const handleIndent = useCallback(
    (path: string, index: number) => {
      if (index === 0) return; // Can't indent first item

      const indentAtPath = (
        items: NavigationItem[],
        parts: number[],
      ): NavigationItem[] => {
        if (parts.length === 0) {
          const item = items[index];
          const prevItem = items[index - 1];
          const newItems = items.filter((_, i) => i !== index);
          newItems[index - 1] = {
            ...prevItem,
            subMenu: [...(prevItem.subMenu || []), item],
          };
          return newItems;
        }
        const [first, ...rest] = parts;
        return items.map((item, i) =>
          i === first && item.subMenu
            ? { ...item, subMenu: indentAtPath(item.subMenu, rest) }
            : item,
        );
      };

      const parts = path ? path.split(".").map(Number) : [];
      onChange(indentAtPath(navigation, parts));
    },
    [navigation, onChange],
  );

  // Outdent: Move item up to parent's level
  const handleOutdent = useCallback(
    (path: string, index: number) => {
      if (!path) return; // Can't outdent root items

      const pathParts = path.split(".").map(Number);
      // const parentPath = pathParts.slice(0, -1).join(".");
      // const parentIndex = pathParts[pathParts.length - 1];

      const outdentAtPath = (
        items: NavigationItem[],
        parts: number[],
      ): NavigationItem[] => {
        if (parts.length === 1) {
          // We're at the parent level
          const parent = items[parts[0]];
          if (!parent.subMenu) return items;

          const item = parent.subMenu[index];
          const newSubMenu = parent.subMenu.filter((_, i) => i !== index);
          const newItems = [...items];
          newItems[parts[0]] = { ...parent, subMenu: newSubMenu };
          // Insert after parent
          newItems.splice(parts[0] + 1, 0, item);
          return newItems;
        }

        const [first, ...rest] = parts;
        return items.map((item, i) =>
          i === first && item.subMenu
            ? { ...item, subMenu: outdentAtPath(item.subMenu, rest) }
            : item,
        );
      };

      onChange(outdentAtPath(navigation, pathParts));
    },
    [navigation, onChange],
  );

  // Drag end handler
  const handleDragEnd = useCallback(
    (result: DropResult) => {
      if (!result.destination) return;

      const { source, destination } = result;

      // Same list reorder
      if (source.droppableId === destination.droppableId) {
        if (source.droppableId === "main-navigation") {
          const reordered = Array.from(navigation);
          const [removed] = reordered.splice(source.index, 1);
          reordered.splice(destination.index, 0, removed);
          onChange(reordered);
        } else {
          // Submenu reorder
          const parentId = source.droppableId.replace("submenu-", "");
          const updateSubmenu = (items: NavigationItem[]): NavigationItem[] => {
            return items.map((item) => {
              if (item.id === parentId && item.subMenu) {
                const reordered = Array.from(item.subMenu);
                const [removed] = reordered.splice(source.index, 1);
                reordered.splice(destination.index, 0, removed);
                return { ...item, subMenu: reordered };
              }
              if (item.subMenu) {
                return { ...item, subMenu: updateSubmenu(item.subMenu) };
              }
              return item;
            });
          };
          onChange(updateSubmenu(navigation));
        }
      }
    },
    [navigation, onChange],
  );

  // Stats
  const countItems = useCallback((items: NavigationItem[]): number => {
    return items.reduce(
      (acc, item) => acc + 1 + (item.subMenu ? countItems(item.subMenu) : 0),
      0,
    );
  }, []);

  const getMaxDepth = useCallback(
    (items: NavigationItem[], depth = 0): number => {
      if (!items.length) return depth;
      return Math.max(
        depth,
        ...items.map((item) =>
          item.subMenu ? getMaxDepth(item.subMenu, depth + 1) : depth,
        ),
      );
    },
    [],
  );

  const totalItems = countItems(navigation);
  const maxDepth = getMaxDepth(navigation) + 1;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Menu className="h-5 w-5" />
              Navigation Menu
            </CardTitle>
            <CardDescription>
              Build your navigation with up to {MAX_NAV_DEPTH} levels of nesting
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-normal">
              <Layers className="h-3 w-3 mr-1" />
              {totalItems} items • {maxDepth} levels
            </Badge>
            <Button size="sm" onClick={handleAddRoot}>
              <Plus className="h-4 w-4 mr-1" />
              Add Item
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <div className="border-t">
          <DragDropContext onDragEnd={handleDragEnd}>
            <Droppable droppableId="main-navigation" type="MAIN_NAV">
              {(provided, snapshot) => (
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
                  <TableBody
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className={cn(snapshot.isDraggingOver && "bg-primary/5")}
                  >
                    {navigation.length === 0 ? (
                      <TableRow>
                        <td colSpan={4} className="py-12 text-center">
                          <Menu className="h-12 w-12 mx-auto mb-3 text-muted-foreground/40" />
                          <p className="text-muted-foreground mb-1">
                            No navigation items yet
                          </p>
                          <p className="text-sm text-muted-foreground/70 mb-4">
                            Add categories, pages, custom links, or labels
                          </p>
                          <Button onClick={handleAddRoot}>
                            <Plus className="h-4 w-4 mr-2" />
                            Add First Item
                          </Button>
                        </td>
                      </TableRow>
                    ) : (
                      navigation.map((item, index) => (
                        <SortableNavItem
                          key={item.id}
                          item={item}
                          index={index}
                          depth={0}
                          maxDepth={MAX_NAV_DEPTH}
                          onUpdate={updateItem}
                          onRemove={removeItem}
                          onAddChild={handleAddChild}
                          onIndent={handleIndent}
                          onOutdent={handleOutdent}
                          parentPath=""
                          getStorefrontPath={getStorefrontPath}
                          canIndent={index > 0}
                          canOutdent={false}
                        />
                      ))
                    )}
                    {provided.placeholder}
                  </TableBody>
                </Table>
              )}
            </Droppable>
          </DragDropContext>
        </div>
      </CardContent>

      {/* Add Item Dialog */}
      <AddNavItemDialog
        open={isDialogOpen}
        onClose={() => {
          setIsDialogOpen(false);
          setAddToParentPath(null);
          setAddToParentLabel(undefined);
        }}
        onAdd={(items) => addItemsToPath(items, addToParentPath)}
        parentLabel={addToParentLabel}
        getStorefrontPath={getStorefrontPath}
      />
    </Card>
  );
}
