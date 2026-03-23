import { createFileRoute, Link } from "@tanstack/react-router";
import { PagesList } from "~/components/admin/pages-list";
import { Button } from "~/components/ui/button";
import { Trash2, Plus } from "lucide-react";

export const Route = createFileRoute("/admin/pages/")({
  head: () => ({ meta: [{ title: "Pages | Scalius Admin" }] }),
  component: PagesPage,
});

function PagesPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Pages</h1>
          <p className="text-muted-foreground">
            Manage your website pages and content.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/admin/pages/trash">
            <Button variant="outline" size="sm">
              <Trash2 className="mr-2 h-4 w-4" />
              View Trash
            </Button>
          </Link>
          <Link to="/admin/pages/new">
            <Button size="sm">
              <Plus className="mr-2 h-4 w-4" />
              New Page
            </Button>
          </Link>
        </div>
      </div>
      <PagesList showTrashed={false} />
    </div>
  );
}
