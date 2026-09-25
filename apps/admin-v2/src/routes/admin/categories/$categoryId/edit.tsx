import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CategoryForm } from "~/components/admin/CategoryForm";
import { categoryFormOptionsQueryOptions, categoryQueryOptions } from "~/lib/api-query-options/categories";
import { RouteErrorComponent } from "~/lib/route-error";
import { nullForAdminApiNotFound } from "~/lib/admin-api-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/categories/$categoryId/edit")({
  loader: async ({ params, context: { queryClient } }) => {
    // The parent picker names categories by their path.
    void queryClient.prefetchQuery(categoryFormOptionsQueryOptions());
    const category = await queryClient
      .ensureQueryData({
        ...categoryQueryOptions(params.categoryId),
        staleTime: Infinity,
      })
      .catch(nullForAdminApiNotFound);
    if (!category) throw redirect({ to: "/admin/categories" });
    if (category.deletedAt != null) {
      throw redirect({
        to: "/admin/categories",
        search: { trashed: true } as never,
      });
    }
  },
  head: () => pageHead("category"),
  errorComponent: RouteErrorComponent,
  component: EditCategoryPage,
});

function EditCategoryPage() {
  const { categoryId } = Route.useParams();
  const { data: categoryData } = useSuspenseQuery(categoryQueryOptions(categoryId));

  const c = categoryData;
  const defaultValues = {
    ...c,
    image: c.imageUrl
      ? { id: `temp_${c.id}`, url: c.imageUrl, filename: c.imageUrl.split("/").pop() || "", size: 0, createdAt: new Date() }
      : null,
  };

  return <CategoryForm defaultValues={defaultValues} isEdit publishReadiness={c.publishReadiness} />;
}
