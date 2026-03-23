import { createFileRoute, redirect } from "@tanstack/react-router";
import { PageForm } from "~/components/admin/PageForm";
import { getPage } from "~/lib/api.functions";

export const Route = createFileRoute("/admin/pages/$pageId/edit")({
  loader: async ({ params }) => {
    const page = await getPage({ data: { id: params.pageId } }).catch(() => null) as any;
    if (!page) throw redirect({ to: "/admin/pages" });
    return { page: page as any };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `Edit ${loaderData?.page?.title || "Page"} | Scalius Admin` }],
  }),
  component: EditPagePage,
});

function EditPagePage() {
  const { page } = Route.useLoaderData();

  if (!page) {
    return <div>Page not found</div>;
  }

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <PageForm defaultValues={page} isEdit={true} />
    </div>
  );
}
