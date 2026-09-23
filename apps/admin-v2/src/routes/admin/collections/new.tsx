import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CollectionForm } from "~/components/admin/collection-form";
import { collectionCategoryOptionsQueryOptions } from "~/lib/api-query-options/collections";
import type { Category } from "~/components/admin/collection-form/types";
import { translate } from "~/i18n";
import { catalogMessages } from "~/i18n/catalog";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/collections/new")({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(collectionCategoryOptionsQueryOptions());
  },
  head: () => ({ meta: [{ title: translate(catalogMessages, "addCollection") }] }),
  errorComponent: RouteErrorComponent,
  component: NewCollectionPage,
});

function NewCollectionPage() {
  const { data } = useSuspenseQuery(collectionCategoryOptionsQueryOptions());
  const { categories = [] }: { categories?: Category[] } = data;
  return <CollectionForm categories={categories} />;
}
