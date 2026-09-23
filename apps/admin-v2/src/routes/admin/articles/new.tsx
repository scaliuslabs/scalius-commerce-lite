import { createFileRoute } from "@tanstack/react-router";
import { PageForm } from "~/components/admin/PageForm";
import { translate } from "~/i18n";
import { pageFormMessages } from "~/i18n/page-form";

export const Route = createFileRoute("/admin/articles/new")({
  head: () => ({ meta: [{ title: translate(pageFormMessages, "addBlogPost") }] }),
  component: NewArticlePage,
});

function NewArticlePage() {
  return (
    <div className="container max-w-7xl py-4 pb-8">
      <PageForm contentType="article" />
    </div>
  );
}
