export const NOTIFICATION_SETTINGS_SECTIONS = ["rules", "push"] as const;

export type NotificationSettingsSection =
  (typeof NOTIFICATION_SETTINGS_SECTIONS)[number];

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
