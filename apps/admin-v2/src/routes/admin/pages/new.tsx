import { createFileRoute } from "@tanstack/react-router";
import { PageForm } from "~/components/admin/PageForm";

export const Route = createFileRoute("/admin/pages/new")({
  head: () => ({ meta: [{ title: "New Page | Scalius Admin" }] }),
  component: NewPagePage,
});

function NewPagePage() {
  return (
    <div className="container max-w-7xl py-4 pb-8">
      <PageForm />
    </div>
  );
}
