import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { z } from "zod";
import { WidgetsList } from "~/components/admin/widget-list";
import { Button } from "~/components/ui/button";
import { PlusCircle, Trash2 } from "lucide-react";
import { widgetsQueryOptions } from "~/lib/api.queries";
import type { WidgetListResponse } from "~/types/api-responses";
import type { WidgetItem } from "~/components/admin/widget-list/types";

const searchSchema = z.object({
  search: z.string().default("").catch(""),
});

export const Route = createFileRoute("/admin/widgets/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps }) => {
    await queryClient.ensureQueryData(widgetsQueryOptions({
      search: deps.search || undefined,
      showTrashed: false,
    }));
  },
  head: () => ({ meta: [{ title: "Widgets | Scalius Admin" }] }),
  component: WidgetsPage,
});

function WidgetsPage() {
  const { search } = Route.useSearch();
  const { data } = useSuspenseQuery(widgetsQueryOptions({
    search: search || undefined,
    showTrashed: false,
  }));
  const r = data as WidgetListResponse;
  const widgets = (r.widgets || []) as unknown as WidgetItem[];

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
      <WidgetsList
        showTrashed={false}
        initialWidgets={widgets}
        initialCollections={r.availableCollections || []}
        initialStats={{
          total: widgets.length,
          active: widgets.filter((w) => w.isActive).length,
          inactive: widgets.filter((w) => !w.isActive).length,
        }}
        initialSearch={search}
      />
    </div>
  );
}
