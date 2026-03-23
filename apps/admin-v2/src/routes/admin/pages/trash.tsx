import { createFileRoute, Link } from "@tanstack/react-router";
import { PagesList } from "~/components/admin/pages-list";
import { Button } from "~/components/ui/button";
import { FileText } from "lucide-react";

export const Route = createFileRoute("/admin/pages/trash")({
  head: () => ({ meta: [{ title: "Page Trash | Scalius Admin" }] }),
  component: PagesTrashPage,
});

function PagesTrashPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Page Trash</h1>
          <p className="text-muted-foreground">
            View, restore, or permanently delete trashed pages.
          </p>
        </div>
        <Link to="/admin/pages">
          <Button variant="outline" size="sm">
            <FileText className="mr-2 h-4 w-4" />
            View Active
          </Button>
        </Link>
      </div>
      <PagesList showTrashed={true} />
    </div>
  );
}
