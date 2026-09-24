import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CollectionForm } from "~/components/admin/collection-form";
import { collectionCategoryOptionsQueryOptions } from "~/lib/api-query-options/collections";
import type { Category } from "~/components/admin/collection-form/types";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/collections/new")({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(collectionCategoryOptionsQueryOptions());
  },
  head: () => pageHead("addCollection"),
  errorComponent: RouteErrorComponent,
  component: NewCollectionPage,
});

function NewCollectionPage() {
  const { data } = useSuspenseQuery(collectionCategoryOptionsQueryOptions());
  const { categories = [] }: { categories?: Category[] } = data;
  return <CollectionForm categories={categories} />;
}
