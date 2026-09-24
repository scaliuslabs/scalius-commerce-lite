import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { PageForm } from "~/components/admin/PageForm";
import { pageQueryOptions } from "~/lib/api-query-options/pages";
import { RouteErrorComponent } from "~/lib/route-error";
import { nullForAdminApiNotFound } from "~/lib/admin-api-error";
import { toPageFormValues } from "~/lib/page-form-values";
import { translate } from "~/i18n";
import { pageFormMessages } from "~/i18n/page-form";

/** Pages opened from elsewhere return there: only these known places (no free-form URLs). */
const RETURN_TO = { policies: "/admin/settings/policies" } as const;

export const Route = createFileRoute("/admin/pages/$pageId/edit")({
  validateSearch: (search: Record<string, unknown>): { from?: keyof typeof RETURN_TO } =>
    typeof search.from === "string" && search.from in RETURN_TO ? { from: search.from as keyof typeof RETURN_TO } : {},
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
    meta: [{ title: translate(pageFormMessages, "page") }],
  }),
  errorComponent: RouteErrorComponent,
  component: EditPagePage,
});

function EditPagePage() {
  const { pageId } = Route.useParams();
  const { from } = Route.useSearch();
  const { data } = useSuspenseQuery(pageQueryOptions(pageId));
  const page = toPageFormValues(data);

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <PageForm defaultValues={page} isEdit={true} backUrl={from ? RETURN_TO[from] : undefined} />
    </div>
  );
}
