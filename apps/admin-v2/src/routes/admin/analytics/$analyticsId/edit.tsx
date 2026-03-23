import { createFileRoute, redirect } from "@tanstack/react-router";
import { AnalyticsForm } from "~/components/admin/AnalyticsForm";
import { getAnalyticsScript } from "~/lib/api.functions";

export const Route = createFileRoute("/admin/analytics/$analyticsId/edit")({
  loader: async ({ params }) => {
    const script = await getAnalyticsScript({ data: { id: params.analyticsId } }).catch(() => null);
    if (!script) throw redirect({ to: "/admin/analytics" });
    const s = script as any;
    const validType = ["google_analytics", "facebook_pixel", "custom"].includes(s.type) ? s.type : "custom";
    const validLocation = ["head", "body_start", "body_end"].includes(s.location) ? s.location : "head";
    return {
      defaultValues: {
        id: s.id,
        name: s.name,
        type: validType,
        isActive: s.isActive,
        usePartytown: s.usePartytown ?? true,
        config: s.config || "",
        location: validLocation,
      },
    };
  },
  head: () => ({ meta: [{ title: "Edit Analytics Script | Scalius Admin" }] }),
  component: EditAnalyticsPage,
});

function EditAnalyticsPage() {
  const { defaultValues } = Route.useLoaderData();

  if (!defaultValues) {
    return <div>Analytics script not found</div>;
  }

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
