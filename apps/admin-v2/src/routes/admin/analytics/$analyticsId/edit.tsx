import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { AnalyticsForm } from "~/components/admin/AnalyticsForm";
import { analyticsScriptQueryOptions } from "~/lib/api-query-options/analytics";
import type { AnalyticsScript } from "~/types/api-responses";
import { RouteErrorComponent } from "~/lib/route-error";
import { analyticsScriptTypes, type AnalyticsScriptType } from "~/lib/form-schemas";

export const Route = createFileRoute("/admin/analytics/$analyticsId/edit")({
  loader: async ({ context: { queryClient }, params }) => {
    const data = await queryClient.ensureQueryData({ ...analyticsScriptQueryOptions(params.analyticsId), staleTime: Infinity }).catch(() => null);
    if (!data) throw redirect({ to: "/admin/analytics" });
  },
  head: () => ({ meta: [{ title: "Edit Analytics Script | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: EditAnalyticsPage,
});

function EditAnalyticsPage() {
  const { analyticsId } = Route.useParams();
  const { data } = useSuspenseQuery(analyticsScriptQueryOptions(analyticsId));
  const s = data as AnalyticsScript;

  const validType = (analyticsScriptTypes.includes(s.type as AnalyticsScriptType) ? s.type : "custom") as AnalyticsScriptType;
  const validLocation = (["head", "body_start", "body_end"].includes(s.location) ? s.location : "head") as "head" | "body_start" | "body_end";
  const defaultValues = {
    id: s.id,
    name: s.name,
    type: validType,
    isActive: s.isActive,
    usePartytown: s.usePartytown ?? true,
    config: s.config || "",
    location: validLocation,
  };

  return (
    <div className="container py-10">
      <div className="mb-10">
        <h1 className="text-3xl font-bold">Edit Analytics Script</h1>
        <p className="text-muted-foreground mt-2">
          Update an existing analytics or tracking script.
        </p>
      </div>
      <div className="max-w-3xl">
        <AnalyticsForm defaultValues={defaultValues} isEdit={true} />
      </div>
    </div>
  );
}
