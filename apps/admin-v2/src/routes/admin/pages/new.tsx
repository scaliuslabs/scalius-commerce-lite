import { createFileRoute } from "@tanstack/react-router";
import { PageForm } from "~/components/admin/PageForm";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/pages/new")({
  head: () => pageHead("addPage"),
  component: NewPagePage,
});

function NewPagePage() {
  return (
    <div className="container max-w-7xl py-4 pb-8">
      <PageForm />
    </div>
  );
}
