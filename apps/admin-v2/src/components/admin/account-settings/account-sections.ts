export const ACCOUNT_SECTIONS = [
  "security",
  "password",
  "sessions",
  "team",
  "roles",
] as const;

export type AccountSection = (typeof ACCOUNT_SECTIONS)[number];

export function normalizeAccountSection(value: unknown): AccountSection {
  return ACCOUNT_SECTIONS.includes(value as AccountSection)
    ? (value as AccountSection)
    : "security";
}
