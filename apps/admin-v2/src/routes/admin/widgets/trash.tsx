import { useMemo, useCallback } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { LayoutDashboard, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { widgetsQueryOptions } from "~/lib/api.queries";
import {
  useDeleteWidget,
  usePermanentDeleteWidget,
  useRestoreWidget,
  useBulkDeleteWidgets,
} from "~/lib/api.mutations";
import {
  DataTable,
  DataTableToolbar,
  useServerTable,
} from "~/components/admin/data-table";
import { getWidgetColumns } from "~/components/admin/data-table/columns/widget-columns";
import type { Widget, WidgetListResponse } from "~/types/api-responses";
import { RouteErrorComponent } from "~/lib/list-helpers";

const searchSchema = z.object({
  page: z.number().default(1).catch(1),
  limit: z.number().default(10).catch(10),
  search: z.string().default("").catch(""),
});

export const Route = createFileRoute("/admin/widgets/trash")({
  validateSearch: searchSchema,
  staleTime: 0,
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(widgetsQueryOptions({ showTrashed: true }));
  },
  head: () => ({ meta: [{ title: "Widget Trash | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: WidgetsTrashPage,
});

function WidgetsTrashPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();

  // Mutations
  const deleteMutation = useDeleteWidget();
  const permanentDeleteMutation = usePermanentDeleteWidget();
  const restoreMutation = useRestoreWidget();
  const bulkDeleteMutation = useBulkDeleteWidgets();

  // Collections come from the widgets response
  const collectionsRef = useMemo(() => ({ current: [] as Array<{ id: string; name: string }> }), []);

  // Column definitions
  const columns = useMemo(
    () =>
      getWidgetColumns({
        showTrashed: true,
        collections: collectionsRef.current,
        onEdit: (id) =>
          void navigate({ to: `/admin/widgets/${id}` as string }),
        onDelete: (id) => deleteMutation.mutate(id),
        onRestore: (id) => restoreMutation.mutate(id),
        onPermanentDelete: (id) => permanentDeleteMutation.mutate(id),
        onCopyShortcode: () => {},
      }),
    [navigate, deleteMutation, permanentDeleteMutation, restoreMutation, collectionsRef],
  );

  // Data selector — client-side pagination for widgets
  const dataSelector = useCallback(
    (raw: unknown) => {
      const r = raw as WidgetListResponse;
      const allWidgets = (r.widgets ?? []) as Widget[];
      collectionsRef.current = r.availableCollections ?? [];

      const filtered = search.search
        ? allWidgets.filter((w) =>
            w.name.toLowerCase().includes(search.search.toLowerCase()),
          )
        : allWidgets;

      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / search.limit));
      const safePage = Math.min(search.page, totalPages);
      const sliced = filtered.slice(
        (safePage - 1) * search.limit,
        safePage * search.limit,
      );

      return {
        data: sliced,
        pagination: { total, page: safePage, limit: search.limit, totalPages },
      };
    },
    [search.search, search.page, search.limit, collectionsRef],
  );

  const { table, isFetching, isLoading, selectedIds, clearSelection } =
    useServerTable({
      columns,
      queryOptions: widgetsQueryOptions({
        search: search.search || undefined,
        showTrashed: true,
      }) as never,
      dataSelector,
      currentPage: search.page,
      currentLimit: search.limit,
      onPaginationChange: (page, limit) =>
        void navigate({
          search: ((prev: Record<string, unknown>) => ({ ...prev, page, limit })) as never,
        }),
      onSortingChange: () => {},
    });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Widget Trash</h1>
          <p className="text-muted-foreground">
            View, restore, or permanently delete trashed widgets.
          </p>
        </div>
        <Link to="/admin/widgets">
          <Button variant="outline" size="sm">
            <LayoutDashboard className="mr-2 h-4 w-4" />
            View Active
          </Button>
        </Link>
      </div>

      <DataTable
        table={table}
        isFetching={isFetching}
        isLoading={isLoading}
        itemLabel="widgets"
        emptyState={{
          icon: LayoutDashboard,
          title: "Trash is empty",
          description: "Deleted widgets will appear here.",
        }}
        toolbar={
          <DataTableToolbar
            searchValue={search.search}
            onSearchChange={(value) =>
              void navigate({
                search: ((prev: Record<string, unknown>) => ({ ...prev, search: value, page: 1 })) as never,
              })
            }
            searchPlaceholder="Search trashed widgets..."
            selectedCount={selectedIds.length}
            bulkActions={
              <Button
                variant="outline"
                size="sm"
                className="text-destructive border-destructive hover:bg-destructive/10"
                onClick={() => {
                  bulkDeleteMutation.mutate(
                    {
                      ids: selectedIds,
                      permanent: true,
                    },
                    { onSuccess: clearSelection },
                  );
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete ({selectedIds.length})
              </Button>
            }
          />
        }
      />
    </div>
  );
}
