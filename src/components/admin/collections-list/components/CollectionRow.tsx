// src/components/admin/collections-list/components/CollectionRow.tsx
import { useState, useEffect, forwardRef } from "react";
import { TableRow, TableCell } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  Trash2,
  Undo,
  XCircle,
  Pencil,
  Eye,
  GripVertical,
  LayoutGrid,
  GridIcon,
} from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";
import { cn } from "@/lib/utils";
import type { CollectionRowProps } from "../types";

export const CollectionRow = forwardRef<
  HTMLTableRowElement,
  CollectionRowProps & any
>(
  (
    {
      collection,
      onUpdate,
      onDelete,
      onRestore,
      onToggleSelection,
      onPermanentDelete,
      isSelected,
      isSaving,
      isActionLoading,
      showTrashed,
      dragHandleProps,
      isDragging,
      ...props
    },
    ref,
  ) => {
    const [name, setName] = useState(collection.name);
    const [isActive, setIsActive] = useState(collection.isActive);

    const debouncedName = useDebounce(name, 700);

    useEffect(() => {
      setName(collection.name);
      setIsActive(collection.isActive);
    }, [collection]);

    useEffect(() => {
      if (debouncedName !== collection.name && debouncedName.length >= 2) {
        onUpdate(collection.id, { name: debouncedName });
      }
    }, [debouncedName, collection.name, collection.id, onUpdate]);

    const handleActiveChange = (checked: boolean) => {
      setIsActive(checked);
      onUpdate(collection.id, { isActive: checked });
    };

    const getCollectionTypeLabel = (type: string) => {
      switch (type) {
        case "collection1":
          return "Style 1";
        case "collection2":
          return "Style 2";
        default:
          return type;
      }
    };

    const getCollectionTypeIcon = (type: string) => {
      switch (type) {
        case "collection1":
          return (
            <LayoutGrid className="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" />
          );
        case "collection2":
          return (
            <GridIcon className="h-3.5 w-3.5 text-purple-500 dark:text-purple-400" />
          );
        default:
          return <LayoutGrid className="h-3.5 w-3.5" />;
      }
    };

    const getContentSource = () => {
      try {
        const config = JSON.parse(collection.config);
        const categoryIds = config.categoryIds || [];
        const productIds = config.productIds || [];

        if (categoryIds.length > 0) {
          return (
            <span className="text-sm text-muted-foreground">
              {categoryIds.length}{" "}
              {categoryIds.length === 1 ? "category" : "categories"}
              {productIds.length > 0 &&
                ` + ${productIds.length} product${productIds.length === 1 ? "" : "s"}`}
            </span>
          );
        } else if (productIds.length > 0) {
          return (
            <span className="text-sm text-muted-foreground">
              {productIds.length} specific product
              {productIds.length === 1 ? "" : "s"}
            </span>
          );
        }
        return (
          <span className="text-sm text-muted-foreground">No products</span>
        );
      } catch (e) {
        return <span className="text-sm text-muted-foreground">N/A</span>;
      }
    };

    return (
      <TableRow
        ref={ref}
        data-state={isSelected ? "selected" : undefined}
        className={cn(
          isSaving && "opacity-70",
          isDragging &&
            "bg-blue-50 border-y border-blue-200 dark:bg-blue-950/30 dark:border-blue-800/60",
        )}
        {...props}
      >
        {!showTrashed && (
          <TableCell className="w-10">
            <div
              {...dragHandleProps}
              className="cursor-grab hover:bg-muted p-1 rounded"
            >
              <GripVertical className="w-4 h-4 text-muted-foreground" />
            </div>
          </TableCell>
        )}
        <TableCell className="w-10">
          <Checkbox checked={isSelected} onCheckedChange={onToggleSelection} />
        </TableCell>
        <TableCell>
          <div className="relative">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={cn("h-9 text-sm", isSaving && "pr-8")}
              disabled={!!collection.deletedAt || isActionLoading}
            />
            {isSaving && (
              <Loader2 className="h-3 w-3 animate-spin absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            )}
          </div>
        </TableCell>
        <TableCell>
          <div className="flex items-center space-x-2">
            {getCollectionTypeIcon(collection.type)}
            <span className="text-sm">
              {getCollectionTypeLabel(collection.type)}
            </span>
          </div>
        </TableCell>
        <TableCell>{getContentSource()}</TableCell>
        <TableCell>
          <div className="flex items-center gap-2">
            <Switch
              checked={isActive}
              onCheckedChange={handleActiveChange}
              disabled={!!collection.deletedAt || isActionLoading}
            />
            <Badge
              variant={isActive ? "default" : "secondary"}
              className={
                isActive
                  ? "bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-950/50 dark:text-green-400"
                  : "bg-muted text-muted-foreground"
              }
            >
              {isActive ? "Active" : "Inactive"}
            </Badge>
          </div>
        </TableCell>
        <TableCell className="text-right">
          <div className="flex justify-end gap-1">
            {!showTrashed && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  asChild
                  title="Edit collection"
                >
                  <a href={`/admin/collections/${collection.id}/edit`}>
                    <Pencil className="h-4 w-4 text-muted-foreground hover:text-primary transition-colors" />
                  </a>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  asChild
                  title="Preview collection"
                >
                  <a
                    href={`/?preview=collection&id=${collection.id}`}
                    target="_blank"
                  >
                    <Eye className="h-4 w-4 text-muted-foreground hover:text-primary transition-colors" />
                  </a>
                </Button>
              </>
            )}
            {showTrashed ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onRestore}
                  disabled={isSaving || isActionLoading}
                  title="Restore collection"
                >
                  {isSaving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Undo className="h-4 w-4 text-primary" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onPermanentDelete}
                  disabled={isSaving || isActionLoading}
                  title="Permanently delete collection"
                >
                  {isSaving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive" />
                  )}
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={onDelete}
                disabled={isSaving || isActionLoading}
                title="Move to trash"
              >
                {isSaving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive transition-colors" />
                )}
              </Button>
            )}
          </div>
        </TableCell>
      </TableRow>
    );
  },
);

CollectionRow.displayName = "CollectionRow";
