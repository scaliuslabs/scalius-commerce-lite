import { createFileRoute, redirect } from "@tanstack/react-router";
import { CategoryForm } from "~/components/admin/CategoryForm";
import { getCategory } from "~/lib/api.functions";

export const Route = createFileRoute("/admin/categories/$categoryId/edit")({
  loader: async ({ params }) => {
    const category = await getCategory({ data: { id: params.categoryId } }).catch(() => null);
    if (!category) throw redirect({ to: "/admin/categories" });
    const c = category as any;
    return {
      category: {
        ...c,
        slugEdited: true,
        image: c.imageUrl
          ? { id: `temp_${c.id}`, url: c.imageUrl, filename: c.imageUrl.split("/").pop() || "", size: 0, createdAt: new Date() }
          : null,
      },
    };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `Edit ${loaderData?.category?.name || "Category"} | Scalius Admin` }],
  }),
  component: EditCategoryPage,
});

function EditCategoryPage() {
  const { category } = Route.useLoaderData();

  if (!category) {
    return <div>Category not found</div>;
  }

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <CategoryForm defaultValues={category} isEdit={true} />
    </div>
  );
}
