export const META_CONVERSIONS_WORKSPACE_SECTIONS = ["settings", "logs"] as const;

export type MetaConversionsWorkspaceSection =
  (typeof META_CONVERSIONS_WORKSPACE_SECTIONS)[number];

export function normalizeMetaConversionsWorkspaceSection(
  value: unknown,
): MetaConversionsWorkspaceSection {
  return typeof value === "string" &&
    META_CONVERSIONS_WORKSPACE_SECTIONS.includes(
      value as MetaConversionsWorkspaceSection,
    )
    ? (value as MetaConversionsWorkspaceSection)
    : "settings";
}
