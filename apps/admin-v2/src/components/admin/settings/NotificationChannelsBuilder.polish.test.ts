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

  it("protects rule changes with permissions, discard, and navigation guards", () => {
    expect(source).toContain("ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT");
    // One contextual save bar covers both audiences: it stays armed while
    // either draft is dirty, and Save/Discard act on the audience on screen.
    expect(source).toContain("<ContextualSaveBar");
    expect(source).toContain("isDirty={customerDirty || adminDirty}");
    expect(source).toContain("canSave={canManage}");
    expect(source).toContain("onDiscard={discardAudienceDraft}");
    expect(source).toContain(
      'onSave={audience === "customers" ? handleSave : handleAdminSave}',
    );
    expect(source).toContain("setChannels(savedChannels)");
    expect(source).toContain("setAdminChannels(savedAdminChannels)");
    expect(source).not.toContain("<UnsavedChangesGuard");
  });

  it("uses mobile-safe action and template controls", () => {
    // The save pair moved into the contextual save bar, which already gives
    // both actions full-width 44px targets below `sm`.
    expect(source).not.toContain("Save customer rules\n");
    expect(source).toContain('saveLabel={audienceSaveLabel}');
    expect(source).toContain("min-h-11");
    expect(source).toContain('className="h-11 sm:h-9"');
    expect(source).not.toContain("flex-col-reverse");
  });

  it("keeps the mobile rules workspace compact without hiding capabilities", () => {
    expect(source).toContain("CustomerChannelControl");
    expect(source).toContain("Customer channel rules and readiness");
    expect(source).toContain("grid-cols-1 gap-2 sm:grid-cols-3");
    expect(source).toContain("font-medium sm:truncate");
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
    expect(source).toContain('audience === "customers" ? isSaving : isAdminSaving');
    expect(source).toContain("Administrators");
  });
});
