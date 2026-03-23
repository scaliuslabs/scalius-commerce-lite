import { createFileRoute } from "@tanstack/react-router";
import FirebaseSettingsForm from "~/components/admin/settings/FirebaseSettingsForm";
import { firebaseSettingsQueryOptions } from "~/lib/api.queries";

export const Route = createFileRoute("/admin/settings/notifications")({
  loader: async ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(firebaseSettingsQueryOptions());
  },
  head: () => ({ meta: [{ title: "Notification Settings | Scalius Admin" }] }),
  component: NotificationSettingsPage,
});

function NotificationSettingsPage() {
  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Notification Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure push notifications for order alerts and updates.
        </p>
      </div>
      <FirebaseSettingsForm />
    </div>
  );
}
