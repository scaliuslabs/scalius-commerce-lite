// src/components/admin/navigation/NavigationBuilder.tsx
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Check, GripVertical, Plus, Menu, Layers } from "lucide-react";
import { AddNavItemDialog } from "./AddNavItemDialog";
import { NavigationTreeRows } from "./NavigationTreeRows";
import type { NavigationItem, NavigationBuilderProps } from "./types";
import { MAX_NAV_DEPTH } from "./types";

const SortableNavigationEditor = lazy(() =>
  import("./SortableNavigationEditor").then((module) => ({
    default: module.SortableNavigationEditor,
  })),
);

function moveNavigationItem<T>(items: T[], oldIndex: number, newIndex: number): T[] {
  if (
    oldIndex === newIndex ||
    oldIndex < 0 ||
    newIndex < 0 ||
    oldIndex >= items.length ||
    newIndex >= items.length
  ) {
    return items;
  }

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(oldIndex, 1);
  nextItems.splice(newIndex, 0, movedItem);
  return nextItems;
}

function hasReorderableItems(items: NavigationItem[]): boolean {
  return (
    items.length > 1 ||
    items.some((item) =>
      item.subMenu ? hasReorderableItems(item.subMenu) : false,
    )
  );
}

export function NavigationBuilder({
  navigation,
  onChange,
  getStorefrontPath,
}: NavigationBuilderProps) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isReorderMode, setIsReorderMode] = useState(false);
  const [addToParentPath, setAddToParentPath] = useState<string | null>(null);
  const [addToParentLabel, setAddToParentLabel] = useState<string | undefined>(
    undefined,
  );

  const canReorderItems = useMemo(
    () => hasReorderableItems(navigation),
    [navigation],
  );

  useEffect(() => {
    if (isReorderMode && !canReorderItems) {
      setIsReorderMode(false);
    }
  }, [canReorderItems, isReorderMode]);

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

  const handleRootReorder = useCallback(
    (oldIndex: number, newIndex: number) => {
      onChange(moveNavigationItem(navigation, oldIndex, newIndex));
    },
    [navigation, onChange],
  );

  // Reorder submenu items (called from SortableNavItem for nested lists)
  const handleReorderSubmenu = useCallback(
    (parentId: string, oldIndex: number, newIndex: number) => {
      const reorderInItems = (items: NavigationItem[]): NavigationItem[] => {
        return items.map((item) => {
          if (item.id === parentId && item.subMenu) {
            return {
              ...item,
              subMenu: moveNavigationItem(item.subMenu, oldIndex, newIndex),
            };
          }
          if (item.subMenu) {
            return { ...item, subMenu: reorderInItems(item.subMenu) };
          }
          return item;
        });
      };
      onChange(reorderInItems(navigation));
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
  const maxDepth = navigation.length > 0 ? getMaxDepth(navigation) + 1 : 0;

  const renderNavigationTable = () => (
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
        {navigation.length === 0 ? (
          <TableRow>
            <td colSpan={4} className="py-12 text-center">
              <Menu className="h-5 w-5 mx-auto mb-2 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground mb-3">
                No links yet. Add a published page, category, custom link, or label.
              </p>
              <Button onClick={handleAddRoot} size="sm">
                <Plus className="h-4 w-4 mr-2" />
                Add First Item
              </Button>
            </td>
          </TableRow>
        ) : (
          <NavigationTreeRows
            navigation={navigation}
            maxDepth={MAX_NAV_DEPTH}
            onUpdate={updateItem}
            onRemove={removeItem}
            onAddChild={handleAddChild}
            onIndent={handleIndent}
            onOutdent={handleOutdent}
            parentPath=""
            getStorefrontPath={getStorefrontPath}
            onReorderRequest={() => setIsReorderMode(true)}
            canReorder={canReorderItems}
          />
        )}
      </TableBody>
    </Table>
  );

  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader className="px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Menu className="h-4 w-4" />
              Menu structure
            </CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Keep labels short. Nest up to {MAX_NAV_DEPTH} levels for desktop and mobile.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="h-8 font-normal">
              <Layers className="h-3 w-3 mr-1" />
              {totalItems} items · {maxDepth} levels
            </Badge>
            {isReorderMode ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setIsReorderMode(false)}
              >
                <Check className="h-4 w-4 mr-1" />
                Done
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setIsReorderMode(true)}
                disabled={!canReorderItems}
              >
                <GripVertical className="h-4 w-4 mr-1" />
                Reorder
              </Button>
            )}
            <Button size="sm" onClick={handleAddRoot}>
              <Plus className="h-4 w-4 mr-1" />
              Add Item
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <div className="border-t">
          {isReorderMode && navigation.length > 0 ? (
            <Suspense fallback={renderNavigationTable()}>
              <SortableNavigationEditor
                navigation={navigation}
                maxDepth={MAX_NAV_DEPTH}
                onUpdate={updateItem}
                onRemove={removeItem}
                onAddChild={handleAddChild}
                onIndent={handleIndent}
                onOutdent={handleOutdent}
                getStorefrontPath={getStorefrontPath}
                onRootReorder={handleRootReorder}
                onReorderSubmenu={handleReorderSubmenu}
              />
            </Suspense>
          ) : (
            renderNavigationTable()
          )}
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
