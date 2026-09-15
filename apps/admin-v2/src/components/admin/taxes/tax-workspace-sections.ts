export const TAX_WORKSPACE_SECTIONS = [
  "policy",
  "classes",
  "rates",
  "classification",
  "preview",
] as const;

export type TaxWorkspaceSection =
  (typeof TAX_WORKSPACE_SECTIONS)[number];

export const DEFAULT_TAX_WORKSPACE_SECTION: TaxWorkspaceSection = "policy";

export function normalizeTaxWorkspaceSection(
  value: unknown,
): TaxWorkspaceSection {
  return typeof value === "string"
    && TAX_WORKSPACE_SECTIONS.includes(value as TaxWorkspaceSection)
    ? (value as TaxWorkspaceSection)
    : DEFAULT_TAX_WORKSPACE_SECTION;
}
