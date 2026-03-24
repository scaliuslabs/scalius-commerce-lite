import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { PageForm } from "~/components/admin/PageForm";
import { pageQueryOptions } from "~/lib/api.queries";
import type { Page } from "~/types/api-responses";

export const Route = createFileRoute("/admin/pages/$pageId/edit")({
  loader: async ({ context: { queryClient }, params }) => {
    const data = await queryClient.ensureQueryData({ ...pageQueryOptions(params.pageId), staleTime: Infinity }).catch(() => null);
    if (!data) throw redirect({ to: "/admin/pages" });
  },
  head: () => ({
    meta: [{ title: "Edit Page | Scalius Admin" }],
  }),
  component: EditPagePage,
});

function EditPagePage() {
  const { pageId } = Route.useParams();
  const { data } = useSuspenseQuery(pageQueryOptions(pageId));
  const page = data as Page;

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <PageForm defaultValues={page} isEdit={true} />
    </div>
  );
}
