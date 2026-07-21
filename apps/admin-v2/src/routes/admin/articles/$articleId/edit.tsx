import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { PageForm } from "~/components/admin/PageForm";
import { pageQueryOptions } from "~/lib/api-query-options/pages";
import { RouteErrorComponent } from "~/lib/route-error";
import { nullForAdminApiNotFound } from "~/lib/admin-api-error";
import { toPageFormValues } from "~/lib/page-form-values";

export const Route = createFileRoute("/admin/articles/$articleId/edit")({
  loader: async ({ context: { queryClient }, params }) => {
    const data = await queryClient
      .ensureQueryData({
        ...pageQueryOptions(params.articleId),
        staleTime: Infinity,
      })
      .catch(nullForAdminApiNotFound);
    if (!data || data.contentType !== "article") {
      throw redirect({ to: "/admin/articles" });
    }
  },
  head: () => ({ meta: [{ title: "Edit Article | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: EditArticlePage,
});

function EditArticlePage() {
  const { articleId } = Route.useParams();
  const { data } = useSuspenseQuery(pageQueryOptions(articleId));

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <PageForm
        contentType="article"
        defaultValues={toPageFormValues(data)}
        isEdit={true}
      />
    </div>
  );
}
