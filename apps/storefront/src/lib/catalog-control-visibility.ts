export function shouldShowCatalogControls({
  resultCount,
  activeFilterCount,
}: {
  resultCount: number;
  activeFilterCount: number;
}): boolean {
  return resultCount > 1 || activeFilterCount > 0;
}
