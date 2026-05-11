import type { ColumnDef } from "@tanstack/react-table";
import { Switch } from "~/components/ui/switch";
import { Badge } from "~/components/ui/badge";
import { LayoutGrid, GridIcon } from "lucide-react";
import { DataTableColumnHeader } from "../DataTableColumnHeader";
import { InlineEditCell } from "../InlineEditCell";
import { createSelectColumn, createActionsColumn } from "./column-factories";
import type { Collection } from "~/types/api-responses";

export interface CollectionItem extends Collection {
  productCount?: number;
}

interface CollectionColumnOptions {
  showTrashed: boolean;
  savingIds: Set<string>;
  onUpdateName: (id: string, name: string) => void;
  onToggleActive: (id: string, isActive: boolean) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
}

function getCollectionTypeLabel(type: string): string {
  switch (type) {
    case "manual":
      return "Manual (Grid)";
    case "dynamic":
      return "Dynamic (Carousel)";
    default:
      return type;
  }
}

function getCollectionTypeIcon(type: string) {
  switch (type) {
    case "manual":
      return (
        <LayoutGrid className="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" />
      );
    case "dynamic":
      return (
        <GridIcon className="h-3.5 w-3.5 text-purple-500 dark:text-purple-400" />
      );
    default:
      return <LayoutGrid className="h-3.5 w-3.5" />;
  }
}

function getContentSource(config: string) {
  try {
    const parsed = JSON.parse(config);
    const categoryIds = parsed.categoryIds || [];
    const productIds = parsed.productIds || [];

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
  } catch {
    return <span className="text-sm text-muted-foreground">N/A</span>;
  }
}

export function getCollectionColumns(
  opts: CollectionColumnOptions,
): ColumnDef<CollectionItem, unknown>[] {
  return [
    createSelectColumn<CollectionItem>({ getLabel: (r) => (r as CollectionItem).name }),
    {
      accessorKey: "name",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Collection Name" />
      ),
      cell: ({ row }) => {
        const collection = row.original;
        const isSaving = opts.savingIds.has(collection.id);
        const isDisabled = !!collection.deletedAt || opts.showTrashed;

        return (
          <InlineEditCell
            value={collection.name}
            onSave={(newName) => opts.onUpdateName(collection.id, newName)}
            disabled={isDisabled}
            isSaving={isSaving}
            minLength={2}
            placeholder="Collection name"
          />
        );
      },
      size: 250,
    },
    {
      accessorKey: "type",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Type" />
      ),
      cell: ({ row }) => (
        <div className="flex items-center space-x-2">
          {getCollectionTypeIcon(row.original.type)}
          <span className="text-sm">
            {getCollectionTypeLabel(row.original.type)}
          </span>
        </div>
      ),
    },
    {
      id: "contentSource",
      header: "Content Source",
      cell: ({ row }) => getContentSource(row.original.config),
      enableSorting: false,
    },
    {
      accessorKey: "isActive",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Status" />
      ),
      cell: ({ row }) => {
        const collection = row.original;
        const isDisabled = !!collection.deletedAt || opts.showTrashed;
        const isTrashed = !!collection.deletedAt || opts.showTrashed;

        return (
          <div className="flex items-center gap-2">
            {!isTrashed && (
              <Switch
                checked={collection.isActive}
                onCheckedChange={(checked) =>
                  opts.onToggleActive(collection.id, checked)
                }
                disabled={isDisabled}
              />
            )}
            <Badge
              variant={isTrashed ? "secondary" : collection.isActive ? "default" : "secondary"}
              className={
                isTrashed
                  ? "bg-muted text-muted-foreground"
                  : collection.isActive
                  ? "bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-950/50 dark:text-green-400"
                  : "bg-muted text-muted-foreground"
              }
            >
              {isTrashed ? "Trashed" : collection.isActive ? "Active" : "Inactive"}
            </Badge>
          </div>
        );
      },
    },
    createActionsColumn<CollectionItem>({
      showTrashed: opts.showTrashed,
      onEdit: (c) => opts.onEdit(c.id),
      onDelete: (c) => opts.onDelete(c.id),
      onRestore: (c) => opts.onRestore(c.id),
      onPermanentDelete: (c) => opts.onPermanentDelete(c.id),
    }),
  ];
}
