import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BellRing, RadioTower } from "lucide-react";
import FirebaseSettingsForm from "~/components/admin/settings/FirebaseSettingsForm";
import NotificationChannelsBuilder from "~/components/admin/settings/NotificationChannelsBuilder";
import {
  normalizeNotificationSettingsSection,
  type NotificationSettingsSection,
} from "~/components/admin/settings/notification-settings-sections";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { RouteErrorComponent } from "~/lib/route-error";

export function validateNotificationSettingsSearch(
  search: Record<string, unknown>,
) {
  return { section: normalizeNotificationSettingsSection(search.section) };
}

export const Route = createFileRoute("/admin/settings/notifications")({
  validateSearch: validateNotificationSettingsSearch,
  head: () => ({ meta: [{ title: "Notification Settings | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: NotificationSettingsPage,
});

function NotificationSettingsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();

  const handleSectionChange = (section: string) => {
    void navigate({
      search: ((previous: Record<string, unknown>) => ({
        ...previous,
        section: section as NotificationSettingsSection,
      })) as never,
    });
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
        <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
          Decide which events send, then configure the provider that delivers
          admin browser push. Provider readiness never changes an event rule
          silently.
        </p>
      </div>

      <Tabs value={search.section} onValueChange={handleSectionChange}>
        <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-md border bg-card p-1 sm:w-fit">
          <TabsTrigger value="rules" className="min-h-9 gap-2 px-3">
            <BellRing className="h-4 w-4" aria-hidden="true" />
            Delivery rules
          </TabsTrigger>
          <TabsTrigger value="push" className="min-h-9 gap-2 px-3">
            <RadioTower className="h-4 w-4" aria-hidden="true" />
            Admin push
          </TabsTrigger>
        </TabsList>

        <TabsContent value="rules" className="mt-4">
          {search.section === "rules" ? <NotificationChannelsBuilder /> : null}
        </TabsContent>

        <TabsContent value="push" className="mt-4">
          {search.section === "push" ? (
            <section aria-labelledby="push-provider-heading" className="space-y-3">
              <div>
                <h2
                  id="push-provider-heading"
                  className="text-base font-semibold tracking-tight"
                >
                  Firebase Cloud Messaging
                </h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Provider setup for admin browser push only. Customer email,
                  SMS, and WhatsApp providers are configured independently.
                </p>
              </div>
              <FirebaseSettingsForm />
            </section>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}
