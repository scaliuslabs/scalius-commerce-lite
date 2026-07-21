import { createFileRoute } from "@tanstack/react-router";
import { PageForm } from "~/components/admin/PageForm";

export const Route = createFileRoute("/admin/articles/new")({
  head: () => ({ meta: [{ title: "New Article | Scalius Admin" }] }),
  component: NewArticlePage,
});

function NewArticlePage() {
  return (
    <div className="container max-w-7xl py-4 pb-8">
      <PageForm contentType="article" />
    </div>
  );
}
