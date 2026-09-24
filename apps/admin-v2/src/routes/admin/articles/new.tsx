import { createFileRoute } from "@tanstack/react-router";
import { PageForm } from "~/components/admin/PageForm";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/articles/new")({
  head: () => pageHead("addBlogPost"),
  component: NewArticlePage,
});

function NewArticlePage() {
  return (
    <div className="container max-w-7xl py-4 pb-8">
      <PageForm contentType="article" />
    </div>
  );
}
