import { createFileRoute } from "@tanstack/react-router";
import { WidgetForm } from "~/components/admin/widgets/WidgetForm";
import { getWidget, getWidgets } from "~/lib/api.functions";

const WidgetPlacementRule = {
  BEFORE_COLLECTION: "before_collection",
  AFTER_COLLECTION: "after_collection",
  FIXED_TOP_HOMEPAGE: "fixed_top_homepage",
  FIXED_BOTTOM_HOMEPAGE: "fixed_bottom_homepage",
  STANDALONE: "standalone",
} as const;

export const Route = createFileRoute("/admin/widgets/$widgetId")({
  loader: async ({ params }) => {
    const isCreateMode = params.widgetId === "create";
    let widget = null;
    let pageTitle = "Create New Widget";
    let submitButtonText = "Create Widget";
    if (!isCreateMode) {
      const dbWidget = await getWidget({ data: { id: params.widgetId } }).catch(() => null);
      if (dbWidget) {
        const w = dbWidget as any;
        pageTitle = `Edit Widget: ${w.name}`;
        submitButtonText = "Save Changes";
        widget = w;
      }
    }
    const listData = await getWidgets({ data: {} }).catch(() => ({ availableCollections: [] }));
    const availableCollections = (listData as any).availableCollections || [];
    return {
      widget,
      isCreateMode,
      pageTitle,
      submitButtonText,
      availableCollections,
      placementRules: Object.values(WidgetPlacementRule),
    };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.pageTitle || "Widget"} | Scalius Admin` }],
  }),
  component: WidgetFormPage,
});

function WidgetFormPage() {
  const { widget, isCreateMode, availableCollections, placementRules, submitButtonText } = Route.useLoaderData();

  return (
    <div className="container mx-auto py-6">
      <WidgetForm
        widget={widget}
        isCreateMode={isCreateMode}
        availableCollections={availableCollections}
        placementRules={placementRules}
        submitButtonText={submitButtonText}
      />
    </div>
  );
}
