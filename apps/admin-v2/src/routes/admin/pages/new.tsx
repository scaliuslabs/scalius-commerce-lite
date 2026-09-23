import { createFileRoute } from "@tanstack/react-router";
import { PageForm } from "~/components/admin/PageForm";
import { translate } from "~/i18n";
import { pageFormMessages } from "~/i18n/page-form";

export const Route = createFileRoute("/admin/pages/new")({
  head: () => ({ meta: [{ title: translate(pageFormMessages, "addPage") }] }),
  component: NewPagePage,
});

function NewPagePage() {
  return (
    <div className="container max-w-7xl py-4 pb-8">
      <PageForm />
    </div>
  );
}
