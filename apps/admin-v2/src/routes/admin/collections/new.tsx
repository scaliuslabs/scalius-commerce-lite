import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CollectionForm } from "~/components/admin/collection-form";
import { collectionCategoryOptionsQueryOptions } from "~/lib/api.queries";
import type { Category } from "~/components/admin/collection-form/types";
import { RouteErrorComponent } from "~/lib/list-helpers";

export const Route = createFileRoute("/admin/collections/new")({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(collectionCategoryOptionsQueryOptions());
  },
  head: () => ({ meta: [{ title: "New Collection | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: NewCollectionPage,
});

function NewCollectionPage() {
  const { data: formOptions } = useSuspenseQuery(collectionCategoryOptionsQueryOptions());
  const fo = formOptions as { categories?: Category[] };

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <CollectionForm
        categories={fo.categories || []}
      />
    </div>
  );
}
