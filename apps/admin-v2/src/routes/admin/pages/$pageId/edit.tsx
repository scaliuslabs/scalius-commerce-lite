import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { PageForm } from "~/components/admin/PageForm";
import { pageQueryOptions } from "~/lib/api-query-options/pages";
import { RouteErrorComponent } from "~/lib/route-error";
import { nullForAdminApiNotFound } from "~/lib/admin-api-error";
import { toPageFormValues } from "~/lib/page-form-values";

export const Route = createFileRoute("/admin/pages/$pageId/edit")({
  loader: async ({ context: { queryClient }, params }) => {
    const data = await queryClient
      .ensureQueryData({
        ...pageQueryOptions(params.pageId),
        staleTime: Infinity,
      })
      .catch(nullForAdminApiNotFound);
    if (!data || data.contentType !== "page")
      throw redirect({ to: "/admin/pages" });
  },
  head: () => ({
    meta: [{ title: "Edit Page | Scalius Admin" }],
  }),
  errorComponent: RouteErrorComponent,
  component: EditPagePage,
});

function EditPagePage() {
  const { pageId } = Route.useParams();
  const { data } = useSuspenseQuery(pageQueryOptions(pageId));
  const page = toPageFormValues(data);

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <PageForm defaultValues={page} isEdit={true} />
    </div>
  );
}
