import { createFileRoute } from "@tanstack/react-router";
import { AnalyticsForm } from "~/components/admin/AnalyticsForm";

export const Route = createFileRoute("/admin/analytics/new")({
  head: () => ({ meta: [{ title: "Add Analytics Script | Scalius Admin" }] }),
  component: NewAnalyticsPage,
});

function NewAnalyticsPage() {
  return (
    <div className="container py-10">
      <div className="mb-10">
        <h1 className="text-3xl font-bold">Add Analytics Script</h1>
        <p className="text-muted-foreground mt-2">
          Add a new analytics or tracking script to your site.
        </p>
      </div>
      <div className="max-w-3xl">
        <AnalyticsForm />
      </div>
    </div>
  );
}
