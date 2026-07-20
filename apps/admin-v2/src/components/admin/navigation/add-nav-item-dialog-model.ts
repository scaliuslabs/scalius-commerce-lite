export function getAddNavigationItemsLabel(selectedCount: number): string {
  return selectedCount > 1 ? `Add ${selectedCount} items` : "Add item";
}
