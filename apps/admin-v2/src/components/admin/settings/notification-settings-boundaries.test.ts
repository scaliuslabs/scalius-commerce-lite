import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const generalSettingsSource = readFileSync(
  new URL("./GeneralSettingsPage.tsx", import.meta.url),
  "utf8",
);
const notificationRouteSource = readFileSync(
  new URL(
    "../../../routes/admin/settings/notifications.tsx",
    import.meta.url,
  ),
  "utf8",
);

describe("notification settings ownership", () => {
  it("keeps the event rule editor out of General settings", () => {
    expect(generalSettingsSource).not.toContain("NotificationChannelsBuilder");
    expect(generalSettingsSource).not.toContain('value: "notification-channels"');
  });

  it("keeps event rules and admin push setup as separate URL-backed workspaces", () => {
    expect(notificationRouteSource).toContain(
      "validateNotificationSettingsSearch",
    );
    expect(notificationRouteSource).toContain('value="rules"');
    expect(notificationRouteSource).toContain('value="push"');
    expect(notificationRouteSource).toContain("<NotificationChannelsBuilder />");
    expect(notificationRouteSource).toContain("<FirebaseSettingsForm />");
    expect(notificationRouteSource).toContain(
      'search.section === "push"',
    );
    expect(notificationRouteSource).toContain("Push setup");
    expect(notificationRouteSource).not.toContain(
      "Choose which events send and review delivery-provider readiness.",
    );
  });
});
