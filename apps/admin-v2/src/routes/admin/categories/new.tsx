import { createFileRoute } from "@tanstack/react-router";
import { CategoryForm } from "~/components/admin/CategoryForm";
import { translate } from "~/i18n";
import { categoryFormMessages } from "~/i18n/category-form";

export const Route = createFileRoute("/admin/categories/new")({
  head: () => ({ meta: [{ title: translate(categoryFormMessages, "addCategory") }] }),
  component: NewCategoryPage,
});

function NewCategoryPage() {
  return (
    <div className="container max-w-7xl py-4 pb-8">
      <CategoryForm />
    </div>
  );
}
