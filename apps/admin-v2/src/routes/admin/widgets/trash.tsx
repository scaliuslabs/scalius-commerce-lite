import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { z } from "zod";
import { WidgetsList } from "~/components/admin/widget-list";
import { Button } from "~/components/ui/button";
import { LayoutDashboard } from "lucide-react";
import { widgetsQueryOptions } from "~/lib/api.queries";
import type { WidgetListResponse } from "~/types/api-responses";
import type { WidgetItem } from "~/components/admin/widget-list/types";

const searchSchema = z.object({
  search: z.string().default("").catch(""),
});

export const Route = createFileRoute("/admin/widgets/trash")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps }) => {
    await queryClient.ensureQueryData(widgetsQueryOptions({
      search: deps.search || undefined,
      showTrashed: true,
    }));
  },
  head: () => ({ meta: [{ title: "Widget Trash | Scalius Admin" }] }),
  component: WidgetsTrashPage,
});

function WidgetsTrashPage() {
  const { search } = Route.useSearch();
  const { data } = useSuspenseQuery(widgetsQueryOptions({
    search: search || undefined,
    showTrashed: true,
  }));
  const r = data as WidgetListResponse;

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
      <WidgetsList
        showTrashed={true}
        initialWidgets={(r.widgets || []) as unknown as WidgetItem[]}
        initialCollections={r.availableCollections || []}
        initialStats={{ total: 0, active: 0, inactive: 0 }}
        initialSearch={search}
      />
    </div>
  );
}
