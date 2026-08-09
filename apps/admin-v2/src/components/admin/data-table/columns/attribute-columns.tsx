import type { ColumnDef } from "../table-config";
import { Switch } from "~/components/ui/switch";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Filter, Edit3 } from "lucide-react";
import { DataTableColumnHeader } from "../DataTableColumnHeader";
import { InlineEditCell } from "../InlineEditCell";
import { createSelectColumn, createActionsColumn } from "./column-factories";
import type { ProductAttribute } from "~/types/api-responses";

export interface AttributeItem extends ProductAttribute {
  valueCount?: number;
}

interface AttributeColumnOptions {
  showTrashed: boolean;
  savingIds: Set<string>;
  canSelect: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canRestore: boolean;
  canPermanentDelete: boolean;
  onUpdateName: (id: string, name: string) => void;
  onUpdateSlug: (id: string, slug: string) => void;
  onToggleFilterable: (id: string, filterable: boolean) => void;
  onViewValues: (id: string, name: string) => void;
  onEditValues: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
}

export function getAttributeColumns(
  opts: AttributeColumnOptions,
): ColumnDef<AttributeItem, unknown>[] {
  const canShowActions = opts.showTrashed
    ? opts.canRestore || opts.canPermanentDelete
    : opts.canEdit || opts.canDelete;

  return [
    ...(opts.canSelect
      ? [
          createSelectColumn<AttributeItem>({
            getLabel: (r) => (r as AttributeItem).name,
          }),
        ]
      : []),
    {
      accessorKey: "name",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Attribute Name" />
      ),
      cell: ({ row }) => {
        const attribute = row.original;
        const isSaving = opts.savingIds.has(attribute.id);
        const isDisabled =
          !opts.canEdit || !!attribute.deletedAt || opts.showTrashed;

        return (
          <InlineEditCell
            value={attribute.name}
            onSave={(newName) => opts.onUpdateName(attribute.id, newName)}
            disabled={isDisabled}
            isSaving={isSaving}
            minLength={2}
            placeholder="Attribute name"
          />
        );
      },
      size: 200,
    },
    {
      accessorKey: "slug",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Slug" />
      ),
      cell: ({ row }) => {
        const attribute = row.original;
        const isSaving = opts.savingIds.has(attribute.id);
        const isDisabled =
          !opts.canEdit || !!attribute.deletedAt || opts.showTrashed;

        return (
          <InlineEditCell
            value={attribute.slug}
            onSave={(newSlug) => opts.onUpdateSlug(attribute.id, newSlug)}
            disabled={isDisabled}
            isSaving={isSaving}
            minLength={2}
            placeholder="attribute-slug"
            className="h-8 text-sm font-mono"
          />
        );
      },
      size: 200,
    },
    {
      accessorKey: "filterable",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Filterable" />
      ),
      cell: ({ row }) => {
        const attribute = row.original;
        const isDisabled =
          !opts.canEdit || !!attribute.deletedAt || opts.showTrashed;

        return (
          <div className="flex items-center gap-2">
            <Switch
              aria-label={`${attribute.filterable ? "Disable" : "Enable"} storefront filtering for ${attribute.name}`}
              checked={attribute.filterable}
              onCheckedChange={(checked) =>
                opts.onToggleFilterable(attribute.id, checked)
              }
              disabled={isDisabled}
            />
            {attribute.filterable && (
              <Badge variant="secondary" className="text-xs">
                <Filter className="h-3 w-3 mr-1" />
                Filterable
              </Badge>
            )}
          </div>
        );
      },
    },
    {
      id: "valueCount",
      header: "Assigned values",
      cell: ({ row }) => {
        const attribute = row.original;
        return (
          <div className="text-center">
            <Button
              variant="ghost"
              size="sm"
              aria-label={`View ${attribute.name} values and product usage`}
              onClick={() => opts.onViewValues(attribute.id, attribute.name)}
              disabled={opts.showTrashed || Boolean(attribute.deletedAt)}
              className="h-auto p-1"
              title={`${attribute.valueCount ?? 0} assigned values; ${(attribute.options ?? []).length} saved presets`}
            >
              <Badge
                variant="outline"
                className="font-mono text-xs hover:bg-accent cursor-pointer"
              >
                {attribute.valueCount ?? 0}
              </Badge>
            </Button>
          </div>
        );
      },
      enableSorting: false,
    },
    ...(canShowActions
      ? [
          createActionsColumn<AttributeItem>({
            showTrashed: opts.showTrashed,
            onDelete: opts.canDelete
              ? (a) => opts.onDelete(a.id)
              : undefined,
            onRestore: opts.canRestore
              ? (a) => opts.onRestore(a.id)
              : undefined,
            onPermanentDelete: opts.canPermanentDelete
              ? (a) => opts.onPermanentDelete(a.id)
              : undefined,
            getExtraActions: (a) =>
              !opts.showTrashed && opts.canEdit
                ? [
                    {
                      label: "Edit Values",
                      icon: Edit3,
                      onClick: () => opts.onEditValues(a.id, a.name),
                    },
                  ]
                : undefined,
          }),
        ]
      : []),
  ];
}
