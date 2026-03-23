import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { WidgetForm } from "~/components/admin/widgets/WidgetForm";
import { widgetQueryOptions, widgetsQueryOptions } from "~/lib/api.queries";
import type { Widget, WidgetListResponse } from "~/types/api-responses";
import { WidgetPlacementRule } from "~/types/api-responses";

export const Route = createFileRoute("/admin/widgets/$widgetId")({
  loader: async ({ context: { queryClient }, params }) => {
    const isCreateMode = params.widgetId === "create";
    const promises: Promise<unknown>[] = [
      queryClient.ensureQueryData(widgetsQueryOptions({})),
    ];
    if (!isCreateMode) {
      promises.push(queryClient.ensureQueryData(widgetQueryOptions(params.widgetId)));
    }
    await Promise.all(promises);
    return { isCreateMode };
  },
  head: () => ({
    meta: [{ title: "Widget | Scalius Admin" }],
  }),
  component: WidgetFormPage,
});

function WidgetFormPage() {
  const { isCreateMode } = Route.useLoaderData();

  return isCreateMode ? <WidgetCreateForm /> : <WidgetEditForm />;
}

function WidgetCreateForm() {
  const { data: listData } = useSuspenseQuery(widgetsQueryOptions({}));
  const availableCollections = (listData as WidgetListResponse).availableCollections || [];

  return (
    <div className="container mx-auto py-6">
      <WidgetForm
        widget={null}
        isCreateMode={true}
        availableCollections={availableCollections}
        placementRules={Object.values(WidgetPlacementRule)}
        submitButtonText="Create Widget"
      />
    </div>
  );
}

function WidgetEditForm() {
  const { widgetId } = Route.useParams();
  const { data: listData } = useSuspenseQuery(widgetsQueryOptions({}));
  const { data: widgetData } = useSuspenseQuery(widgetQueryOptions(widgetId));

  const widget = widgetData as Widget;
  const availableCollections = (listData as WidgetListResponse).availableCollections || [];

  return (
    <div className="container mx-auto py-6">
      <WidgetForm
        widget={widget}
        isCreateMode={false}
        availableCollections={availableCollections}
        placementRules={Object.values(WidgetPlacementRule)}
        submitButtonText="Save Changes"
      />
    </div>
  );
}
