interface UpdateMediaSelectionOptions {
  selectedIds: readonly string[];
  visibleIds: readonly string[];
  targetId: string;
  anchorId: string | null;
  extendRange: boolean;
}

interface MediaSelectionUpdate {
  selectedIds: string[];
  anchorId: string;
}

/**
 * Applies the library's shared selection contract.
 *
 * A normal activation toggles one asset and establishes the range anchor.
 * Shift-activation adds the inclusive visible range without discarding any
 * individually selected assets. Hidden or stale IDs can never enter a range.
 */
export function updateMediaSelection({
  selectedIds,
  visibleIds,
  targetId,
  anchorId,
  extendRange,
}: UpdateMediaSelectionOptions): MediaSelectionUpdate {
  const targetIndex = visibleIds.indexOf(targetId);
  if (targetIndex === -1) {
    return { selectedIds: [...selectedIds], anchorId: targetId };
  }

  const anchorIndex = anchorId ? visibleIds.indexOf(anchorId) : -1;
  if (extendRange && anchorIndex !== -1) {
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const next = new Set(selectedIds);
    for (const id of visibleIds.slice(start, end + 1)) next.add(id);
    return { selectedIds: [...next], anchorId: anchorId as string };
  }

  const next = selectedIds.includes(targetId)
    ? selectedIds.filter((id) => id !== targetId)
    : [...selectedIds, targetId];

  return { selectedIds: next, anchorId: targetId };
}

export function selectAllVisibleMedia(visibleIds: readonly string[]): string[] {
  return [...new Set(visibleIds)];
}
