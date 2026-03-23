import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "@tanstack/react-router";
import { Checkbox } from "~/components/ui/checkbox";
import { Tag } from "lucide-react";
import { formatDateShort as formatDate } from "@scalius/shared/timestamps";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { cn } from "@scalius/shared/utils";
import { DataTableColumnHeader } from "../DataTableColumnHeader";
import { DataTableRowActions } from "../DataTableRowActions";
import type { Category } from "~/types/api-responses";

/** Extended category type that includes the product count from list responses */
export interface CategoryListItem extends Category {
  productCount?: number;
}

interface CategoryColumnOptions {
  showTrashed: boolean;
  getStorefrontPath: (path: string) => string;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
}

function getPlainDescription(html: string | null, maxLength = 60): string {
  if (!html) return "";
  let text = html;
  let prev = "";
  while (prev !== text) {
    prev = text;
    text = text.replace(/<[^>]*>/g, "");
  }
  text = text.replace(/&nbsp;/g, " ").trim();
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength).trim() + "...";
}

export function getCategoryColumns(
  opts: CategoryColumnOptions,
): ColumnDef<CategoryListItem, unknown>[] {
  return [
    {
      id: "select",
      header: ({ table }) => (
        <Checkbox
          checked={
            table.getIsAllPageRowsSelected() ||
            (table.getIsSomePageRowsSelected() && "indeterminate")
          }
          onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
          aria-label="Select all"
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(v) => row.toggleSelected(!!v)}
          aria-label={`Select ${row.original.name}`}
        />
      ),
      enableSorting: false,
      enableHiding: false,
      size: 40,
    },
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
              <Link
                to={`/admin/categories/${category.id}/edit` as string}
                className="font-medium text-sm text-foreground hover:text-primary cursor-pointer truncate"
              >
                {category.name}
              </Link>
              <span className="text-xs text-muted-foreground truncate">
                {category.slug}
              </span>
              {category.description ? (
                <span className="text-xs text-muted-foreground/70 truncate">
                  {getPlainDescription(category.description)}
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
              >
                view
              </Link>
            )}
          </div>
        );
      },
      enableSorting: false,
      size: 100,
    },
    {
      accessorKey: "updatedAt",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Last Updated" />
      ),
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {formatDate(row.original.updatedAt)}
        </span>
      ),
      size: 130,
    },
    {
      id: "actions",
      cell: ({ row }) => {
        const category = row.original;
        return (
          <DataTableRowActions
            showTrashed={opts.showTrashed}
            onView={
              !opts.showTrashed
                ? () => {
                    window.open(
                      opts.getStorefrontPath(`/categories/${category.slug}`),
                      "_blank",
                    );
                  }
                : undefined
            }
            onEdit={() => opts.onEdit(category.id)}
            onDelete={() => opts.onDelete(category.id)}
            onRestore={() => opts.onRestore(category.id)}
            onPermanentDelete={() => opts.onPermanentDelete(category.id)}
          />
        );
      },
      enableSorting: false,
      size: 70,
    },
  ];
}
