import { getPagePermission } from "@scalius/core/auth/rbac/page-permissions";
import {
  ADMIN_COMMAND_REGISTRY,
  describeAdminCapability,
  type AdminAuthorization,
  type AdminCapabilityImplementation,
  type AdminRisk,
} from "./admin-command-registry";

export const ADMIN_UI_AFFORDANCE_EXTENSION_CONTRACT = Object.freeze({
  schemaVersion: 1 as const,
  coverageLevel: "settings-operation-groups-and-pages" as const,
  fullPageControlCoverage: false,
  fieldLevelControlsRegistered: false,
  futureRegistrationSource: "authenticated-dashboard-page-state" as const,
  allowedClassifications: [
    "typed-command",
    "browser-adapter",
    "secure-manual",
  ] as const,
});

interface SettingsPageSource {
  readonly path: string;
  readonly fileStem: string;
  readonly implementation: AdminCapabilityImplementation;
  readonly settingGroups: readonly string[];
  readonly extraOperationPrefixes?: readonly string[];
}

const SETTINGS_PAGE_SOURCES: readonly SettingsPageSource[] = [
  {
    path: "/admin/settings",
    fileStem: "index",
    implementation: "secure-manual",
    settingGroups: [
      "allowed-countries",
      "business",
      "currency",
      "email",
      "firebase",
      "footer",
      "general",
      "header",
      "media",
      "payment-methods",
      "polar",
      "security",
      "seo",
      "sms",
      "sslcommerz",
      "storefront-url",
      "stripe",
      "widget-ai",
    ],
  },
  {
    path: "/admin/settings/account",
    fileStem: "account",
    implementation: "secure-manual",
    settingGroups: [],
    extraOperationPrefixes: ["/api/v1/admin/auth/"],
  },
  {
    path: "/admin/settings/cache",
    fileStem: "cache",
    implementation: "secure-manual",
    settingGroups: [],
  },
  {
    path: "/admin/settings/checkout",
    fileStem: "checkout",
    implementation: "secure-manual",
    settingGroups: [
      "allowed-countries",
      "auth",
      "checkout-languages",
      "checkout-readiness",
      "currency",
      "delivery-locations",
      "payment-methods",
      "polar",
      "security",
      "shipping-methods",
      "sslcommerz",
      "stripe",
    ],
  },
  {
    path: "/admin/settings/delivery-providers",
    fileStem: "delivery-providers",
    implementation: "secure-manual",
    settingGroups: ["delivery-providers"],
  },
  {
    path: "/admin/settings/fraud-checker",
    fileStem: "fraud-checker",
    implementation: "secure-manual",
    settingGroups: [],
    extraOperationPrefixes: ["/api/v1/admin/fraud-checker"],
  },
  {
    path: "/admin/settings/hero-sliders",
    fileStem: "hero-sliders",
    implementation: "typed-command",
    settingGroups: ["hero-sliders"],
  },
  {
    path: "/admin/settings/meta-conversion",
    fileStem: "meta-conversion",
    implementation: "secure-manual",
    settingGroups: ["meta-conversions"],
  },
  {
    path: "/admin/settings/notifications",
    fileStem: "notifications",
    implementation: "typed-command",
    settingGroups: ["notification-channels"],
  },
  {
    path: "/admin/settings/theme",
    fileStem: "theme",
    implementation: "typed-command",
    settingGroups: ["theme"],
  },
];

function normalizePageAuthorization(path: string): AdminAuthorization {
  const permission = getPagePermission(path);
  if (!permission) throw new Error(`Unmapped authenticated Admin settings page: ${path}`);

  const modes = [
    typeof permission.permission === "string",
    Boolean(permission.anyOf?.length),
    Boolean(permission.allOf?.length),
    permission.allowAnyAdmin === true,
  ].filter(Boolean).length;
  if (modes !== 1) throw new Error(`Ambiguous Admin page permission: ${path}`);

  if (permission.permission) return { kind: "permission", permission: permission.permission };
  if (permission.anyOf?.length) return { kind: "any-of", permissions: [...permission.anyOf].sort() };
  if (permission.allOf?.length) return { kind: "all-of", permissions: [...permission.allOf].sort() };
  return { kind: "any-admin" };
}

function settingGroup(pathTemplate: string): string | null {
  return pathTemplate.match(/^\/api\/v1\/admin\/settings\/([^/{:]+)/)?.[1] ?? null;
}

export interface AdminSettingGroupDescriptor {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly settingGroup: string;
  readonly surface: "admin";
  readonly implementation: "typed-command" | "secure-manual";
  readonly operationIds: readonly string[];
  readonly pagePaths: readonly string[];
  readonly coverage: "operation-group-only";
  readonly fieldLevelRegistrationRequired: true;
  readonly executionEnabled: false;
}

const groupMap = new Map<string, string[]>();
for (const descriptor of ADMIN_COMMAND_REGISTRY) {
  const group = settingGroup(descriptor.pathTemplate);
  if (!group) continue;
  const ids = groupMap.get(group) ?? [];
  ids.push(descriptor.id);
  groupMap.set(group, ids);
}

export const ADMIN_SETTING_GROUP_REGISTRY: readonly AdminSettingGroupDescriptor[] = Object.freeze(
  [...groupMap.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, operationIds]) => {
      const implementation = operationIds.some((id) =>
        describeAdminCapability(id)?.implementation === "secure-manual"
      ) ? "secure-manual" as const : "typed-command" as const;
      const pagePaths = SETTINGS_PAGE_SOURCES
        .filter((page) => page.settingGroups.includes(group))
        .map((page) => page.path)
        .sort();
      return Object.freeze({
        schemaVersion: 1 as const,
        id: `admin.settings-group.${group}`,
        settingGroup: group,
        surface: "admin" as const,
        implementation,
        operationIds: Object.freeze([...operationIds].sort()),
        pagePaths: Object.freeze(pagePaths),
        coverage: "operation-group-only" as const,
        fieldLevelRegistrationRequired: true as const,
        executionEnabled: false as const,
      });
    }),
);

export interface AdminSettingsPageDescriptor {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly path: string;
  readonly fileStem: string;
  readonly surface: "admin";
  readonly authorization: AdminAuthorization;
  readonly implementation: AdminCapabilityImplementation;
  readonly settingGroupIds: readonly string[];
  readonly operationIds: readonly string[];
  readonly coverage: "page-and-operation-groups-only";
  readonly fieldLevelRegistrationRequired: true;
}

export const ADMIN_SETTINGS_PAGE_REGISTRY: readonly AdminSettingsPageDescriptor[] = Object.freeze(
  SETTINGS_PAGE_SOURCES.map((source) => {
    const operationIds = ADMIN_COMMAND_REGISTRY.filter((descriptor) => {
      const group = settingGroup(descriptor.pathTemplate);
      return (group !== null && source.settingGroups.includes(group)) ||
        source.extraOperationPrefixes?.some((prefix) => descriptor.pathTemplate.startsWith(prefix));
    }).map((descriptor) => descriptor.id).sort();

    return Object.freeze({
      schemaVersion: 1 as const,
      id: source.path === "/admin/settings"
        ? "admin.settings-page.general"
        : `admin.settings-page.${source.fileStem}`,
      path: source.path,
      fileStem: source.fileStem,
      surface: "admin" as const,
      authorization: normalizePageAuthorization(source.path),
      implementation: source.implementation,
      settingGroupIds: Object.freeze(
        source.settingGroups.map((group) => `admin.settings-group.${group}`).sort(),
      ),
      operationIds: Object.freeze(operationIds),
      coverage: "page-and-operation-groups-only" as const,
      fieldLevelRegistrationRequired: true as const,
    });
  }),
);

export interface AdminUiAffordanceExpectation {
  readonly pagePath: string;
  readonly stableKey: string;
}

export interface AdminUiAffordanceRegistration extends AdminUiAffordanceExpectation {
  readonly classification: AdminCapabilityImplementation;
  readonly capabilityIds: readonly string[];
}

export interface RegisteredAdminUiAffordance {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly pagePath: string;
  readonly stableKey: string;
  readonly surface: "admin";
  readonly classification: AdminCapabilityImplementation;
  readonly authorization: AdminAuthorization;
  readonly capabilityIds: readonly string[];
  readonly risk: AdminRisk;
}

function safeAdminPagePath(path: string): boolean {
  return (
    path.startsWith("/admin") &&
    path.length <= 240 &&
    !/[?#\\%]/.test(path) &&
    !path.includes("://") &&
    path.split("/").every((segment, index) => index === 0 || (
      segment.length > 0 && segment !== "." && segment !== ".." &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)
    ))
  );
}

function affordanceIdentity(value: AdminUiAffordanceExpectation): string {
  return `${value.pagePath}#${value.stableKey}`;
}

function uiId(value: AdminUiAffordanceExpectation): string {
  const page = value.pagePath === "/admin"
    ? "home"
    : value.pagePath.slice("/admin/".length).replaceAll("/", ".");
  return `admin.ui.${page}.${value.stableKey}`;
}

function riskRank(risk: AdminRisk): number {
  return Number(risk.slice(1));
}

function registrationRisk(registration: AdminUiAffordanceRegistration): AdminRisk {
  if (registration.classification === "browser-adapter") return "R1";
  if (registration.classification === "secure-manual") return "R3";
  return registration.capabilityIds.reduce<AdminRisk>((highest, id) => {
    const risk = describeAdminCapability(id)?.risk ?? "R0";
    return riskRank(risk) > riskRank(highest) ? risk : highest;
  }, "R0");
}

export function auditAdminUiAffordanceRegistrations(
  expectations: readonly AdminUiAffordanceExpectation[],
  registrations: readonly AdminUiAffordanceRegistration[],
): readonly string[] {
  const issues: string[] = [];
  const expectedKeys = new Set<string>();
  const registeredKeys = new Set<string>();
  const registeredIds = new Set<string>();

  for (const expected of expectations) {
    const key = affordanceIdentity(expected);
    if (expectedKeys.has(key)) issues.push(`${key}: duplicate UI expectation`);
    expectedKeys.add(key);
    if (!safeAdminPagePath(expected.pagePath) || !/^[a-z][a-z0-9-]{0,79}$/.test(expected.stableKey)) {
      issues.push(`${key}: unsafe UI expectation identity`);
    }
  }

  for (const registration of registrations) {
    const key = affordanceIdentity(registration);
    const id = uiId(registration);
    if (registeredKeys.has(key)) issues.push(`${key}: duplicate UI registration`);
    if (registeredIds.has(id)) issues.push(`${id}: duplicate UI capability ID`);
    registeredKeys.add(key);
    registeredIds.add(id);

    if (!safeAdminPagePath(registration.pagePath) ||
      !/^[a-z][a-z0-9-]{0,79}$/.test(registration.stableKey)) {
      issues.push(`${key}: unsafe UI registration identity`);
    }
    if (!(["typed-command", "browser-adapter", "secure-manual"] as const)
      .includes(registration.classification)) {
      issues.push(`${key}: unclassified UI affordance implementation`);
    }
    if (!getPagePermission(registration.pagePath)) {
      issues.push(`${key}: authenticated page permission is unmapped`);
    }
    if (registration.classification === "typed-command" && registration.capabilityIds.length === 0) {
      issues.push(`${key}: typed command has no capability`);
    }
    if (new Set(registration.capabilityIds).size !== registration.capabilityIds.length) {
      issues.push(`${key}: duplicate linked capability`);
    }
    for (const capabilityId of registration.capabilityIds) {
      if (!describeAdminCapability(capabilityId)) {
        issues.push(`${key}: unknown linked capability ${capabilityId}`);
      }
    }
  }

  for (const key of expectedKeys) {
    if (!registeredKeys.has(key)) issues.push(`${key}: unclassified UI affordance`);
  }
  for (const key of registeredKeys) {
    if (!expectedKeys.has(key)) issues.push(`${key}: UI registration missing from page-state inventory`);
  }
  return issues.sort();
}

export function registerAdminUiAffordances(
  expectations: readonly AdminUiAffordanceExpectation[],
  registrations: readonly AdminUiAffordanceRegistration[],
): readonly RegisteredAdminUiAffordance[] {
  const issues = auditAdminUiAffordanceRegistrations(expectations, registrations);
  if (issues.length > 0) {
    throw new Error(`Invalid Admin UI affordance registry:\n${issues.join("\n")}`);
  }

  return Object.freeze([...registrations]
    .sort((left, right) => affordanceIdentity(left).localeCompare(affordanceIdentity(right)))
    .map((registration) => Object.freeze({
      schemaVersion: 1 as const,
      id: uiId(registration),
      pagePath: registration.pagePath,
      stableKey: registration.stableKey,
      surface: "admin" as const,
      classification: registration.classification,
      authorization: normalizePageAuthorization(registration.pagePath),
      capabilityIds: Object.freeze([...registration.capabilityIds].sort()),
      risk: registrationRisk(registration),
    })));
}

export function adminUiAffordanceDriftKey(
  registrations: readonly AdminUiAffordanceRegistration[],
): string {
  return [...registrations]
    .sort((left, right) => affordanceIdentity(left).localeCompare(affordanceIdentity(right)))
    .map((registration) => [
      affordanceIdentity(registration),
      registration.classification,
      [...registration.capabilityIds].sort().join(","),
    ].join("|"))
    .join("\n");
}
