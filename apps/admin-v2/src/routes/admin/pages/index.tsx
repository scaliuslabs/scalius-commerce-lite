import { useMemo, useCallback } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { FileText, Plus, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import { pagesQueryOptions } from "~/lib/api.queries";
import {
  useDeletePage,
  usePermanentDeletePage,
  useRestorePage,
  useBulkDeletePages,
} from "~/lib/api.mutations";
import {
  DataTable,
  DataTableToolbar,
  useServerTable,
} from "~/components/admin/data-table";
import { getPageColumns } from "~/components/admin/data-table/columns/page-columns";
import type { Page } from "~/types/api-responses";

const searchSchema = z.object({
  page: z.number().default(1).catch(1),
  limit: z.number().default(20).catch(20),
  search: z.string().default("").catch(""),
  sort: z
    .enum(["title", "sortOrder", "createdAt", "updatedAt"])
    .default("updatedAt")
    .catch("updatedAt"),
  order: z.enum(["asc", "desc"]).default("desc").catch("desc"),
  trashed: z.boolean().default(false).catch(false),
});

function mapParams(deps: z.infer<typeof searchSchema>) {
  return {
    page: deps.page,
    limit: deps.limit,
    search: deps.search || undefined,
    sort: deps.sort,
    order: deps.order,
    showTrashed: deps.trashed,
  };
}

export const Route = createFileRoute("/admin/pages/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps }) => {
    await queryClient.ensureQueryData(pagesQueryOptions(mapParams(deps)));
  },
  head: ({ match }) => ({
    meta: [
      {
        title: `${match.search.trashed ? "Page Trash" : "Pages"} | Scalius Admin`,
      },
    ],
  }),
  component: PagesPage,
});

function PagesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { getStorefrontPath } = useStorefrontUrl();
  const showTrashed = search.trashed;

  // Mutations
  const deleteMutation = useDeletePage();
  const permanentDeleteMutation = usePermanentDeletePage();
  const restoreMutation = useRestorePage();
  const bulkDeleteMutation = useBulkDeletePages();

  // Column definitions
  const columns = useMemo(
    () =>
      getPageColumns({
        showTrashed,
        getStorefrontPath,
        onEdit: (id) =>
          void navigate({ to: `/admin/pages/${id}/edit` as string }),
        onDelete: (id) => deleteMutation.mutate(id),
        onRestore: (id) => restoreMutation.mutate(id),
        onPermanentDelete: (id) => permanentDeleteMutation.mutate(id),
      }),
    [showTrashed, getStorefrontPath, navigate, deleteMutation, restoreMutation, permanentDeleteMutation],
  );

  // Data selector
  const dataSelector = useCallback(
    (raw: unknown) => {
      const r = raw as Record<string, unknown>;
      return {
        data: (r.pages ?? []) as Page[],
        pagination: (r.pagination ?? {
          total: 0,
          page: search.page,
          limit: search.limit,
          totalPages: 0,
        }) as {
          total: number;
          page: number;
          limit: number;
          totalPages: number;
        },
      };
    },
    [search.page, search.limit],
  );

  const { table, isFetching, isLoading, selectedIds, clearSelection } =
    useServerTable({
      columns,
      queryOptions: pagesQueryOptions(mapParams(search)) as never,
      dataSelector,
      currentPage: search.page,
      currentLimit: search.limit,
      currentSort: search.sort,
      currentOrder: search.order,
      onPaginationChange: (page, limit) =>
        void navigate({
          search: ((prev: Record<string, unknown>) => ({ ...prev, page, limit })) as never,
        }),
      onSortingChange: (sort, order) =>
        void navigate({
          search: ((prev: Record<string, unknown>) => ({ ...prev, sort, order, page: 1 })) as never,
        }),
    });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {showTrashed ? "Page Trash" : "Pages"}
          </h1>
          <p className="text-muted-foreground">
            {showTrashed
              ? "View, restore, or permanently delete trashed pages."
              : "Manage your website pages and content."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/admin/pages"
            search={((prev: Record<string, unknown>) => ({ ...prev, trashed: !showTrashed })) as never}
          >
            <Button variant="outline" size="sm">
              {showTrashed ? (
                <FileText className="mr-2 h-4 w-4" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {showTrashed ? "View Active" : "View Trash"}
            </Button>
          </Link>
          {!showTrashed && (
            <Link to="/admin/pages/new">
              <Button size="sm">
                <Plus className="mr-2 h-4 w-4" />
                New Page
              </Button>
            </Link>
          )}
        </div>
      </div>

      <DataTable
        table={table}
        isFetching={isFetching}
        isLoading={isLoading}
        itemLabel="pages"
        emptyState={{
          icon: FileText,
          title: showTrashed ? "Trash is empty" : "No pages found",
          description: showTrashed
            ? "Deleted pages will appear here."
            : "Create your first page to get started.",
        }}
        toolbar={
          <DataTableToolbar
            searchValue={search.search}
            onSearchChange={(value) =>
              void navigate({
                search: ((prev: Record<string, unknown>) => ({ ...prev, search: value, page: 1 })) as never,
              })
            }
            searchPlaceholder="Search pages..."
            selectedCount={selectedIds.length}
            bulkActions={
              <Button
                variant="outline"
                size="sm"
                className="text-destructive border-destructive hover:bg-destructive/10"
                onClick={() => {
                  bulkDeleteMutation.mutate(
                    {
                      pageIds: selectedIds,
                      permanent: showTrashed,
                    },
                    { onSuccess: clearSelection },
                  );
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {showTrashed ? "Delete" : "Trash"} ({selectedIds.length})
              </Button>
            }
          />
        }
      />
    </div>
  );
}
