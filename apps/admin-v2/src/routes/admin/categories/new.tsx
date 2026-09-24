import { createFileRoute } from "@tanstack/react-router";
import { CategoryForm } from "~/components/admin/CategoryForm";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/categories/new")({
  head: () => pageHead("addCategory"),
  component: NewCategoryPage,
});

function NewCategoryPage() {
  return <CategoryForm />;
}
