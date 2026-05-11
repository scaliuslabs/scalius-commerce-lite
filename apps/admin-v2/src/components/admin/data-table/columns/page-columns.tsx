import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "~/components/ui/badge";
import { ExternalLink } from "lucide-react";
import { DataTableColumnHeader } from "../DataTableColumnHeader";
import { createSelectColumn, createDateColumn, createActionsColumn } from "./column-factories";
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
    createSelectColumn<Page>({ getLabel: (r) => (r as Page).title }),
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
    createDateColumn<Page>("updatedAt", "Last Updated"),
    createActionsColumn<Page>({
      showTrashed: opts.showTrashed,
      onView: !opts.showTrashed
        ? (p) => window.open(opts.getStorefrontPath(`/${p.slug}`), "_blank")
        : undefined,
      onEdit: (p) => opts.onEdit(p.id),
      onDelete: (p) => opts.onDelete(p.id),
      onRestore: (p) => opts.onRestore(p.id),
      onPermanentDelete: (p) => opts.onPermanentDelete(p.id),
    }),
  ];
}
