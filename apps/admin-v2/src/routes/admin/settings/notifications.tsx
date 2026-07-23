import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BellRing, RadioTower } from "lucide-react";
import FirebaseSettingsForm from "~/components/admin/settings/FirebaseSettingsForm";
import { OfficialProviderMark } from "~/components/admin/settings/provider-marks";
import NotificationChannelsBuilder from "~/components/admin/settings/NotificationChannelsBuilder";
import {
  normalizeNotificationSettingsSection,
  normalizeNotificationRulesPanel,
  type NotificationRulesPanel,
  type NotificationSettingsSection,
} from "~/components/admin/settings/notification-settings-sections";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { RouteErrorComponent } from "~/lib/route-error";

export function validateNotificationSettingsSearch(
  search: Record<string, unknown>,
) {
  const section = normalizeNotificationSettingsSection(search.section);
  const panel = normalizeNotificationRulesPanel(search.panel);
  return {
    section,
    ...(section === "rules" && panel !== "customers" ? { panel } : {}),
  };
}

export const Route = createFileRoute("/admin/settings/notifications")({
  validateSearch: validateNotificationSettingsSearch,
  head: () => ({ meta: [{ title: "Notifications | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: NotificationSettingsPage,
});

function NotificationSettingsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const audience = normalizeNotificationRulesPanel(search.panel);

  const handleSectionChange = (section: string) => {
    void navigate({
      resetScroll: false,
      search: ((previous: Record<string, unknown>) => ({
        ...previous,
        section: section as NotificationSettingsSection,
      })) as never,
    });
  };

  const handleAudienceChange = (panel: NotificationRulesPanel) => {
    void navigate({
      resetScroll: false,
      search: ((previous: Record<string, unknown>) => ({
        ...previous,
        section: "rules",
        panel: panel === "customers" ? undefined : panel,
      })) as never,
    });
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
      </div>

      <Tabs value={search.section} onValueChange={handleSectionChange}>
        <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-md border bg-card p-1 sm:w-fit">
          <TabsTrigger value="rules" className="min-h-11 gap-2 px-3 sm:min-h-9">
            <BellRing className="h-4 w-4" aria-hidden="true" />
            Rules
          </TabsTrigger>
          <TabsTrigger value="push" className="min-h-11 gap-2 px-3 sm:min-h-9">
            <RadioTower className="h-4 w-4" aria-hidden="true" />
            Push setup
          </TabsTrigger>
        </TabsList>

        <TabsContent value="rules" className="mt-4">
          {search.section === "rules" ? (
            <NotificationChannelsBuilder
              audience={audience}
              onAudienceChange={handleAudienceChange}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="push" className="mt-4">
          {search.section === "push" ? (
            <section aria-labelledby="push-provider-heading" className="space-y-3">
              <div>
                <h2
                  id="push-provider-heading"
                  className="flex items-center gap-2 text-base font-semibold tracking-tight"
                >
                  <OfficialProviderMark provider="firebase" />
                  Firebase Cloud Messaging
                </h2>
              </div>
              <FirebaseSettingsForm />
            </section>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}
