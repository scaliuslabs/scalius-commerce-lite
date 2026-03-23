import { createFileRoute, Link } from "@tanstack/react-router";
import { CollectionsList } from "~/components/admin/collections-list";
import { Button } from "~/components/ui/button";
import { PlusCircle, Trash2 } from "lucide-react";

export const Route = createFileRoute("/admin/collections/")({
  head: () => ({ meta: [{ title: "Collections | Scalius Admin" }] }),
  component: CollectionsPage,
});

function CollectionsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Collections</h1>
          <p className="text-muted-foreground">
            Organize your products into curated collections
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/admin/collections/trash">
            <Button variant="outline" size="sm">
              <Trash2 className="mr-2 h-4 w-4" />
              View Trash
            </Button>
          </Link>
          <Link to="/admin/collections/new">
            <Button>
              <PlusCircle className="mr-2 h-4 w-4" />
              New Collection
            </Button>
          </Link>
        </div>
      </div>
      <CollectionsList showTrashed={false} />
    </div>
  );
}
