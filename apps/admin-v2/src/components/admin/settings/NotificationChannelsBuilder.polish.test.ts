import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./NotificationChannelsBuilder.tsx", import.meta.url),
  "utf8",
);

describe("notification rules workspace", () => {
  it("keeps merchant intent editable when delivery is paused", () => {
    expect(source).not.toContain("channelCanBeEnabled");
    expect(source).not.toContain('disabled={!readiness[channel.key]}');
    expect(source).not.toContain('channel === "push" && !isPushConfigured');
    expect(source).toContain("Saved rules stay paused.");
  });

  it("does not present untested email delivery as ready", () => {
    expect(source).toContain('readyLabel="Configured"');
    expect(source).toContain("delivery has not been tested.");
    expect(source).toContain("readyDescription");
  });

  it("protects rule changes with permissions, reset, and navigation guards", () => {
    expect(source).toContain("ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT");
    expect(source).toContain("<UnsavedChangesGuard");
    expect(source).toContain("setChannels(savedChannels)");
    expect(source).toContain("setAdminChannels(savedAdminChannels)");
  });

  it("uses mobile-safe action and template controls", () => {
    expect(source).toContain("min-h-11 shrink-0 sm:min-h-9");
    expect(source).toContain('className="h-11 sm:h-9"');
    expect(source).toContain("min-h-11 min-w-0");
  });

  it("keeps the mobile rules workspace compact without hiding capabilities", () => {
    expect(source).toContain("CustomerChannelControl");
    expect(source).toContain("Customer channel rules and readiness");
    expect(source.match(/<details key=\{group\.label\}/g)).toHaveLength(2);
    expect(source.match(/\{group\.keys\.length\} events/g)).toHaveLength(2);
    expect(source).toContain('className="divide-y md:hidden"');
    expect(source).toContain('className="hidden md:block"');
    expect(source).toContain("min-h-11 cursor-pointer list-none");
    expect(source).not.toContain("Choose which order events reach buyers.");
    expect(source).not.toContain(
      "Choose which events alert signed-in admin devices.",
    );
  });

  it("scopes the rules workspace to one audience at a time", () => {
    expect(source).toContain('aria-label="Notification audience"');
    expect(source).toContain('audience === "customers" ? <Card role="tabpanel">');
    expect(source).toContain('audience === "admins" ? <Card role="tabpanel">');
    expect(source).toContain("Administrators");
  });
});
