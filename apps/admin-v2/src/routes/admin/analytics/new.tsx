import { createFileRoute } from "@tanstack/react-router";
import { AnalyticsForm } from "~/components/admin/AnalyticsForm";

export const Route = createFileRoute("/admin/analytics/new")({
  head: () => ({ meta: [{ title: "New Analytics Integration | Scalius Admin" }] }),
  component: NewAnalyticsPage,
});

function NewAnalyticsPage() {
  return <AnalyticsForm />;
}
