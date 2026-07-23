export const NOTIFICATION_SETTINGS_SECTIONS = ["rules", "push"] as const;

export type NotificationSettingsSection =
  (typeof NOTIFICATION_SETTINGS_SECTIONS)[number];

export const NOTIFICATION_RULE_PANELS = ["customers", "admins"] as const;

export type NotificationRulesPanel =
  (typeof NOTIFICATION_RULE_PANELS)[number];

export const DEFAULT_NOTIFICATION_RULES_PANEL: NotificationRulesPanel =
  "customers";

export const DEFAULT_NOTIFICATION_SETTINGS_SECTION: NotificationSettingsSection =
  "rules";

export function normalizeNotificationSettingsSection(
  value: unknown,
): NotificationSettingsSection {
  return typeof value === "string" &&
    NOTIFICATION_SETTINGS_SECTIONS.includes(
      value as NotificationSettingsSection,
    )
    ? (value as NotificationSettingsSection)
    : DEFAULT_NOTIFICATION_SETTINGS_SECTION;
}

export function normalizeNotificationRulesPanel(
  value: unknown,
): NotificationRulesPanel {
  return typeof value === "string" &&
    NOTIFICATION_RULE_PANELS.includes(value as NotificationRulesPanel)
    ? (value as NotificationRulesPanel)
    : DEFAULT_NOTIFICATION_RULES_PANEL;
}
