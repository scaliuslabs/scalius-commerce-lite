import type { ColumnDef } from "@tanstack/react-table";
import { Switch } from "~/components/ui/switch";
import { Badge } from "~/components/ui/badge";
import { LayoutGrid, GridIcon } from "lucide-react";
import { DataTableColumnHeader } from "../DataTableColumnHeader";
import { InlineEditCell } from "../InlineEditCell";
import { createSelectColumn, createActionsColumn } from "./column-factories";
import type { Collection } from "~/types/api-responses";
import { normalizeCollectionConfig } from "@scalius/core/modules/collections/collection-config";

export interface CollectionItem extends Collection {
  productCount?: number;
}

interface CollectionColumnOptions {
  showTrashed: boolean;
  savingIds: Set<string>;
  canSelect: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canRestore: boolean;
  canPermanentDelete: boolean;
  canToggleStatus: boolean;
  onUpdateName: (id: string, version: number, name: string) => void;
  onToggleActive: (id: string, version: number, isActive: boolean) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
}

function getCollectionPresentationLabel(presentation: string): string {
  switch (presentation) {
    case "grid":
      return "Featured grid";
    case "carousel":
      return "Carousel";
    default:
      return presentation;
  }
}

function getCollectionPresentationIcon(presentation: string) {
  switch (presentation) {
    case "grid":
      return (
        <LayoutGrid className="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" />
      );
    case "carousel":
      return (
        <GridIcon className="h-3.5 w-3.5 text-purple-500 dark:text-purple-400" />
      );
    default:
      return <LayoutGrid className="h-3.5 w-3.5" />;
  }
}

function getContentSource(config: string) {
  try {
    const parsed = normalizeCollectionConfig(config);
    if (parsed.source === "dynamic") {
      return (
        <span className="text-sm text-muted-foreground">
          Dynamic · {parsed.categoryIds.length}{" "}
          {parsed.categoryIds.length === 1 ? "category" : "categories"}
        </span>
      );
    }
    if (parsed.productIds.length > 0) {
      return (
        <span className="text-sm text-muted-foreground">
          Manual · {parsed.productIds.length} product
          {parsed.productIds.length === 1 ? "" : "s"}
        </span>
      );
    }
    return (
      <span className="text-sm text-muted-foreground">Manual · no products</span>
    );
  } catch {
    return <span className="text-sm text-muted-foreground">N/A</span>;
  }
}

export function getCollectionColumns(
  opts: CollectionColumnOptions,
): ColumnDef<CollectionItem, unknown>[] {
  const canShowActions = opts.showTrashed
    ? opts.canRestore || opts.canPermanentDelete
    : opts.canEdit || opts.canDelete;

  return [
    ...(opts.canSelect
      ? [
          createSelectColumn<CollectionItem>({
            getLabel: (r) => (r as CollectionItem).name,
          }),
        ]
      : []),
    {
      accessorKey: "name",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Collection Name" />
      ),
      cell: ({ row }) => {
        const collection = row.original;
        const isSaving = opts.savingIds.has(collection.id);
        const isDisabled =
          !opts.canEdit || !!collection.deletedAt || opts.showTrashed;

        return (
          <InlineEditCell
            value={collection.name}
            onSave={(newName) => opts.onUpdateName(collection.id, collection.version, newName)}
            disabled={isDisabled}
            isSaving={isSaving}
            minLength={3}
            placeholder="Collection name"
          />
        );
      },
      size: 250,
    },
    {
      accessorKey: "presentation",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Presentation" />
      ),
      cell: ({ row }) => (
        <div className="flex items-center space-x-2">
          {getCollectionPresentationIcon(row.original.presentation)}
          <span className="text-sm">
            {getCollectionPresentationLabel(row.original.presentation)}
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
        const isDisabled =
          !opts.canToggleStatus || !!collection.deletedAt || opts.showTrashed;
        const isTrashed = !!collection.deletedAt || opts.showTrashed;

        return (
          <div className="flex items-center gap-2">
            {!isTrashed && (
              <Switch
                checked={collection.isActive}
                aria-label={`${collection.isActive ? "Deactivate" : "Activate"} ${collection.name}`}
                onCheckedChange={(checked) =>
                  opts.onToggleActive(collection.id, collection.version, checked)
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
    ...(canShowActions
      ? [
          createActionsColumn<CollectionItem>({
            showTrashed: opts.showTrashed,
            onEdit: opts.canEdit ? (c) => opts.onEdit(c.id) : undefined,
            onDelete: opts.canDelete
              ? (c) => opts.onDelete(c.id)
              : undefined,
            onRestore: opts.canRestore
              ? (c) => opts.onRestore(c.id)
              : undefined,
            onPermanentDelete: opts.canPermanentDelete
              ? (c) => opts.onPermanentDelete(c.id)
              : undefined,
          }),
        ]
      : []),
  ];
}
