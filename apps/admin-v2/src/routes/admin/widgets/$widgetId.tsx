import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { WidgetForm } from "~/components/admin/widgets/WidgetForm";
import { widgetQueryOptions } from "~/lib/api-query-options/widgets";
import type { Widget } from "~/types/api-responses";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/widgets/$widgetId")({
  loader: async ({ context: { queryClient }, params }) => {
    const isCreateMode = params.widgetId === "create" || params.widgetId === "new";
    if (!isCreateMode) {
      await queryClient.ensureQueryData({ ...widgetQueryOptions(params.widgetId), staleTime: Infinity });
    }
    return { isCreateMode };
  },
  head: () => ({
    meta: [{ title: "Widget | Scalius Admin" }],
  }),
  errorComponent: RouteErrorComponent,
  component: WidgetFormPage,
});

function WidgetFormPage() {
  const { isCreateMode } = Route.useLoaderData();

  return isCreateMode ? <WidgetCreateForm /> : <WidgetEditForm />;
}

function WidgetCreateForm() {
  return (
    <div className="container mx-auto py-6">
      <WidgetForm
        widget={null}
        isCreateMode={true}
        submitButtonText="Create Widget"
      />
    </div>
  );
}

function WidgetEditForm() {
  const { widgetId } = Route.useParams();
  const { data: widgetData } = useSuspenseQuery(widgetQueryOptions(widgetId));

  const widget = widgetData as Widget;

  return (
    <div className="container mx-auto py-6">
      <WidgetForm
        widget={widget}
        isCreateMode={false}
        submitButtonText="Save Changes"
      />
    </div>
  );
}
