import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("Meta CAPI workspace presentation", () => {
  it("separates setup, enablement, browser parity, and delivery evidence", () => {
    const settings = readSource("./MetaConversionsSettingsForm.tsx");

    expect(settings).toContain("Credentials saved");
    expect(settings).toContain("Server events");
    expect(settings).toContain('text-muted-foreground">Mode</dt>');
    expect(settings).toContain('testMode ? "Test events" : "Live events"');
    expect(settings).toContain("Browser Pixel matches");
    expect(settings).toContain("Saving does not test delivery");
    expect(settings).not.toContain("for improved tracking and attribution");
  });

  it("uses the real retention unit and does not invent a 12-hour policy", () => {
    const settings = readSource("./MetaConversionsSettingsForm.tsx");
    const logs = readSource("./MetaConversionsLogs.tsx");
    const hook = readSource("./hooks/useMetaConversionsLogs.ts");

    expect(settings).toContain("Keep delivery logs");
    expect(settings).toContain("older than this many days");
    expect(settings).not.toContain("retentionInfo?.hours || 12");
    expect(logs).toContain("retentionInfo?.days ?? 30");
    expect(hook).toContain("days: number");
  });

  it("keeps settings and destructive log actions permission-aware", () => {
    const settings = readSource("./MetaConversionsSettingsForm.tsx");
    const logs = readSource("./MetaConversionsLogs.tsx");

    expect(settings).toContain("ADMIN_PERMISSIONS.ANALYTICS_EDIT");
    expect(settings).toContain("Read-only access");
    expect(settings).toContain("<UnsavedChangesGuard");
    expect(logs).toContain("ADMIN_PERMISSIONS.ANALYTICS_EDIT");
    expect(logs).toContain("{canEdit ? (");
  });

  it("provides explicit errors, accessible controls, and a mobile delivery view", () => {
    const settings = readSource("./MetaConversionsSettingsForm.tsx");
    const logs = readSource("./MetaConversionsLogs.tsx");
    const details = readSource("./LogDetails.tsx");
    const hook = readSource("./hooks/useMetaConversionsLogs.ts");

    expect(settings).toContain('aria-label={showAccessToken ? "Hide access token"');
    expect(logs).toContain("Delivery activity could not be refreshed");
    expect(logs).toContain("View redacted details");
    expect(logs).toContain("${log.eventName} ${log.eventId}");
    expect(logs).toContain('className="space-y-3 md:hidden"');
    expect(logs).toContain("aria-expanded={expandedLog === log.id}");
    expect(details).toContain("Privacy-safe request summary");
    expect(details).toContain("never customer identifiers or credentials");
    expect(hook).toContain("logsError");
    expect(
      readSource("./hooks/useMetaConversionsSettings.ts"),
    ).toContain("formDataFromSettings(initialSettings ?? null)");
    expect(settings).toContain("min-h-11");
    expect(logs).toContain("min-h-11");
  });

  it("uses compact route and phone-safe workspace tabs", () => {
    const route = readSource("../../../routes/admin/settings/meta-conversion.tsx");
    const container = readSource("./MetaConversionsContainer.tsx");

    expect(route).toContain(">Meta conversions</h1>");
    expect(route).toContain("text-xl font-semibold tracking-tight");
    expect(route).not.toContain("text-3xl");
    expect(container).toContain("min-h-11");
    expect(container).toContain("Setup");
    expect(container).toContain("Delivery");
  });

  it("keeps healthy parity and clean actions quiet", () => {
    const settings = readSource("./MetaConversionsSettingsForm.tsx");

    expect(settings).toContain('pixelParity.status === "ok"');
    expect(settings).toContain("<details");
    expect(settings).toContain("canEdit && hasUnsavedChanges");
    expect(settings).not.toContain("Settings are up to date");
    expect(settings).not.toContain("Delivery is verified separately");
  });
});
