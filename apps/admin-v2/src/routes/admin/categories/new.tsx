import { createFileRoute } from "@tanstack/react-router";
import { CategoryForm } from "~/components/admin/CategoryForm";

const defaultValues = {
  status: "draft" as const,
  name: "",
  description: null,
  slug: "",
  metaTitle: null,
  metaDescription: null,
  canonicalPath: null,
  noIndex: false,
  excludeFromSitemap: false,
  image: null,
};

export const Route = createFileRoute("/admin/categories/new")({
  head: () => ({ meta: [{ title: "New Category | Scalius Admin" }] }),
  component: NewCategoryPage,
});

function NewCategoryPage() {
  return (
    <div className="container max-w-7xl py-4 pb-8">
      <CategoryForm defaultValues={defaultValues} isEdit={false} />
    </div>
  );
}
