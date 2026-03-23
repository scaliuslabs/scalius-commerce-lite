import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { AttributesManager } from "~/components/admin/attributes-manager";
import { Button } from "~/components/ui/button";
import { Tags, Trash2 } from "lucide-react";

const searchSchema = z.object({
  trashed: z.boolean().default(false).catch(false),
});

export const Route = createFileRoute("/admin/attributes")({
  validateSearch: searchSchema,
  head: ({ match }) => ({
    meta: [{ title: `${match.search.trashed ? "Attribute Trash" : "Product Attributes"} | Scalius Admin` }],
  }),
  component: AttributesPage,
});

function AttributesPage() {
  const { trashed: showTrashed } = Route.useSearch();
  const pageTitle = showTrashed ? "Attribute Trash" : "Product Attributes";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{pageTitle}</h1>
          <p className="text-muted-foreground">
            {showTrashed
              ? "View, restore, or permanently delete trashed attributes."
              : "Manage attributes like brand, color, or warranty to organize and filter products."}
          </p>
        </div>
        <Link
          to="/admin/attributes"
          search={{ trashed: !showTrashed }}
        >
          <Button variant="outline" size="sm">
            {showTrashed ? (
              <>
                <Tags className="mr-2 h-4 w-4" />
                View Active
              </>
            ) : (
              <>
                <Trash2 className="mr-2 h-4 w-4" />
                View Trash
              </>
            )}
          </Button>
        </Link>
      </div>
      <AttributesManager showTrashed={showTrashed} />
    </div>
  );
}
