import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
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
  },
  head: () => ({
    meta: [{ title: "Widget | Scalius Admin" }],
  }),
  component: WidgetFormPage,
});

function WidgetFormPage() {
  const { widgetId } = Route.useParams();
  const isCreateMode = widgetId === "create";
  const { data: listData } = useSuspenseQuery(widgetsQueryOptions({}));
  // useQuery (not useSuspenseQuery) to support enabled: false for create mode
  const { data: widgetData } = useQuery({
    ...widgetQueryOptions(widgetId),
    enabled: !isCreateMode,
  });

  const widget = isCreateMode ? null : (widgetData as Widget | null);
  const availableCollections = (listData as WidgetListResponse).availableCollections || [];
  const submitButtonText = isCreateMode ? "Create Widget" : "Save Changes";

  return (
    <div className="container mx-auto py-6">
      <WidgetForm
        widget={widget}
        isCreateMode={isCreateMode}
        availableCollections={availableCollections}
        placementRules={Object.values(WidgetPlacementRule)}
        submitButtonText={submitButtonText}
      />
    </div>
  );
}
