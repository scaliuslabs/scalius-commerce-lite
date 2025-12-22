// src/components/admin/navigation/SortableNavItem.tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableRow, TableCell } from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Plus,
  Trash2,
  GripVertical,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Link2,
  MoreVertical,
  ArrowLeft,
  ArrowRight,
  Type,
} from "lucide-react";
import { Draggable, Droppable } from "@hello-pangea/dnd";
import { cn } from "@/lib/utils";
import type { NavigationItem } from "./types";
import { MAX_NAV_DEPTH, getDepthColor } from "./types";

interface SortableNavItemProps {
  item: NavigationItem;
  index: number;
  depth: number;
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
  parentPath: string;
  getStorefrontPath: (path: string) => string;
  canIndent: boolean;
  canOutdent: boolean;
}

export function SortableNavItem({
  item,
  index,
  depth,
  maxDepth = MAX_NAV_DEPTH,
  onUpdate,
  onRemove,
  onAddChild,
  onIndent,
  onOutdent,
  parentPath,
  getStorefrontPath,
  canIndent,
  canOutdent,
}: SortableNavItemProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const currentPath = parentPath ? `${parentPath}.${index}` : `${index}`;
  const droppableId = `submenu-${item.id}`;
  const hasSubMenu = item.subMenu && item.subMenu.length > 0;
  const isLabel = !item.href;
  const hasLinkAndSubmenu = item.href && hasSubMenu;
  const canAddChildren = depth < maxDepth;

  // Calculate indentation
  const indentPadding = depth * 20;

  return (
    <>
      <Draggable draggableId={item.id} index={index}>
        {(provided, snapshot) => (
          <TableRow
            ref={provided.innerRef}
            {...provided.draggableProps}
            className={cn(
              "group transition-all border-l-4",
              getDepthColor(depth),
              snapshot.isDragging
                ? "bg-primary/10 shadow-lg ring-2 ring-primary/30"
                : "hover:bg-muted/30",
            )}
          >
            {/* Drag Handle & Expand */}
            <TableCell
              className="p-2 w-[60px]"
              style={{ paddingLeft: `${8 + indentPadding}px` }}
            >
              <div className="flex items-center gap-0.5">
                {hasSubMenu ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={() => setIsExpanded(!isExpanded)}
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                  </Button>
                ) : (
                  <div className="w-6" />
                )}
                <div
                  {...provided.dragHandleProps}
                  className="flex h-7 w-7 cursor-grab items-center justify-center rounded hover:bg-muted"
                >
                  <GripVertical className="h-4 w-4 text-muted-foreground" />
                </div>
              </div>
            </TableCell>

            {/* Label Input */}
            <TableCell className="p-2">
              <div className="flex items-center gap-2">
                <Input
                  value={item.title}
                  onChange={(e) =>
                    onUpdate(parentPath, index, { title: e.target.value })
                  }
                  className="h-8 text-sm"
                  placeholder="Menu label"
                />
                {/* Badges */}
                <div className="flex items-center gap-1 shrink-0">
                  {depth > 0 && (
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0"
                    >
                      L{depth + 1}
                    </Badge>
                  )}
                  {isLabel && !hasSubMenu && (
                    <Badge
                      variant="secondary"
                      className="text-[10px] px-1.5 py-0 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                    >
                      <Type className="h-2.5 w-2.5 mr-0.5" />
                      Label
                    </Badge>
                  )}
                  {hasLinkAndSubmenu && (
                    <Badge
                      variant="secondary"
                      className="text-[10px] px-1.5 py-0 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                    >
                      <Link2 className="h-2.5 w-2.5 mr-0.5" />
                      Link+Menu
                    </Badge>
                  )}
                  {hasSubMenu && (
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0"
                    >
                      {item.subMenu?.length} items
                    </Badge>
                  )}
                </div>
              </div>
            </TableCell>

            {/* URL Input */}
            <TableCell className="p-2">
              <div className="flex items-center gap-1">
                <Input
                  value={item.href || ""}
                  onChange={(e) =>
                    onUpdate(parentPath, index, {
                      href: e.target.value || undefined,
                    })
                  }
                  className="h-8 text-sm"
                  placeholder="URL (empty = label only)"
                />
                {item.href && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => {
                      let url = item.href!;
                      if (!url.startsWith("http")) {
                        if (!url.startsWith("/")) url = `/${url}`;
                        url = getStorefrontPath(url);
                      }
                      window.open(url, "_blank");
                    }}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </TableCell>

            {/* Actions */}
            <TableCell className="p-2 w-[100px]">
              <div className="flex items-center justify-end gap-0.5">
                {canAddChildren && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => onAddChild(currentPath)}
                    title="Add child item"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                )}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7">
                      <MoreVertical className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {canIndent && (
                      <DropdownMenuItem
                        onClick={() => onIndent(parentPath, index)}
                      >
                        <ArrowRight className="h-4 w-4 mr-2" />
                        Indent (make child)
                      </DropdownMenuItem>
                    )}
                    {canOutdent && (
                      <DropdownMenuItem
                        onClick={() => onOutdent(parentPath, index)}
                      >
                        <ArrowLeft className="h-4 w-4 mr-2" />
                        Outdent (move up)
                      </DropdownMenuItem>
                    )}
                    {(canIndent || canOutdent) && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      onClick={() => onRemove(parentPath, index)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </TableCell>
          </TableRow>
        )}
      </Draggable>

      {/* Render children recursively */}
      {hasSubMenu && isExpanded && (
        <Droppable droppableId={droppableId} type={`SUBMENU_${item.id}`}>
          {(provided, snapshot) => (
            <tr>
              <td colSpan={4} className="p-0">
                <Table>
                  <TableBody
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className={cn(
                      "divide-y divide-border",
                      snapshot.isDraggingOver && "bg-primary/5",
                    )}
                  >
                    {item.subMenu?.map((subItem, subIndex) => (
                      <SortableNavItem
                        key={subItem.id}
                        item={subItem}
                        index={subIndex}
                        depth={depth + 1}
                        maxDepth={maxDepth}
                        onUpdate={onUpdate}
                        onRemove={onRemove}
                        onAddChild={onAddChild}
                        onIndent={onIndent}
                        onOutdent={onOutdent}
                        parentPath={currentPath}
                        getStorefrontPath={getStorefrontPath}
                        canIndent={subIndex > 0 && depth < maxDepth - 1}
                        canOutdent={depth > 0}
                      />
                    ))}
                    {provided.placeholder}
                  </TableBody>
                </Table>
              </td>
            </tr>
          )}
        </Droppable>
      )}
    </>
  );
}
