import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CollectionForm } from "~/components/admin/collection-form";
import { collectionFormOptionsQueryOptions } from "~/lib/api.queries";
import type { Category, Product } from "~/components/admin/collection-form/types";

export const Route = createFileRoute("/admin/collections/new")({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(collectionFormOptionsQueryOptions());
  },
  head: () => ({ meta: [{ title: "New Collection | Scalius Admin" }] }),
  component: NewCollectionPage,
});

function NewCollectionPage() {
  const { data: formOptions } = useSuspenseQuery(collectionFormOptionsQueryOptions());
  const fo = formOptions as { categories?: Category[]; products?: Product[] };

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <CollectionForm
        categories={fo.categories || []}
        products={fo.products || []}
      />
    </div>
  );
}
