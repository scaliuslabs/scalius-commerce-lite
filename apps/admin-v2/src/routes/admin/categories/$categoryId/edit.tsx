import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CategoryForm } from "~/components/admin/CategoryForm";
import { categoryQueryOptions } from "~/lib/api-query-options/categories";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/categories/$categoryId/edit")({
  loader: async ({ params, context: { queryClient } }) => {
    const category = await queryClient.ensureQueryData({ ...categoryQueryOptions(params.categoryId), staleTime: Infinity }).catch(() => null);
    if (!category) throw redirect({ to: "/admin/categories" });
  },
  head: () => ({
    meta: [{ title: "Edit Category | Scalius Admin" }],
  }),
  errorComponent: RouteErrorComponent,
  component: EditCategoryPage,
});

function EditCategoryPage() {
  const { categoryId } = Route.useParams();
  const { data: categoryData } = useSuspenseQuery(categoryQueryOptions(categoryId));

  const c = categoryData;
  const defaultValues = {
    ...c,
    slugEdited: true,
    image: c.imageUrl
      ? { id: `temp_${c.id}`, url: c.imageUrl, filename: c.imageUrl.split("/").pop() || "", size: 0, createdAt: new Date() }
      : null,
  };

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <CategoryForm defaultValues={defaultValues} isEdit={true} />
    </div>
  );
}
