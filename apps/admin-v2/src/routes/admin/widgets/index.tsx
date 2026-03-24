import { useMemo, useCallback } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { LayoutDashboard, PlusCircle, Trash2 } from "lucide-react";
import { toast } from "sonner";
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

const searchSchema = z.object({
  page: z.number().default(1).catch(1),
  limit: z.number().default(20).catch(20),
  search: z.string().default("").catch(""),
});

export const Route = createFileRoute("/admin/widgets/")({
  validateSearch: searchSchema,
  staleTime: 0,
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(widgetsQueryOptions({ showTrashed: false }));
  },
  head: () => ({ meta: [{ title: "Widgets | Scalius Admin" }] }),
  component: WidgetsPage,
});

function WidgetsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();

  // Mutations
  const deleteMutation = useDeleteWidget();
  const permanentDeleteMutation = usePermanentDeleteWidget();
  const restoreMutation = useRestoreWidget();
  const bulkDeleteMutation = useBulkDeleteWidgets();

  // Collections come from the widgets response, memoize separately
  const collectionsRef = useMemo(() => ({ current: [] as Array<{ id: string; name: string }> }), []);

  // Column definitions
  const columns = useMemo(
    () =>
      getWidgetColumns({
        showTrashed: false,
        collections: collectionsRef.current,
        onEdit: (id) =>
          void navigate({ to: `/admin/widgets/${id}` as string }),
        onDelete: (id) => deleteMutation.mutate(id),
        onRestore: (id) => restoreMutation.mutate(id),
        onPermanentDelete: (id) => permanentDeleteMutation.mutate(id),
        onCopyShortcode: (id) => {
          navigator.clipboard
            .writeText(`[widget id="${id}"]`)
            .then(() => toast.success("Shortcode copied to clipboard!"))
            .catch(() => toast.error("Failed to copy shortcode."));
        },
      }),
    [navigate, deleteMutation, permanentDeleteMutation, restoreMutation, collectionsRef],
  );

  // Data selector — widgets are NOT server-paginated, so we slice client-side
  const dataSelector = useCallback(
    (raw: unknown) => {
      const r = raw as WidgetListResponse;
      const allWidgets = (r.widgets ?? []) as Widget[];
      // Store collections for column use
      collectionsRef.current = r.availableCollections ?? [];

      // Client-side search filtering
      const filtered = search.search
        ? allWidgets.filter((w) =>
            w.name.toLowerCase().includes(search.search.toLowerCase()),
          )
        : allWidgets;

      // Client-side pagination
      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / search.limit));
      const safePage = Math.min(search.page, totalPages);
      const sliced = filtered.slice(
        (safePage - 1) * search.limit,
        safePage * search.limit,
      );

      return {
        data: sliced,
        pagination: {
          total,
          page: safePage,
          limit: search.limit,
          totalPages,
        },
      };
    },
    [search.search, search.page, search.limit, collectionsRef],
  );

  const { table, isFetching, isLoading, selectedIds, clearSelection } =
    useServerTable({
      columns,
      queryOptions: widgetsQueryOptions({
        search: search.search || undefined,
        showTrashed: false,
      }) as never,
      dataSelector,
      currentPage: search.page,
      currentLimit: search.limit,
      onPaginationChange: (page, limit) =>
        void navigate({
          search: ((prev: Record<string, unknown>) => ({ ...prev, page, limit })) as never,
        }),
      onSortingChange: () => {
        // Widgets have no server-side sorting
      },
    });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Widgets</h1>
          <p className="text-muted-foreground">
            Create and manage dynamic content widgets for your store.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/admin/widgets/trash">
            <Button variant="outline" size="sm">
              <Trash2 className="mr-2 h-4 w-4" />
              View Trash
            </Button>
          </Link>
          <Link to="/admin/widgets/$widgetId" params={{ widgetId: "create" }}>
            <Button>
              <PlusCircle className="mr-2 h-4 w-4" />
              New Widget
            </Button>
          </Link>
        </div>
      </div>

      <DataTable
        table={table}
        isFetching={isFetching}
        isLoading={isLoading}
        itemLabel="widgets"
        emptyState={{
          icon: LayoutDashboard,
          title: "No widgets found",
          description: "Create your first widget to get started.",
        }}
        toolbar={
          <DataTableToolbar
            searchValue={search.search}
            onSearchChange={(value) =>
              void navigate({
                search: ((prev: Record<string, unknown>) => ({ ...prev, search: value, page: 1 })) as never,
              })
            }
            searchPlaceholder="Search widgets..."
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
                      permanent: false,
                    },
                    { onSuccess: clearSelection },
                  );
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Trash ({selectedIds.length})
              </Button>
            }
          />
        }
      />
    </div>
  );
}
