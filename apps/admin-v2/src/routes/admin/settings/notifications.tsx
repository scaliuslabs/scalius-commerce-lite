import { createFileRoute } from "@tanstack/react-router";
import FirebaseSettingsForm from "~/components/admin/settings/FirebaseSettingsForm";
import NotificationChannelsBuilder from "~/components/admin/settings/NotificationChannelsBuilder";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/notifications")({
  head: () => ({ meta: [{ title: "Notification Settings | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: NotificationSettingsPage,
});

function NotificationSettingsPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Notification Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure customer order updates, admin push alerts, and Firebase delivery credentials.
        </p>
      </div>
      <NotificationChannelsBuilder />
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Firebase Push Provider</h2>
          <p className="text-sm text-muted-foreground">
            Used only for admin device push notifications.
          </p>
        </div>
        <FirebaseSettingsForm />
      </section>
    </div>
  );
}
