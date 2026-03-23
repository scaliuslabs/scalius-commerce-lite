import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { WidgetsList } from "~/components/admin/widget-list";
import { Button } from "~/components/ui/button";
import { PlusCircle, Trash2 } from "lucide-react";
import { getWidgets } from "~/lib/api.functions";

const searchSchema = z.object({
  search: z.string().default("").catch(""),
});

export const Route = createFileRoute("/admin/widgets/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const result = await getWidgets({ data: { search: deps.search || undefined, showTrashed: false } });
    const r = result as any;
    const widgets = r.widgets || [];
    return {
      widgets,
      collections: r.availableCollections || [],
      stats: {
        total: widgets.length,
        active: widgets.filter((w: any) => w.isActive).length,
        inactive: widgets.filter((w: any) => !w.isActive).length,
      },
    };
  },
  head: () => ({ meta: [{ title: "Widgets | Scalius Admin" }] }),
  component: WidgetsPage,
});

function WidgetsPage() {
  const { widgets, collections, stats } = Route.useLoaderData();
  const { search } = Route.useSearch();

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
        initialCollections={collections}
        initialStats={stats}
        initialSearch={search}
      />
    </div>
  );
}
