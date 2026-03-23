import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { WidgetsList } from "~/components/admin/widget-list";
import { Button } from "~/components/ui/button";
import { LayoutDashboard } from "lucide-react";
import { getWidgets } from "~/lib/api.functions";

const searchSchema = z.object({
  search: z.string().default("").catch(""),
});

export const Route = createFileRoute("/admin/widgets/trash")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const result = await getWidgets({ data: { search: deps.search || undefined, showTrashed: true } });
    const r = result as any;
    return {
      widgets: r.widgets || [],
      collections: r.availableCollections || [],
      stats: { total: 0, active: 0, inactive: 0 },
    };
  },
  head: () => ({ meta: [{ title: "Widget Trash | Scalius Admin" }] }),
  component: WidgetsTrashPage,
});

function WidgetsTrashPage() {
  const { widgets, collections, stats } = Route.useLoaderData();
  const { search } = Route.useSearch();

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
        initialWidgets={widgets}
        initialCollections={collections}
        initialStats={stats}
        initialSearch={search}
      />
    </div>
  );
}
