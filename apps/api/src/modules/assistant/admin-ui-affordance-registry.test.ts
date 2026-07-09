import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADMIN_COMMAND_REGISTRY,
  describeAdminCapability,
} from "./admin-command-registry";
import {
  ADMIN_SETTING_GROUP_REGISTRY,
  ADMIN_SETTINGS_PAGE_REGISTRY,
  ADMIN_UI_AFFORDANCE_EXTENSION_CONTRACT,
  adminUiAffordanceDriftKey,
  auditAdminUiAffordanceRegistrations,
  registerAdminUiAffordances,
  type AdminUiAffordanceExpectation,
  type AdminUiAffordanceRegistration,
} from "./admin-ui-affordance-registry";

describe("Admin settings and UI affordance registry", () => {
  it("classifies all 86 settings operations into 30 deterministic groups", () => {
    const settingsOperations = ADMIN_COMMAND_REGISTRY.filter((descriptor) =>
      descriptor.pathTemplate.startsWith("/api/v1/admin/settings/"),
    );
    const groupedIds = ADMIN_SETTING_GROUP_REGISTRY.flatMap((group) => group.operationIds);

    expect(settingsOperations).toHaveLength(86);
    expect(ADMIN_SETTING_GROUP_REGISTRY).toHaveLength(30);
    expect(groupedIds).toHaveLength(86);
    expect(new Set(groupedIds).size).toBe(86);
    expect([...groupedIds].sort()).toEqual(settingsOperations.map((descriptor) => descriptor.id).sort());
    expect(ADMIN_SETTING_GROUP_REGISTRY.every((group) =>
      group.coverage === "operation-group-only" &&
      group.fieldLevelRegistrationRequired &&
      group.executionEnabled === false
    )).toBe(true);
  });

  it("tracks every authenticated settings route without claiming field coverage", () => {
    const routeDirectory = fileURLToPath(new URL(
      "../../../../admin-v2/src/routes/admin/settings",
      import.meta.url,
    ));
    const actualFileStems = readdirSync(routeDirectory)
      .filter((fileName) => fileName.endsWith(".tsx") && !fileName.startsWith("-"))
      .map((fileName) => fileName.slice(0, -4))
      .sort();

    expect(ADMIN_SETTINGS_PAGE_REGISTRY).toHaveLength(11);
    expect(ADMIN_SETTINGS_PAGE_REGISTRY.map((page) => page.fileStem).sort())
      .toEqual(actualFileStems);
    expect(ADMIN_SETTINGS_PAGE_REGISTRY.every((page) =>
      page.coverage === "page-and-operation-groups-only" && page.fieldLevelRegistrationRequired
    )).toBe(true);
    expect(ADMIN_UI_AFFORDANCE_EXTENSION_CONTRACT).toMatchObject({
      coverageLevel: "settings-operation-groups-and-pages",
      fullPageControlCoverage: false,
      fieldLevelControlsRegistered: false,
      futureRegistrationSource: "authenticated-dashboard-page-state",
    });
  });

  it("keeps exact page authorization and manual fallbacks for unsupported surfaces", () => {
    expect(ADMIN_SETTINGS_PAGE_REGISTRY.find((page) => page.path === "/admin/settings/account"))
      .toMatchObject({
        authorization: { kind: "any-admin" },
        implementation: "secure-manual",
      });
    expect(ADMIN_SETTINGS_PAGE_REGISTRY.find((page) => page.path === "/admin/settings/cache"))
      .toMatchObject({
        authorization: { kind: "permission", permission: "settings.cache.view" },
        implementation: "secure-manual",
        operationIds: [],
      });
    expect(ADMIN_SETTINGS_PAGE_REGISTRY.find((page) => page.path === "/admin/settings/theme"))
      .toMatchObject({
        authorization: { kind: "permission", permission: "settings.general.view" },
        implementation: "typed-command",
      });
    expect(ADMIN_SETTINGS_PAGE_REGISTRY.find((page) => page.path === "/admin/settings/taxes"))
      .toMatchObject({
        authorization: { kind: "permission", permission: "taxes.view" },
        implementation: "typed-command",
      });
  });

  it("uses secure-manual classification for credential-bearing setting groups", () => {
    for (const groupName of [
      "delivery-providers",
      "email",
      "firebase",
      "meta-conversions",
      "polar",
      "security",
      "sms",
      "sslcommerz",
      "stripe",
      "widget-ai",
    ]) {
      expect(ADMIN_SETTING_GROUP_REGISTRY.find((group) => group.settingGroup === groupName), groupName)
        .toMatchObject({ implementation: "secure-manual" });
    }
  });

  it("registers typed, browser-only, and secure controls against page-state expectations", () => {
    const themeCapability = describeAdminCapability("admin.api.post.settings.theme");
    const stripeCapability = describeAdminCapability("admin.api.post.settings.stripe");
    expect(themeCapability).not.toBeNull();
    expect(stripeCapability).not.toBeNull();

    const expectations: AdminUiAffordanceExpectation[] = [
      { pagePath: "/admin/settings/theme", stableKey: "save-theme" },
      { pagePath: "/admin/settings/theme", stableKey: "focus-brand-color" },
      { pagePath: "/admin/settings", stableKey: "edit-stripe-secret" },
    ];
    const registrations: AdminUiAffordanceRegistration[] = [
      {
        ...expectations[0]!,
        classification: "typed-command",
        capabilityIds: [themeCapability!.id],
      },
      {
        ...expectations[1]!,
        classification: "browser-adapter",
        capabilityIds: [],
      },
      {
        ...expectations[2]!,
        classification: "secure-manual",
        capabilityIds: [stripeCapability!.id],
      },
    ];

    expect(auditAdminUiAffordanceRegistrations(expectations, registrations)).toEqual([]);
    expect(registerAdminUiAffordances(expectations, registrations)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "admin.ui.settings.edit-stripe-secret",
        classification: "secure-manual",
        risk: "R3",
      }),
      expect.objectContaining({
        id: "admin.ui.settings.theme.focus-brand-color",
        classification: "browser-adapter",
        risk: "R1",
      }),
      expect.objectContaining({
        id: "admin.ui.settings.theme.save-theme",
        classification: "typed-command",
        risk: "R2",
      }),
    ]));
  });

  it("fails the future page-state drift hook on missing, unknown, duplicate, or unsafe controls", () => {
    const expected = [{ pagePath: "/admin/settings/theme", stableKey: "save-theme" }] as const;
    expect(auditAdminUiAffordanceRegistrations(expected, [])).toContain(
      "/admin/settings/theme#save-theme: unclassified UI affordance",
    );

    const invalid: AdminUiAffordanceRegistration[] = [
      {
        pagePath: "/admin/settings/theme",
        stableKey: "save-theme",
        classification: "typed-command",
        capabilityIds: ["admin.api.post.not-real"],
      },
      {
        pagePath: "/admin/settings/theme",
        stableKey: "save-theme",
        classification: "typed-command",
        capabilityIds: [],
      },
      {
        pagePath: "/admin/settings/../orders",
        stableKey: "unsafe-control",
        classification: "browser-adapter",
        capabilityIds: [],
      },
      {
        pagePath: "/admin/settings/theme",
        stableKey: "unclassified-control",
        classification: "unclassified" as AdminUiAffordanceRegistration["classification"],
        capabilityIds: [],
      },
    ];
    const issues = auditAdminUiAffordanceRegistrations(expected, invalid);
    expect(issues).toContain(
      "/admin/settings/theme#save-theme: unknown linked capability admin.api.post.not-real",
    );
    expect(issues).toContain("/admin/settings/theme#save-theme: duplicate UI registration");
    expect(issues).toContain("/admin/settings/theme#save-theme: typed command has no capability");
    expect(issues).toContain("/admin/settings/../orders#unsafe-control: unsafe UI registration identity");
    expect(issues).toContain(
      "/admin/settings/theme#unclassified-control: unclassified UI affordance implementation",
    );
  });

  it("produces a deterministic registration drift key", () => {
    const left: AdminUiAffordanceRegistration = {
      pagePath: "/admin/settings/theme",
      stableKey: "focus-brand-color",
      classification: "browser-adapter",
      capabilityIds: [],
    };
    const right: AdminUiAffordanceRegistration = {
      pagePath: "/admin/settings/theme",
      stableKey: "save-theme",
      classification: "typed-command",
      capabilityIds: ["admin.api.post.settings.theme"],
    };

    expect(adminUiAffordanceDriftKey([left, right]))
      .toBe(adminUiAffordanceDriftKey([right, left]));
  });
});
