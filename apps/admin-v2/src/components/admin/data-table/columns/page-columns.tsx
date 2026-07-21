import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { DataTableColumnHeader } from "../DataTableColumnHeader";
import {
  createSelectColumn,
  createDateColumn,
  createActionsColumn,
} from "./column-factories";
import type { Page } from "~/types/api-responses";
import type { PageRevisionClaim } from "~/lib/api-functions/pages";
import { PagePublicationBadge } from "~/components/admin/pages/PagePublicationBadge";
import { getPagePublicationMode, isPageLive } from "~/lib/page-publication";
import { formatDate } from "@scalius/shared/timestamps";

interface PageColumnOptions {
  contentType?: "page" | "article";
  showTrashed: boolean;
  getStorefrontPath: (path: string) => string;
  canEdit: boolean;
  onEdit?: (id: string) => void;
  onDelete?: (claim: PageRevisionClaim) => void;
  onRestore?: (claim: PageRevisionClaim) => void;
  onPermanentDelete?: (claim: PageRevisionClaim) => void;
}

export function getPageColumns(
  opts: PageColumnOptions,
): ColumnDef<Page, unknown>[] {
  const publicPath = (page: Page) =>
    opts.contentType === "article" ? `/blog/${page.slug}` : `/${page.slug}`;
  return [
    createSelectColumn<Page>({ getLabel: (r) => (r as Page).title }),
    {
      accessorKey: "title",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Title" />
      ),
      cell: ({ row }) => (
        <div className="min-w-0 py-0.5">
          {opts.canEdit && !opts.showTrashed ? (
            opts.contentType === "article" ? (
              <Link
                to="/admin/articles/$articleId/edit"
                params={{ articleId: row.original.id }}
                className="block truncate font-medium text-foreground hover:underline"
              >
                {row.original.title}
              </Link>
            ) : (
              <Link
                to="/admin/pages/$pageId/edit"
                params={{ pageId: row.original.id }}
                className="block truncate font-medium text-foreground hover:underline"
              >
                {row.original.title}
              </Link>
            )
          ) : (
            <span className="block truncate font-medium">
              {row.original.title}
            </span>
          )}
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{publicPath(row.original)}</span>
            {!opts.showTrashed && isPageLive(row.original) ? (
              <a
                href={opts.getStorefrontPath(publicPath(row.original))}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`View live page ${row.original.title}`}
                className="shrink-0 transition-colors hover:text-foreground"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
          </div>
        </div>
      ),
      size: 360,
    },
    {
      accessorKey: "isPublished",
      header: "Status",
      cell: ({ row }) => (
        <div>
          <PagePublicationBadge page={row.original} />
          {getPagePublicationMode(row.original) === "scheduled" &&
          row.original.publishedAt ? (
            <div
              className="mt-1 text-xs text-muted-foreground"
              suppressHydrationWarning
            >
              {formatDate(row.original.publishedAt)}
            </div>
          ) : null}
        </div>
      ),
      enableSorting: false,
      size: 170,
    },
    createDateColumn<Page>("updatedAt", "Last Updated"),
    createActionsColumn<Page>({
      showTrashed: opts.showTrashed,
      onView: !opts.showTrashed
        ? (p) => window.open(opts.getStorefrontPath(publicPath(p)), "_blank")
        : undefined,
      canView: isPageLive,
      onEdit: opts.onEdit ? (p) => opts.onEdit!(p.id) : undefined,
      onDelete: opts.onDelete
        ? (p) => opts.onDelete!({ id: p.id, expectedRevision: p.revision })
        : undefined,
      onRestore: opts.onRestore
        ? (p) => opts.onRestore!({ id: p.id, expectedRevision: p.revision })
        : undefined,
      onPermanentDelete: opts.onPermanentDelete
        ? (p) =>
            opts.onPermanentDelete!({ id: p.id, expectedRevision: p.revision })
        : undefined,
    }),
  ];
}
