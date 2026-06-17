import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { PageForm } from "~/components/admin/PageForm";
import { pageQueryOptions } from "~/lib/api-query-options/pages";
import type { PageDto } from "~/lib/api-functions/pages";
import type { PageFormValues } from "~/lib/form-schemas";
import { RouteErrorComponent } from "~/lib/route-error";
import { unixToDate } from "@scalius/shared/timestamps";

export const Route = createFileRoute("/admin/pages/$pageId/edit")({
  loader: async ({ context: { queryClient }, params }) => {
    const data = await queryClient.ensureQueryData({ ...pageQueryOptions(params.pageId), staleTime: Infinity }).catch(() => null);
    if (!data) throw redirect({ to: "/admin/pages" });
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

function toPageFormValues(page: PageDto): PageFormValues {
  return {
    id: page.id,
    title: page.title,
    slug: page.slug,
    content: page.content,
    metaTitle: page.metaTitle,
    metaDescription: page.metaDescription,
    isPublished: page.isPublished,
    publishedAt: unixToDate(page.publishedAt) ?? null,
    sortOrder: page.sortOrder,
    hideHeader: page.hideHeader,
    hideFooter: page.hideFooter,
    hideTitle: page.hideTitle,
    featuredImage: page.featuredImage
      ? {
          ...page.featuredImage,
          createdAt: unixToDate(page.featuredImage.createdAt) ?? new Date(0),
          updatedAt: unixToDate(page.featuredImage.updatedAt) ?? undefined,
        }
      : null,
  };
}
