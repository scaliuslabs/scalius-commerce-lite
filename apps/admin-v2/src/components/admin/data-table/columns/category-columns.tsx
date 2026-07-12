import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "@tanstack/react-router";
import { Tag } from "lucide-react";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { cn } from "@scalius/shared/utils";
import { DataTableColumnHeader } from "../DataTableColumnHeader";
import { createSelectColumn, createDateColumn, createActionsColumn } from "./column-factories";
import type { Category } from "~/types/api-responses";
import { getPlainText } from "~/lib/format-utils";

/** Extended category type that includes the product count from list responses */
export interface CategoryListItem extends Category {
  productCount?: number;
}

interface CategoryColumnOptions {
  showTrashed: boolean;
  getStorefrontPath: (path: string) => string;
  canSelect: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canRestore: boolean;
  canPermanentDelete: boolean;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
}

export function getCategoryColumns(
  opts: CategoryColumnOptions,
): ColumnDef<CategoryListItem, unknown>[] {
  const canShowActions = !opts.showTrashed ||
    opts.canRestore ||
    opts.canPermanentDelete;

  return [
    ...(opts.canSelect
      ? [
          createSelectColumn<CategoryListItem>({
            getLabel: (r) => (r as CategoryListItem).name,
          }),
        ]
      : []),
    {
      accessorKey: "name",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Category" />
      ),
      cell: ({ row }) => {
        const category = row.original;
        return (
          <div className="flex items-center gap-3">
            {category.imageUrl ? (
              <div className="h-11 w-11 rounded-lg overflow-hidden border bg-muted shrink-0">
                <img
                  src={getOptimizedImageUrl(category.imageUrl)}
                  alt={category.name}
                  className="h-full w-full object-cover"
                  loading="lazy"
                  decoding="async"
                />
              </div>
            ) : (
              <div className="h-11 w-11 rounded-lg border bg-muted/50 flex items-center justify-center shrink-0">
                <Tag className="h-5 w-5 text-muted-foreground/50" />
              </div>
            )}
            <div className="flex flex-col min-w-0">
              {opts.canEdit && !opts.showTrashed ? (
                <Link
                  to={`/admin/categories/${category.id}/edit` as string}
                  className="font-medium text-sm text-foreground hover:text-primary cursor-pointer truncate"
                >
                  {category.name}
                </Link>
              ) : (
                <span className="truncate text-sm font-medium text-foreground">
                  {category.name}
                </span>
              )}
              <span className="text-xs text-muted-foreground truncate">
                {category.slug}
              </span>
              {category.description ? (
                <span className="text-xs text-muted-foreground/70 truncate">
                  {getPlainText(category.description)}
                </span>
              ) : null}
            </div>
          </div>
        );
      },
      size: 300,
    },
    {
      id: "productCount",
      header: "Products",
      cell: ({ row }) => {
        const count = row.original.productCount ?? 0;
        return (
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "text-sm tabular-nums",
                count > 0
                  ? "text-foreground font-medium"
                  : "text-muted-foreground/60",
              )}
            >
              {count}
            </span>
            {count > 0 && (
              <Link
                to={`/admin/products?category=${row.original.id}` as string}
                className="text-xs text-primary/80 hover:text-primary hover:underline"
                aria-label={`View products in ${row.original.name}`}
              >
                View
              </Link>
            )}
          </div>
        );
      },
      enableSorting: false,
      size: 100,
    },
    createDateColumn<CategoryListItem>("updatedAt", "Last Updated"),
    ...(canShowActions
      ? [
          createActionsColumn<CategoryListItem>({
            showTrashed: opts.showTrashed,
            onView: !opts.showTrashed
              ? (c) =>
                  window.open(
                    opts.getStorefrontPath(`/categories/${c.slug}`),
                    "_blank",
                  )
              : undefined,
            onEdit: opts.canEdit && !opts.showTrashed ? (c) => opts.onEdit(c.id) : undefined,
            onDelete: opts.canDelete && !opts.showTrashed
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
