import { createFileRoute, Link } from "@tanstack/react-router";
import { CollectionsList } from "~/components/admin/collections-list";
import { Button } from "~/components/ui/button";
import { Layers } from "lucide-react";

export const Route = createFileRoute("/admin/collections/trash")({
  head: () => ({ meta: [{ title: "Collections Trash | Scalius Admin" }] }),
  component: CollectionsTrashPage,
});

function CollectionsTrashPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Collections Trash</h1>
          <p className="text-muted-foreground">
            View, restore, or permanently delete trashed collections.
          </p>
        </div>
        <Link to="/admin/collections">
          <Button variant="outline" size="sm">
            <Layers className="mr-2 h-4 w-4" />
            View Active
          </Button>
        </Link>
      </div>
      <CollectionsList showTrashed={true} />
    </div>
  );
}
