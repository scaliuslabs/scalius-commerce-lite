import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "@tanstack/react-router";
import { Checkbox } from "~/components/ui/checkbox";
import { Badge } from "~/components/ui/badge";
import { formatDateShort as formatDate } from "@scalius/shared/timestamps";
import { ExternalLink } from "lucide-react";
import { DataTableColumnHeader } from "../DataTableColumnHeader";
import { DataTableRowActions } from "../DataTableRowActions";
import type { Page } from "~/types/api-responses";

interface PageColumnOptions {
  showTrashed: boolean;
  getStorefrontPath: (path: string) => string;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
}

export function getPageColumns(
  opts: PageColumnOptions,
): ColumnDef<Page, unknown>[] {
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
          aria-label={`Select ${row.original.title}`}
        />
      ),
      enableSorting: false,
      enableHiding: false,
      size: 40,
    },
    {
      accessorKey: "title",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Title" />
      ),
      cell: ({ row }) => (
        <span className="font-medium">{row.original.title}</span>
      ),
      size: 200,
    },
    {
      accessorKey: "slug",
      header: "Slug",
      cell: ({ row }) => {
        const page = row.original;
        return (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <span>{page.slug}</span>
            {!opts.showTrashed && (
              <a
                href={opts.getStorefrontPath(`/${page.slug}`)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-primary transition-colors"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        );
      },
      enableSorting: false,
    },
    {
      accessorKey: "sortOrder",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Sort Order" />
      ),
      cell: ({ row }) => row.original.sortOrder,
      size: 100,
    },
    {
      accessorKey: "isPublished",
      header: "Status",
      cell: ({ row }) =>
        row.original.isPublished ? (
          <Badge
            variant="default"
            className="bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-950/50 dark:text-green-400"
          >
            Published
          </Badge>
        ) : (
          <Badge variant="secondary">Draft</Badge>
        ),
      enableSorting: false,
      size: 100,
    },
    {
      accessorKey: "updatedAt",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Last Updated" />
      ),
      cell: ({ row }) => formatDate(row.original.updatedAt),
      size: 130,
    },
    {
      id: "actions",
      cell: ({ row }) => (
        <DataTableRowActions
          showTrashed={opts.showTrashed}
          onView={
            !opts.showTrashed
              ? () => {
                  window.open(
                    opts.getStorefrontPath(`/${row.original.slug}`),
                    "_blank",
                  );
                }
              : undefined
          }
          onEdit={() => opts.onEdit(row.original.id)}
          onDelete={() => opts.onDelete(row.original.id)}
          onRestore={() => opts.onRestore(row.original.id)}
          onPermanentDelete={() => opts.onPermanentDelete(row.original.id)}
        />
      ),
      enableSorting: false,
      size: 70,
    },
  ];
}
