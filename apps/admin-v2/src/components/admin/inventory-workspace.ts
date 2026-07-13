export const INVENTORY_WORKSPACE_SECTIONS = [
  "variants",
  "alerts",
  "movements",
] as const;

export type InventoryWorkspaceSection =
  (typeof INVENTORY_WORKSPACE_SECTIONS)[number];

export function normalizeInventoryWorkspaceSection(
  value: unknown,
): InventoryWorkspaceSection {
  return typeof value === "string" &&
    INVENTORY_WORKSPACE_SECTIONS.includes(value as InventoryWorkspaceSection)
    ? (value as InventoryWorkspaceSection)
    : "variants";
}
